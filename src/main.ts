import { DEVICE_SETTINGS_KEY, resolveDeviceSettings, normalizeQueueFolder } from "./settings";
import { App, Notice, Platform, Plugin, PluginSettingTab, SecretComponent, Setting, TFile, TFolder, Vault } from "obsidian";
import { callProvider } from "./providers";
import { withProviderTimeout } from "./provider-timeout";
import { assertSchema } from "./schema";
import {
  AiGatewaySettingsSaveCoordinator,
  DEFAULT_SETTINGS,
  createMigratedSettingsPayload,
  planLegacyApiKeyMigration,
  reconcilePersistedSettings,
  sanitizeSettings,
} from "./settings";
import * as logger from "./logger";
import { parseRemoteAiJob, remoteAiJobIsClaimable, remoteAiJobIsExpired, remoteAiJobPath, REMOTE_AI_QUEUE_FOLDER, REMOTE_AI_WAIT_TIMEOUT_MS, type RemoteAiJob } from "./remote-queue";
import type { AiGatewaySettings, AiProviderId, CapabilityContext, CapabilityProposal, DecisionOption, DecisionResult, GatewayCapability, StructuredRequest, StructuredResult, TpsAiGatewayApi } from "./types";

const INLINE_MEDIA_MAX_ITEMS = 3;
const INLINE_MEDIA_MAX_BASE64_CHARACTERS = 16 * 1024 * 1024;
const INLINE_MEDIA_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const DURABLE_JOB_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{7,159}$/i;
const DURABLE_REMOTE_WORKER_BASE_DELAY_MS = 15_000;
const DURABLE_REMOTE_WORKER_JITTER_MS = 30_000;

export default class TpsAiGatewayPlugin extends Plugin {
  settings: AiGatewaySettings = DEFAULT_SETTINGS;
  api!: TpsAiGatewayApi;
  private capabilities = new Map<string, GatewayCapability>();
  private settingsPersistence: AiGatewaySettingsSaveCoordinator | null = null;
  private remoteQueueScanInFlight = false;
  private remoteQueueRescanRequested = false;
  private remoteQueueScanTimer: number | null = null;
  private remoteJobsInFlight = new Set<string>();

  async onload(): Promise<void> {
    await this.loadSettings();
    this.api = {
      features: { googleSearchGrounding: true, appleIntelligence: true },
      completeStructured: <T>(request: StructuredRequest) => this.completeStructured<T>(request),
      choose: <T>(request: Omit<StructuredRequest, "schema"> & { options: DecisionOption<T>[] }) => this.choose<T>(request),
      registerCapability: <TInput, TOutput>(capability: GatewayCapability<TInput, TOutput>) => this.registerCapability(capability as GatewayCapability),
      listCapabilities: () => this.listCapabilities(),
      proposeCapability: <TInput>(request: Omit<StructuredRequest, "schema"> & { capabilityIds: string[] }) => this.proposeCapability<TInput>(request),
      executeCapability: <TOutput>(proposal: CapabilityProposal, context: Omit<CapabilityContext, "traceId">) => this.executeCapability<TOutput>(proposal, context),
    };
    (this as any).api = this.api;
    (this.app as any).tpsAiGateway = this.api;
    this.addSettingTab(new AiGatewaySettingTab(this.app, this));
    this.addCommand({ id: "validate-provider-chain", name: "Validate provider chain", callback: () => void this.validateProviderChain() });
    this.registerEvent(this.app.vault.on("create", (file) => {
      if (this.getQueueFolders().some(folder => file.path.startsWith(`${folder}/`))) this.scheduleRemoteQueueScan("file-created");
    }));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (this.getQueueFolders().some(folder => file.path.startsWith(`${folder}/`))) this.scheduleRemoteQueueScan("file-modified");
    }));
    this.registerInterval(window.setInterval(() => this.scheduleRemoteQueueScan("interval"), 30_000));
    this.app.workspace.onLayoutReady(() => this.scheduleRemoteQueueScan("startup"));
    logger.flow("Plugin", "load", { providers: this.settings.providerOrder, ollamaEnabled: this.settings.ollamaEnabled });
  }

  onunload(): void {
    if (this.remoteQueueScanTimer !== null) window.clearTimeout(this.remoteQueueScanTimer);
    this.remoteQueueRescanRequested = false;
    if ((this.app as any).tpsAiGateway === this.api) delete (this.app as any).tpsAiGateway;
    this.capabilities.clear();
    delete (this as any).api;
  }

  private async completeStructured<T>(request: StructuredRequest): Promise<StructuredResult<T>> {
    if (!request.taskId.trim()) throw new Error("AI gateway taskId is required.");
    if (!request.messages.length) throw new Error("AI gateway messages are required.");
    validateInlineMedia(request);
    if (request.grounding && request.grounding !== "google-search") throw new Error("Unsupported AI grounding mode.");
    if (request.grounding && request.media?.length) throw new Error("Google Search grounding cannot be combined with inline images.");
    if (request.durableJobId) {
      if (request.media?.length) throw new Error("Durable AI requests cannot contain images.");
      if (!DURABLE_JOB_ID_PATTERN.test(request.durableJobId)) throw new Error("AI gateway durableJobId is invalid.");
      return this.completeStructuredDurably<T>(request);
    }
    const requested = request.preferredProviders?.length ? request.preferredProviders : this.settings.providerOrder;
    const providers = [...new Set([...requested, ...this.settings.providerOrder])]
      .filter((provider) => !(request.grounding || request.media?.length) || provider === "gemini");
    let attempts = 0;
    let lastError: unknown;
    for (const provider of providers) {
      if (provider === "apple" && !this.shouldUseTishOSAppleIntelligence({ ...request, preferredProviders: [provider] })) continue;
      if (provider === "ollama" && !this.settings.ollamaEnabled) continue;
      if (!this.isControllerDevice() && (provider === "openai" || provider === "gemini")
        && !this.deviceLocalCloudProviders({ ...request, preferredProviders: [provider] }).length) continue;
      attempts += 1;
      try {
        const result = provider === "apple"
          ? await this.completeStructuredWithTishOSAppleIntelligence<T>(request)
          : await this.completeStructuredLocally<T>({ ...request, preferredProviders: [provider] }, [provider]);
        return { ...result, attempts: attempts - 1 + (result.attempts || 1) };
      } catch (error) {
        // A queued handoff is still running; starting a backup could duplicate it.
        if ((error as any)?.code === "TPS_AI_JOB_PENDING") throw error;
        lastError = error;
        logger.warn("Request", "route-failed", { taskId: request.taskId, provider, reason: logger.errorSummary(error) });
      }
    }
    if (attempts) throw lastError;
    if (request.media?.length) throw new Error("Image requests require Gemini to be configured in TPS AI Gateway on this device.");
    if (!providers.length) throw new Error("Choose a primary AI provider in TPS AI Gateway.");
    return this.completeStructuredRemotely<T>(request);
  }

  private deviceLocalCloudProviders(request: StructuredRequest): AiProviderId[] {
    const requested = request.preferredProviders?.length ? request.preferredProviders : this.settings.providerOrder;
    if (request.grounding) {
      return requested.includes("gemini") && this.readSecret(this.settings.geminiApiKeySecret) ? ["gemini"] : [];
    }
    if (request.media?.length) {
      return requested.includes("gemini") && this.readSecret(this.settings.geminiApiKeySecret) ? ["gemini"] : [];
    }
    return requested.filter((provider) => (provider === "openai" && Boolean(this.readSecret(this.settings.openAiApiKeySecret)))
      || (provider === "gemini" && Boolean(this.readSecret(this.settings.geminiApiKeySecret))));
  }

  private shouldUseTishOSAppleIntelligence(request: StructuredRequest): boolean {
    if (!Platform.isIosApp || !this.settings.appleIntelligenceEnabled) return false;
    if (request.media?.length || request.grounding) return false;
    const requested = request.preferredProviders?.length
      ? request.preferredProviders
      : this.settings.providerOrder;
    return requested.find((provider) => provider !== "ollama" || this.settings.ollamaEnabled) === "apple";
  }

  private async completeStructuredWithTishOSAppleIntelligence<T>(request: StructuredRequest): Promise<StructuredResult<T>> {
    const jobId = makeTraceId(request.taskId);
    const now = new Date().toISOString();
    const job: RemoteAiJob = {
      version: 1,
      id: jobId,
      taskId: request.taskId,
      requesterDeviceId: this.getDeviceId(),
      createdAt: now,
      updatedAt: now,
      status: "pending",
      durable: false,
      executionTarget: "tishos-apple",
      messages: request.messages,
      schema: request.schema,
      preferredProviders: ["apple"],
      metadata: request.metadata,
    };
    const file = await this.createRemoteJob(job);
    const target = tishOSAppleIntelligenceURL(jobId, file.path.slice(0, file.path.lastIndexOf("/")));
    logger.flow("AppleIntelligence", "handoff", {
      jobId,
      taskId: request.taskId,
      path: file.path,
    });
    window.open(target, "_self");
    const result = await this.waitForRemoteJob<T>(file.path, request.schema);
    this.app.workspace.trigger("tps:ai-remote-job-completed" as any, {
      sourcePluginId: this.manifest.id,
      timestamp: Date.now(),
      jobId,
      taskId: request.taskId,
    });
    return result;
  }

  private async completeStructuredLocally<T>(request: StructuredRequest, exactProviders?: AiProviderId[]): Promise<StructuredResult<T>> {
    const traceId = makeTraceId(request.taskId);
    const requested = request.grounding
      ? ["gemini" as const]
      : request.preferredProviders?.length ? request.preferredProviders : this.settings.providerOrder;
    const providers = exactProviders?.length
      ? [...new Set(exactProviders)]
      : request.grounding ? ["gemini" as const] : [...new Set([...requested, ...this.settings.providerOrder])];
    const callableProviders = providers.filter((provider) => provider !== "apple");
    const failures: string[] = [];
    let attempts = 0;
    const credentials = {
      openAiApiKey: this.readSecret(this.settings.openAiApiKeySecret),
      geminiApiKey: this.readSecret(this.settings.geminiApiKeySecret),
    };
    logger.flow("Request", "start", {
      traceId,
      taskId: request.taskId,
      providers: callableProviders,
      messageCount: request.messages.length,
      grounded: Boolean(request.grounding),
      ...logger.metadataSummary(request.metadata),
    });
    for (const provider of callableProviders) {
      attempts += 1;
      try {
        const response = await withProviderTimeout(
          provider,
          callProvider(provider, this.settings, credentials, request.messages, request.schema, request.media, request.grounding),
        );
        if (!response.text) throw new Error("Provider returned no structured result.");
        const data = JSON.parse(response.text) as T;
        assertSchema(data, request.schema);
        logger.flow("Request", "success", { traceId, taskId: request.taskId, provider, model: response.model, attempts });
        return { data, provider, model: response.model, traceId, attempts, sources: response.sources };
      } catch (error) {
        const summary = logger.errorSummary(error, [credentials.openAiApiKey, credentials.geminiApiKey]);
        failures.push(`${provider}: ${summary}`);
        logger.warn("Request", "provider-failed", { traceId, taskId: request.taskId, provider, reason: summary });
      }
    }
    throw new Error(`TPS AI Gateway could not complete ${request.taskId}. ${failures.join("; ")}`);
  }

  private async completeStructuredRemotely<T>(request: StructuredRequest): Promise<StructuredResult<T>> {
    const jobId = makeTraceId(request.taskId);
    const now = new Date().toISOString();
    const job: RemoteAiJob = {
      version: 1,
      id: jobId,
      taskId: request.taskId,
      requesterDeviceId: this.getDeviceId(),
      createdAt: now,
      updatedAt: now,
      status: "pending",
      durable: true,
      messages: request.messages,
      schema: request.schema,
      grounding: request.grounding,
      preferredProviders: request.preferredProviders,
      metadata: request.metadata,
    };
    const file = await this.createRemoteJob(job);
    logger.flow("RemoteQueue", "submitted", { jobId, taskId: request.taskId, path: file.path });
    new Notice("Sent to the synced AI queue. Another AI-enabled device can finish it.", 7000);
    const result = await this.waitForRemoteJob<T>(file.path, request.schema);
    this.app.workspace.trigger("tps:ai-remote-job-completed" as any, { sourcePluginId: this.manifest.id, timestamp: Date.now(), jobId, taskId: request.taskId });
    return result;
  }

  private async completeStructuredDurably<T>(request: StructuredRequest): Promise<StructuredResult<T>> {
    const jobId = request.durableJobId!;
    const existingPath = this.findRemoteJobPath(jobId);
    const path = existingPath || remoteAiJobPath(jobId, this.settings?.remoteQueueFolder);
    const usesTishOSAppleIntelligence = this.shouldUseTishOSAppleIntelligence(request);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      const job = parseRemoteAiJob(await this.app.vault.read(existing));
      if (!job || !remoteJobMatchesRequest(job, request)) throw new Error("AI durable job id belongs to a different request.");
      if (job.status === "complete" && job.result) {
        assertSchema(job.result.data, request.schema);
        logger.flow("RemoteQueue", "durable-resumed", { jobId, taskId: request.taskId, provider: job.result.provider, model: job.result.model });
        return job.result as StructuredResult<T>;
      }
      if (job.status === "failed") throw new Error(job.error || "The durable AI request failed.");
      if (job.executionTarget === "tishos-apple"
        && Platform.isIosApp
        && this.settings.appleIntelligenceEnabled
        && remoteAiJobIsClaimable(job)) {
        window.open(tishOSAppleIntelligenceURL(job.id, path.slice(0, path.lastIndexOf("/"))), "_self");
        return this.waitForRemoteJob<T>(path, request.schema);
      }
      if (remoteAiJobIsClaimable(job) && this.canProcessRemoteJob(job)) {
        logger.flow("RemoteQueue", "durable-immediate", { jobId, taskId: request.taskId, route: "resume" });
        await this.processRemoteJob(existing, job);
        return this.waitForRemoteJob<T>(path, request.schema);
      }
      this.scheduleRemoteQueueScan("durable-resume");
      return this.waitForRemoteJob<T>(path, request.schema);
    }
    const now = new Date().toISOString();
    const job: RemoteAiJob = {
      version: 1,
      id: jobId,
      taskId: request.taskId,
      requesterDeviceId: this.getDeviceId(),
      createdAt: now,
      updatedAt: now,
      status: "pending",
      durable: true,
      executionTarget: usesTishOSAppleIntelligence ? "tishos-apple" : undefined,
      messages: request.messages,
      schema: request.schema,
      grounding: request.grounding,
      preferredProviders: usesTishOSAppleIntelligence ? ["apple"] : request.preferredProviders,
      metadata: request.metadata,
    };
    const file = await this.createRemoteJob(job);
    logger.flow("RemoteQueue", "durable-submitted", { jobId, taskId: request.taskId, path: file.path });
    if (usesTishOSAppleIntelligence) {
      window.open(tishOSAppleIntelligenceURL(jobId, file.path.slice(0, file.path.lastIndexOf("/"))), "_self");
      return this.waitForRemoteJob<T>(path, request.schema);
    }
    if (this.canProcessRemoteJob(job)) {
      logger.flow("RemoteQueue", "durable-immediate", { jobId, taskId: request.taskId, route: "submitted" });
      await this.processRemoteJob(file, job);
      return this.waitForRemoteJob<T>(path, request.schema);
    }
    this.scheduleRemoteQueueScan("durable-submitted");
    new Notice("Saved this AI request. Another online device can finish it if needed.", 7000);
    return this.waitForRemoteJob<T>(file.path, request.schema);
  }

  private async createRemoteJob(job: RemoteAiJob): Promise<TFile> {
    const folder = this.settings?.remoteQueueFolder || REMOTE_AI_QUEUE_FOLDER;
    await this.ensureRemoteQueueFolder(folder);
    const path = remoteAiJobPath(job.id, folder);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) throw new Error("AI queue job id already exists.");
    return this.app.vault.create(path, JSON.stringify(job, null, 2));
  }

  private async waitForRemoteJob<T>(path: string, schema: Record<string, unknown>): Promise<StructuredResult<T>> {
    const deadline = Date.now() + REMOTE_AI_WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        const job = parseRemoteAiJob(await this.app.vault.read(file));
        if (job?.status === "complete" && job.result) {
          assertSchema(job.result.data, schema);
          logger.flow("RemoteQueue", "received", { jobId: job.id, taskId: job.taskId, provider: job.result.provider, model: job.result.model });
          return job.result as StructuredResult<T>;
        }
        if (job?.status === "failed") throw new Error(job.error || "The Controller could not complete the AI request.");
      }
      await delay(3000);
    }
    const error = new Error("The AI request is still queued. TPS Health will resume it automatically.");
    (error as any).code = "TPS_AI_JOB_PENDING";
    throw error;
  }

  private scheduleRemoteQueueScan(reason: string): void {
    if (!this.canProcessRemoteQueue() || this.remoteQueueScanTimer !== null) return;
    this.remoteQueueScanTimer = window.setTimeout(() => {
      this.remoteQueueScanTimer = null;
      void this.scanRemoteQueue(reason);
    }, 750);
  }

  getQueueFolders(): string[] {
    return [...new Set([this.settings?.remoteQueueFolder || REMOTE_AI_QUEUE_FOLDER, ...(this.settings?.previousQueueFolders || [])])];
  }

  async setRequestFolder(value: string): Promise<void> {
    const folder = normalizeQueueFolder(value);
    const current = this.settings?.remoteQueueFolder || REMOTE_AI_QUEUE_FOLDER;
    if (folder === current) return;
    const collision = this.app.vault.getAbstractFileByPath(folder);
    if (collision && !(collision instanceof TFolder)) throw new Error("The AI request location is a file. Choose a folder.");
    const previous = this.settings.previousQueueFolders;
    this.settings.previousQueueFolders = [...new Set([...(this.settings?.previousQueueFolders || []), current])].filter(path => path !== folder);
    this.settings.remoteQueueFolder = folder;
    try { await this.saveSettings(); }
    catch (error) {
      if (this.settings.remoteQueueFolder === folder) {
        this.settings.remoteQueueFolder = current;
        this.settings.previousQueueFolders = previous;
      }
      throw error;
    }
    logger.flow("RemoteQueue", "folder-changed", { previousLocations: this.settings.previousQueueFolders.length });
  }

  private findRemoteJobPath(id: string): string | undefined {
    const matches = this.getQueueFolders().map(folder => remoteAiJobPath(id, folder))
      .filter(path => this.app.vault.getAbstractFileByPath(path) instanceof TFile);
    if (matches.length > 1) throw new Error("This AI request exists in more than one queue folder. Resolve the duplicate before resuming.");
    return matches[0];
  }

  private getRemoteQueueMarkdownFiles(): TFile[] {
    const files = new Map<string, TFile>();
    for (const path of this.getQueueFolders()) {
      const folder = this.app.vault.getFolderByPath(path);
      if (!folder) continue;
      Vault.recurseChildren(folder, file => { if (file instanceof TFile && file.extension === "md") files.set(file.path, file); });
    }
    return [...files.values()];
  }

  private async scanRemoteQueue(reason: string): Promise<void> {
    if (!this.canProcessRemoteQueue()) return;
    if (this.remoteQueueScanInFlight) {
      this.remoteQueueRescanRequested = true;
      return;
    }
    this.remoteQueueScanInFlight = true;
    try {
      for (let pass = 0; pass < 2; pass += 1) {
        if (pass > 0 && (!this.remoteQueueRescanRequested || !this.canProcessRemoteQueue())) break;
        this.remoteQueueRescanRequested = false;
        try {
          const files = this.getRemoteQueueMarkdownFiles();
          logger.flow("RemoteQueue", "scan", { reason, files: files.length });
          for (const file of files) {
            try {
              const job = parseRemoteAiJob(await this.app.vault.read(file));
              if (!job) {
                logger.warn("RemoteQueue", "invalid-job", { path: file.path });
                continue;
              }
              if (remoteAiJobIsExpired(job)) {
                await this.app.vault.delete(file);
                logger.flow("RemoteQueue", "expired", { jobId: job.id, taskId: job.taskId });
                continue;
              }
              if (remoteAiJobIsClaimable(job) && this.canProcessRemoteJob(job)) await this.processRemoteJob(file, job);
            } catch (error) {
              logger.warn("RemoteQueue", "file-scan-failed", { reason, path: file.path, error: logger.errorSummary(error) });
            }
          }
        } catch (error) {
          logger.warn("RemoteQueue", "scan-failed", { reason, error: logger.errorSummary(error) });
        }
        reason = "queued";
      }
    } finally {
      const scheduleFollowUp = this.remoteQueueRescanRequested && this.canProcessRemoteQueue();
      this.remoteQueueRescanRequested = false;
      this.remoteQueueScanInFlight = false;
      if (scheduleFollowUp) this.scheduleRemoteQueueScan("queued-after-trailing");
    }
  }

  private async processRemoteJob(file: TFile, job: RemoteAiJob): Promise<void> {
    const inFlight = this.remoteJobsInFlight || (this.remoteJobsInFlight = new Set<string>());
    if (inFlight.has(file.path)) return;
    inFlight.add(file.path);
    try {
      const localProviders = this.remoteJobLocalProviders(job);
      if (!this.isControllerDevice() && !localProviders.length) return;
      const startedAt = new Date().toISOString();
      const claimed: RemoteAiJob = { ...job, status: "processing", controllerDeviceId: this.getDeviceId(), startedAt, updatedAt: startedAt, error: undefined };
      await this.app.vault.modify(file, JSON.stringify(claimed, null, 2));
      logger.flow("RemoteQueue", "claimed", { jobId: job.id, taskId: job.taskId });
      try {
        const request = { taskId: job.taskId, messages: job.messages, schema: job.schema, grounding: job.grounding, preferredProviders: job.preferredProviders, metadata: job.metadata };
        const result = await this.completeStructuredLocally(request, this.isControllerDevice() ? undefined : localProviders);
        const completed: RemoteAiJob = { ...claimed, status: "complete", updatedAt: new Date().toISOString(), result };
        await this.app.vault.modify(file, JSON.stringify(completed, null, 2));
        logger.flow("RemoteQueue", "completed", { jobId: job.id, taskId: job.taskId, provider: result.provider, model: result.model });
        await this.notifyRemoteJob(job, true);
      } catch (error) {
        const message = logger.errorSummary(error, [this.readSecret(this.settings.openAiApiKeySecret), this.readSecret(this.settings.geminiApiKeySecret)]);
        const failed: RemoteAiJob = { ...claimed, status: "failed", updatedAt: new Date().toISOString(), error: message };
        await this.app.vault.modify(file, JSON.stringify(failed, null, 2));
        logger.warn("RemoteQueue", "failed", { jobId: job.id, taskId: job.taskId, error: message });
        await this.notifyRemoteJob(job, false);
      }
    } finally {
      inFlight.delete(file.path);
    }
  }

  private async notifyRemoteJob(job: RemoteAiJob, succeeded: boolean): Promise<void> {
    if (job.metadata?.notifyOnCompletion === false) {
      logger.flow("RemoteQueue", "notification-skipped", { jobId: job.id, taskId: job.taskId });
      return;
    }
    const plugin = (this.app as any).plugins?.getPlugin?.("tps-messager") || (this.app as any).plugins?.getPlugin?.("tps-notifier");
    const notifier = plugin?.api || plugin;
    const label = typeof job.metadata?.notificationTitle === "string" && job.metadata.notificationTitle.trim()
      ? job.metadata.notificationTitle.trim().slice(0, 80)
      : "TPS AI request";
    const title = succeeded ? `${label} complete` : `${label} failed`;
    const body = succeeded
      ? `${label} finished on an AI-enabled device. Open Obsidian on the requesting device to continue.`
      : `${label} could not be completed by an AI-enabled device.`;
    try {
      if (notifier?.sendNotification) await notifier.sendNotification(title, body);
      else if (notifier?.sendMessage) await notifier.sendMessage(body, undefined, title);
      else logger.warn("RemoteQueue", "notification-unavailable", { jobId: job.id, taskId: job.taskId });
    } catch (error) {
      logger.warn("RemoteQueue", "notification-failed", { jobId: job.id, taskId: job.taskId, error: logger.errorSummary(error) });
    }
  }

  private isControllerDevice(): boolean {
    const controller = (this.app as any).plugins?.getPlugin?.("tps-controller");
    return controller?.api?.isController?.() === true;
  }

  private canProcessRemoteQueue(): boolean {
    return this.isControllerDevice()
      || Boolean(this.readSecret(this.settings.openAiApiKeySecret))
      || Boolean(this.readSecret(this.settings.geminiApiKeySecret));
  }

  private remoteJobLocalProviders(job: RemoteAiJob): AiProviderId[] {
    return this.deviceLocalCloudProviders({
      taskId: job.taskId,
      messages: job.messages,
      schema: job.schema,
      grounding: job.grounding,
      preferredProviders: job.preferredProviders,
      metadata: job.metadata,
    });
  }

  private canProcessRemoteJob(job: RemoteAiJob): boolean {
    if (job.executionTarget === "tishos-apple") return false;
    if (!this.isControllerDevice() && !this.remoteJobLocalProviders(job).length) return false;
    if (!job.durable || job.requesterDeviceId === this.getDeviceId()) return true;
    const createdAt = Date.parse(job.createdAt);
    if (!Number.isFinite(createdAt)) return false;
    const delayMs = DURABLE_REMOTE_WORKER_BASE_DELAY_MS + stableDeviceDelay(this.getDeviceId(), DURABLE_REMOTE_WORKER_JITTER_MS);
    return Date.now() - createdAt >= delayMs;
  }

  private getDeviceId(): string {
    const key = `tps-ai-gateway-device-id-${this.app.vault.getName()}`;
    const existing = window.localStorage.getItem(key);
    if (existing) return existing;
    const created = `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    window.localStorage.setItem(key, created);
    return created;
  }

  private async ensureRemoteQueueFolder(folder = this.settings?.remoteQueueFolder || REMOTE_AI_QUEUE_FOLDER): Promise<void> {
    let path = "";
    for (const segment of folder.split("/")) {
      path = path ? `${path}/${segment}` : segment;
      if (!this.app.vault.getAbstractFileByPath(path)) await this.app.vault.createFolder(path);
    }
  }

  private async choose<T>(request: Omit<StructuredRequest, "schema"> & { options: DecisionOption<T>[] }): Promise<DecisionResult<T>> {
    if (!request.options.length) throw new Error("At least one decision option is required.");
    const optionIds = request.options.map((option) => option.id);
    if (new Set(optionIds).size !== optionIds.length || optionIds.some((id) => !id.trim())) throw new Error("Decision option IDs must be unique and non-empty.");
    const schema = { type: "object", additionalProperties: false, required: ["optionId", "reason"], properties: { optionId: { type: "string", enum: optionIds }, reason: { type: "string" } } };
    const messages = [...request.messages, { role: "user" as const, content: `Select exactly one registered option. Options:\n${request.options.map((option) => `${option.id}: ${option.label}${option.description ? ` — ${option.description}` : ""}`).join("\n")}` }];
    const result = await this.completeStructured<{ optionId: string; reason: string }>({ ...request, messages, schema });
    const option = request.options.find((candidate) => candidate.id === result.data.optionId);
    if (!option) throw new Error("AI selected an unavailable option.");
    return { ...result, option };
  }

  private registerCapability(capability: GatewayCapability): () => void {
    if (!capability.id.trim() || !capability.ownerPluginId.trim()) throw new Error("Capability id and ownerPluginId are required.");
    if (this.capabilities.has(capability.id)) throw new Error(`Capability already registered: ${capability.id}`);
    this.capabilities.set(capability.id, capability);
    logger.flow("Capability", "registered", { id: capability.id, owner: capability.ownerPluginId, requiresConfirmation: capability.requiresConfirmation !== false });
    return () => { if (this.capabilities.get(capability.id) === capability) this.capabilities.delete(capability.id); };
  }

  private listCapabilities() {
    return [...this.capabilities.values()].map(({ id, ownerPluginId, description, inputSchema, requiresConfirmation }) => ({ id, ownerPluginId, description, inputSchema, requiresConfirmation }));
  }

  private async proposeCapability<TInput>(request: Omit<StructuredRequest, "schema"> & { capabilityIds: string[] }): Promise<CapabilityProposal<TInput>> {
    const capabilities = request.capabilityIds.map((id) => this.capabilities.get(id));
    if (capabilities.some((capability) => !capability)) throw new Error("Proposal included an unregistered capability.");
    const options = capabilities.map((capability) => ({ id: capability!.id, label: capability!.id, description: capability!.description }));
    const decision = await this.choose({ ...request, options });
    const selected = this.capabilities.get(decision.option.id)!;
    const inputResult = await this.completeStructured<TInput>({ taskId: `${request.taskId}:input`, messages: [...request.messages, { role: "user", content: `Prepare input only for capability ${selected.id}: ${selected.description}` }], schema: selected.inputSchema, preferredProviders: request.preferredProviders, metadata: request.metadata });
    return { capabilityId: selected.id, input: inputResult.data, reason: decision.data.reason, traceId: decision.traceId };
  }

  private async executeCapability<TOutput>(proposal: CapabilityProposal, context: Omit<CapabilityContext, "traceId">): Promise<TOutput> {
    const capability = this.capabilities.get(proposal.capabilityId);
    if (!capability) throw new Error(`Capability is not registered: ${proposal.capabilityId}`);
    if (capability.requiresConfirmation !== false && !context.confirmed) throw new Error(`Capability requires confirmation: ${proposal.capabilityId}`);
    assertSchema(proposal.input, capability.inputSchema);
    logger.flow("Capability", "execute", { traceId: proposal.traceId, id: proposal.capabilityId, owner: capability.ownerPluginId, source: context.sourcePluginId, confirmed: context.confirmed });
    return await capability.execute(proposal.input, { ...context, traceId: proposal.traceId }) as TOutput;
  }

  async loadSettings(): Promise<void> {
    const raw = await this.loadData();
    this.settings = resolveDeviceSettings(this.app.loadLocalStorage(DEVICE_SETTINGS_KEY), raw);
    logger.setLogging(this.settings.enableLogging);
    const migration = planLegacyApiKeyMigration(raw, this.settings, (name) => this.app.secretStorage.getSecret(name));
    for (const write of migration.writes) this.app.secretStorage.setSecret(write.secretName, write.value);
    if (migration.shouldPersist) {
      const migrated = createMigratedSettingsPayload(raw, sanitizeSettings(raw));
      await this.saveData(migrated);
      // Retain the device snapshot; legacy shared data only supplies first-run defaults.
    }
    this.app.saveLocalStorage(DEVICE_SETTINGS_KEY, this.settings);
    this.settingsPersistence = new AiGatewaySettingsSaveCoordinator({
      loadLatest: async () => this.app.loadLocalStorage(DEVICE_SETTINGS_KEY),
      saveMerged: async (value) => { this.app.saveLocalStorage(DEVICE_SETTINGS_KEY, value); },
      onPersisted: (requested, persisted) => reconcilePersistedSettings(this.settings, requested, persisted),
    }, this.settings);
    if (migration.writes.length) logger.flow("Settings", "legacy-api-keys-migrated", { providers: migration.writes.map((write) => write.provider) });
  }
  async saveSettings(): Promise<void> {
    this.settings = sanitizeSettings(this.settings);
    logger.setLogging(this.settings.enableLogging);
    const snapshot = sanitizeSettings(this.settings);
    if (!this.settingsPersistence) throw new Error("AI gateway settings were not loaded.");
    await this.settingsPersistence.request(snapshot);
  }

  private async validateProviderChain(): Promise<void> {
    try {
      const result = await this.completeStructured<{ ok: boolean }>({ taskId: "gateway-diagnostic", messages: [{ role: "system", content: "Return the requested diagnostic value." }, { role: "user", content: "Return ok as true." }], schema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } } });
      new Notice(`TPS AI Gateway reached ${result.provider} (${result.model}).`);
    } catch (error) { new Notice(logger.errorSummary(error)); }
  }

  private readSecret(name: string): string {
    return name ? String(this.app.secretStorage.getSecret(name) || "").trim() : "";
  }
}

export function validateInlineMedia(request: StructuredRequest): void {
  const media = request.media || [];
  if (media.length > INLINE_MEDIA_MAX_ITEMS) throw new Error(`TPS AI Gateway accepts at most ${INLINE_MEDIA_MAX_ITEMS} inline images.`);
  let totalCharacters = 0;
  for (const item of media) {
    if (!INLINE_MEDIA_MIME_TYPES.has(item.mimeType)) throw new Error(`Unsupported inline image type: ${item.mimeType || "unknown"}.`);
    if (!item.data || !/^[A-Za-z0-9+/]+={0,2}$/.test(item.data)) throw new Error("Inline image data must be base64 without a data URL prefix.");
    totalCharacters += item.data.length;
  }
  if (totalCharacters > INLINE_MEDIA_MAX_BASE64_CHARACTERS) throw new Error("Inline images are too large. Capture smaller photos and try again.");
}

function remoteJobMatchesRequest(job: RemoteAiJob, request: StructuredRequest): boolean {
  const providerSelectionMatches = job.executionTarget === "tishos-apple"
    ? job.preferredProviders?.length === 1
      && job.preferredProviders[0] === "apple"
      && (!request.preferredProviders?.length || request.preferredProviders.includes("apple"))
    : JSON.stringify(job.preferredProviders || []) === JSON.stringify(request.preferredProviders || []);
  return job.durable === true
    && job.id === request.durableJobId
    && job.taskId === request.taskId
    && JSON.stringify(job.messages) === JSON.stringify(request.messages)
    && JSON.stringify(job.schema) === JSON.stringify(request.schema)
    && job.grounding === request.grounding
    && providerSelectionMatches
    && JSON.stringify(job.metadata || {}) === JSON.stringify(request.metadata || {});
}

export class AiGatewaySettingTab extends PluginSettingTab {
  private backupEditor: AiProviderId | null = null;

  constructor(app: App, private plugin: TpsAiGatewayPlugin) { super(app, plugin); }

  display(): void { this.renderSettings(); }

  private async selectPrimary(provider: AiProviderId): Promise<void> {
    this.plugin.settings.providerOrder = [provider, ...this.plugin.settings.providerOrder.slice(1).filter((item) => item !== provider)];
    await this.plugin.saveSettings();
    this.renderSettings("primary");
  }

  private renderSettings(focus?: string): void {
    const { containerEl } = this;
    const scrollTop = containerEl.scrollTop;
    containerEl.empty();
    containerEl.addClass("tps-ai-settings-page");
    containerEl.createEl("h2", { text: "AI configuration" });
    const primary = this.plugin.settings.providerOrder[0];
    const mode = providerMode(primary);
    const primarySetting = new Setting(containerEl).setName("Primary AI · This device").setDesc("Choose where ordinary AI requests run first.");
    const modes = primarySetting.controlEl.createDiv({ cls: "tps-ai-settings-modes", attr: { role: "group", "aria-label": "Primary AI" } });
    for (const option of AI_MODES) {
      const button = modes.createEl("button", { text: option.title, cls: "tps-ai-settings-mode", attr: {
        type: "button", "aria-pressed": String(mode === option.id), "data-ai-focus": mode === option.id ? "primary" : option.id,
      } });
      button.addEventListener("click", () => {
        if (mode === option.id) return;
        const provider = option.id === "cloud"
          ? this.plugin.settings.providerOrder.find((item) => providerMode(item) === "cloud") ?? "gemini"
          : option.id === "device" ? "ollama" : "apple";
        void this.selectPrimary(provider);
      });
    }
    if (!primary) containerEl.createEl("p", { text: "No primary provider is selected. Choose an AI mode above." });
    if (mode === "cloud") {
      new Setting(containerEl).setName("Cloud provider").addDropdown((dropdown) => dropdown
        .addOption("gemini", "Google AI").addOption("openai", "OpenAI").setValue(primary)
        .onChange((value) => { void this.selectPrimary(value as AiProviderId); }));
    }
    if (primary) this.renderProvider(containerEl.createDiv({ cls: "tps-ai-settings-provider" }), primary);

    const backups = this.plugin.settings.providerOrder.slice(1);
    const backupSetting = new Setting(containerEl).setName("Backup AI · This device")
      .setDesc("Try this provider if an ordinary request fails. Choosing a backup replaces the existing backup chain.");
    backupSetting.addDropdown((dropdown) => {
      dropdown.selectEl.setAttribute("aria-label", "Backup AI");
      dropdown.selectEl.setAttribute("data-ai-focus", "backup");
      dropdown.addOption("none", "None");
      if (backups.length > 1) dropdown.addOption("existing", `Keep existing backups (${backups.length})`);
      for (const provider of AI_PROVIDERS) if (provider !== primary) dropdown.addOption(provider, providerLabel(provider));
      dropdown.setValue(backups.length > 1 ? "existing" : backups[0] ?? "none");
      dropdown.setDisabled(!primary);
      dropdown.onChange(async (value) => {
        if (value === "existing") return;
        this.plugin.settings.providerOrder = [primary, ...(value === "none" ? [] : [value as AiProviderId])];
        await this.plugin.saveSettings();
        this.renderSettings("backup");
      });
    });
    if (backups.length > 1) containerEl.createEl("p", { cls: "tps-ai-settings-note", text: `Backup order: ${backups.map(providerLabel).join(" → ")}` });
    if (backups.length) {
      if (!this.backupEditor || !backups.includes(this.backupEditor)) this.backupEditor = backups[0];
      if (backups.length > 1) new Setting(containerEl).setName("Configure existing backup").addDropdown((dropdown) => {
        dropdown.selectEl.setAttribute("aria-label", "Configure existing backup");
        dropdown.selectEl.setAttribute("data-ai-focus", "backup-editor");
        for (const provider of backups) dropdown.addOption(provider, providerLabel(provider));
        dropdown.setValue(this.backupEditor!).onChange((value) => {
          this.backupEditor = value as AiProviderId;
          this.renderSettings("backup-editor");
        });
      });
      this.renderProvider(containerEl.createDiv({ cls: "tps-ai-settings-provider" }), this.backupEditor);
    }
    containerEl.createEl("p", { cls: "tps-ai-settings-note", text: "Backups apply to ordinary requests. Durable jobs keep their TishOS or synced-queue route. Provider-specific requests may require a different provider." });
    let queueFolder = this.plugin.settings.remoteQueueFolder || REMOTE_AI_QUEUE_FOLDER;
    new Setting(containerEl).setName("Request files folder · This device")
      .setDesc("Use the same folder on every AI device. Existing requests finish in their original folder.")
      .addText(text => text.setValue(queueFolder).setPlaceholder("_system/TPS AI Queue").onChange(value => { queueFolder = value; }))
      .addButton(button => button.setButtonText("Apply folder").onClick(async () => {
        button.setDisabled(true);
        try { await this.plugin.setRequestFolder(queueFolder); new Notice("AI request folder updated."); }
        catch (error) { new Notice(String(error)); }
        finally { button.setDisabled(false); }
      }));
    const diagnostics = containerEl.createEl("details", { cls: "tps-ai-settings-diagnostics" });
    diagnostics.createEl("summary", { text: "Diagnostics" });
    new Setting(diagnostics).setName("Enable logging · This device").setDesc("Log routing without prompts, responses, metadata values, or secrets.")
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.enableLogging).onChange(async (value) => {
        this.plugin.settings.enableLogging = value;
        await this.plugin.saveSettings();
      }));
    if (focus) {
      containerEl.scrollTop = scrollTop;
      containerEl.querySelector<HTMLElement>(`[data-ai-focus="${focus}"]`)?.focus({ preventScroll: true });
    }
  }

  private renderProvider(container: HTMLElement, provider: AiProviderId): void {
    if (provider === "openai") {
      secretReferenceSetting(container, this.plugin, "OpenAI API key", "Choose a device-local Obsidian secret. API billing is separate from ChatGPT subscriptions.", "openAiApiKeySecret");
      textSetting(container, this.plugin, "OpenAI model", "Structured-output model ID.", "openAiModel");
    } else if (provider === "gemini") {
      secretReferenceSetting(container, this.plugin, "Google AI API key", "Choose a device-local Obsidian secret for hosted Gemini or Gemma.", "geminiApiKeySecret");
      textSetting(container, this.plugin, "Google AI model", "Hosted Gemini or Gemma model ID.", "geminiModel");
    } else if (provider === "ollama") {
      new Setting(container).setName("Use local Ollama · This device").setDesc("Run through Ollama on this device or a secured endpoint.")
        .addToggle((toggle) => toggle.setValue(this.plugin.settings.ollamaEnabled).onChange(async (value) => {
          this.plugin.settings.ollamaEnabled = value; await this.plugin.saveSettings();
        }));
      textSetting(container, this.plugin, "Ollama URL", "Loopback requires Ollama on this device; mobile needs a reachable secured endpoint.", "ollamaUrl");
      textSetting(container, this.plugin, "Ollama model", "Local structured-output model.", "ollamaModel");
    } else {
      new Setting(container).setName("Use TishOS Apple Intelligence · This device")
        .setDesc("TishOS handles text requests on iPhone/iPad using Apple Private Cloud Compute when eligible, otherwise on-device AI.")
        .addToggle((toggle) => toggle.setValue(this.plugin.settings.appleIntelligenceEnabled).onChange(async (value) => {
          this.plugin.settings.appleIntelligenceEnabled = value; await this.plugin.saveSettings();
        }));
    }
  }
}

const AI_MODES = [
  { id: "cloud", title: "Cloud" },
  { id: "device", title: "On device" },
  { id: "tps", title: "TPS routed" },
] as const;
const AI_PROVIDERS: AiProviderId[] = ["gemini", "openai", "ollama", "apple"];
function providerMode(provider?: AiProviderId): string {
  return provider === "apple" ? "tps" : provider === "ollama" ? "device" : provider ? "cloud" : "";
}
function providerLabel(provider: AiProviderId): string {
  return { gemini: "Cloud · Google AI", openai: "Cloud · OpenAI", ollama: "On device · Ollama", apple: "TPS routed · Apple Intelligence" }[provider];
}

type TextSettingKey = "ollamaUrl" | "ollamaModel" | "openAiModel" | "geminiModel";
function textSetting(container: HTMLElement, plugin: TpsAiGatewayPlugin, name: string, description: string, key: TextSettingKey): void { new Setting(container).setName(`${name} · This device`).setDesc(description).addText((text) => text.setValue(plugin.settings[key]).onChange(async (value) => { plugin.settings[key] = value.trim(); await plugin.saveSettings(); })); }
function secretReferenceSetting(container: HTMLElement, plugin: TpsAiGatewayPlugin, name: string, description: string, key: "openAiApiKeySecret" | "geminiApiKeySecret"): void {
  new Setting(container).setName(`${name} · This device`).setDesc(description).addComponent((element) => new SecretComponent(plugin.app, element)
    .setValue(plugin.settings[key])
    .onChange(async (value) => {
      plugin.settings[key] = value;
      await plugin.saveSettings();
    }));
}
function makeTraceId(taskId: string): string { return `${taskId.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 40)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
export function tishOSAppleIntelligenceURL(jobId: string, folder = REMOTE_AI_QUEUE_FOLDER): string {
  folder = normalizeQueueFolder(folder);
  if (!DURABLE_JOB_ID_PATTERN.test(jobId)) throw new Error("AI gateway job id is invalid.");
  return `tishos://ai-gateway?job=${encodeURIComponent(jobId)}${folder === REMOTE_AI_QUEUE_FOLDER ? "" : `&folder=${encodeURIComponent(folder)}`}`;
}
function stableDeviceDelay(deviceId: string, rangeMs: number): number {
  let hash = 2166136261;
  for (const character of deviceId) hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
  return Math.abs(hash >>> 0) % Math.max(1, rangeMs);
}
function delay(ms: number): Promise<void> { return new Promise((resolve) => window.setTimeout(resolve, ms)); }
