import { App, Notice, Plugin, PluginSettingTab, SecretComponent, Setting, TFile, TFolder } from "obsidian";
import { callProvider } from "./providers";
import { withProviderTimeout } from "./provider-timeout";
import { assertSchema } from "./schema";
import { DEFAULT_SETTINGS, planLegacyApiKeyMigration, sanitizeSettings } from "./settings";
import * as logger from "./logger";
import {
  beginRemoteAiNotificationAttempt,
  nextRemoteAiJobRevision,
  parseRemoteAiJob,
  recoverRemoteAiNotificationState,
  remoteAiJobFileSizeIsAllowed,
  remoteAiJobIsClaimable,
  remoteAiJobPath,
  remoteAiJobSerializedSizeIsAllowed,
  remoteAiRequestPayloadIsWithinBudget,
  remoteAiResultDataIsWithinBudget,
  remoteAiJobWantsCompletionNotification,
  settleRemoteAiNotificationAttempt,
  suppressRemoteAiCompletionNotification,
  transitionRemoteAiJobFile,
  REMOTE_AI_JOB_LIFECYCLE_RESERVE_BYTES,
  REMOTE_AI_QUEUE_FOLDER,
  REMOTE_AI_WAIT_TIMEOUT_MS,
  type RemoteAiJob,
} from "./remote-queue";
import { TPSNotifierClient } from "./tps-notifier-client";
import type { TPSNotifierConsumerDeliveryResult } from "./tps-notifier-contract";
import type { AiGatewaySettings, AiProviderId, CapabilityContext, CapabilityProposal, DecisionOption, DecisionResult, GatewayCapability, StructuredRequest, StructuredResult, TpsAiGatewayApi } from "./types";

export default class TpsAiGatewayPlugin extends Plugin {
  settings: AiGatewaySettings = DEFAULT_SETTINGS;
  api!: TpsAiGatewayApi;
  private capabilities = new Map<string, GatewayCapability>();
  private saveInFlight: Promise<void> | null = null;
  private saveQueued = false;
  private lifecycleEpoch = 0;
  private remoteQueueScanEpoch: number | null = null;
  private remoteQueueScanTimer: number | null = null;
  private notifierClient?: TPSNotifierClient<TFile>;

  async onload(): Promise<void> {
    const loadEpoch = ++this.lifecycleEpoch;
    await this.loadSettings();
    if (loadEpoch !== this.lifecycleEpoch) return;
    this.api = {
      completeStructured: <T>(request: StructuredRequest) => this.completeStructured<T>(request),
      choose: <T>(request: Omit<StructuredRequest, "schema"> & { options: DecisionOption<T>[] }) => this.choose<T>(request),
      registerCapability: <TInput, TOutput>(capability: GatewayCapability<TInput, TOutput>) => this.registerCapability(capability as GatewayCapability),
      listCapabilities: () => this.listCapabilities(),
      proposeCapability: <TInput>(request: Omit<StructuredRequest, "schema"> & { capabilityIds: string[] }) => this.proposeCapability<TInput>(request),
      executeCapability: <TOutput>(proposal: CapabilityProposal, context: Omit<CapabilityContext, "traceId">) => this.executeCapability<TOutput>(proposal, context),
    };
    (this as any).api = this.api;
    (this.app as any).tpsAiGateway = this.api;
    this.notifierClient = new TPSNotifierClient<TFile>(this.app, this.manifest.id);
    this.notifierClient.start((eventRef) => this.registerEvent(eventRef));
    this.addSettingTab(new AiGatewaySettingTab(this.app, this));
    this.addCommand({ id: "validate-provider-chain", name: "Validate provider chain", callback: () => void this.validateProviderChain() });
    this.registerEvent(this.app.vault.on("create", (file) => {
      if (file.path.startsWith(`${REMOTE_AI_QUEUE_FOLDER}/`)) this.scheduleRemoteQueueScan("file-created");
    }));
    this.registerEvent(this.app.vault.on("modify", (file) => {
      if (file.path.startsWith(`${REMOTE_AI_QUEUE_FOLDER}/`)) this.scheduleRemoteQueueScan("file-modified");
    }));
    this.registerInterval(window.setInterval(() => this.scheduleRemoteQueueScan("interval"), 30_000));
    this.app.workspace.onLayoutReady(() => this.scheduleRemoteQueueScan("startup"));
    logger.flow("Plugin", "load", { providers: this.settings.providerOrder, ollamaEnabled: this.settings.ollamaEnabled });
  }

  onunload(): void {
    this.lifecycleEpoch += 1;
    if (this.remoteQueueScanTimer !== null) window.clearTimeout(this.remoteQueueScanTimer);
    this.remoteQueueScanTimer = null;
    this.notifierClient?.dispose();
    this.notifierClient = undefined;
    if ((this.app as any).tpsAiGateway === this.api) delete (this.app as any).tpsAiGateway;
    this.capabilities.clear();
    delete (this as any).api;
  }

  private async completeStructured<T>(request: StructuredRequest): Promise<StructuredResult<T>> {
    if (!request.taskId.trim()) throw new Error("AI gateway taskId is required.");
    if (!request.messages.length) throw new Error("AI gateway messages are required.");
    if (!this.isControllerDevice()) return this.completeStructuredRemotely<T>(request);
    return this.completeStructuredLocally<T>(request);
  }

  private async completeStructuredLocally<T>(request: StructuredRequest): Promise<StructuredResult<T>> {
    const traceId = makeTraceId(request.taskId);
    const requested = request.preferredProviders?.length ? request.preferredProviders : this.settings.providerOrder;
    const providers = [...new Set([...requested, ...this.settings.providerOrder])];
    const failures: string[] = [];
    let attempts = 0;
    const credentials = {
      openAiApiKey: this.readSecret(this.settings.openAiApiKeySecret),
      geminiApiKey: this.readSecret(this.settings.geminiApiKeySecret),
    };
    logger.flow("Request", "start", {
      traceId,
      taskId: request.taskId,
      providers,
      messageCount: request.messages.length,
      ...logger.metadataSummary(request.metadata),
    });
    for (const provider of providers) {
      attempts += 1;
      try {
        const response = await withProviderTimeout(
          provider,
          callProvider(provider, this.settings, credentials, request.messages, request.schema),
        );
        if (!response.text) throw new Error("Provider returned no structured result.");
        const data = JSON.parse(response.text) as T;
        assertSchema(data, request.schema);
        logger.flow("Request", "success", { traceId, taskId: request.taskId, provider, model: response.model, attempts });
        return { data, provider, model: response.model, traceId, attempts };
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
      revision: 0,
      id: jobId,
      taskId: request.taskId,
      requesterDeviceId: this.getDeviceId(),
      createdAt: now,
      updatedAt: now,
      status: "pending",
      messages: request.messages,
      schema: request.schema,
      preferredProviders: request.preferredProviders,
      metadata: request.metadata,
    };
    const file = await this.createRemoteJob(job);
    logger.flow("RemoteQueue", "submitted", { jobId, taskId: request.taskId, path: file.path });
    new Notice("Sent to the Controller. This can take a few minutes.", 7000);
    const result = await this.waitForRemoteJob<T>(file.path, request.schema);
    this.app.workspace.trigger("tps:ai-remote-job-completed" as any, { sourcePluginId: this.manifest.id, timestamp: Date.now(), jobId, taskId: request.taskId });
    return result;
  }

  private async createRemoteJob(job: RemoteAiJob): Promise<TFile> {
    if (!remoteAiRequestPayloadIsWithinBudget(job)) {
      throw new Error("Remote AI request exceeded its supported validation or size budget.");
    }
    const serialized = this.serializeRemoteJob(job);
    await this.ensureRemoteQueueFolder();
    const path = remoteAiJobPath(job.id);
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) throw new Error("AI queue job id already exists.");
    return this.app.vault.create(path, serialized);
  }

  private async waitForRemoteJob<T>(path: string, schema: Record<string, unknown>): Promise<StructuredResult<T>> {
    const deadline = Date.now() + REMOTE_AI_WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) {
        if (!remoteAiJobFileSizeIsAllowed(file.stat.size)) {
          throw new Error("The Controller AI queue result exceeded the supported file-size limit.");
        }
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
    throw new Error("The Controller AI request is still queued. This request cannot resume automatically after the 20-minute wait; retry the originating action later. A completion notification arrives only when that request enabled one.");
  }

  private scheduleRemoteQueueScan(reason: string): void {
    if (!this.isControllerDevice() || this.remoteQueueScanTimer !== null) return;
    this.remoteQueueScanTimer = window.setTimeout(() => {
      this.remoteQueueScanTimer = null;
      void this.scanRemoteQueue(reason);
    }, 750);
  }

  private async scanRemoteQueue(reason: string): Promise<void> {
    const lifecycleEpoch = this.lifecycleEpoch;
    if (!this.isControllerDevice() || this.remoteQueueScanEpoch !== null) return;
    this.remoteQueueScanEpoch = lifecycleEpoch;
    try {
      const folder = this.app.vault.getAbstractFileByPath(REMOTE_AI_QUEUE_FOLDER);
      const files = folder instanceof TFolder
        ? folder.children.filter((file): file is TFile => file instanceof TFile && file.extension === "md")
        : [];
      logger.flow("RemoteQueue", "scan", { reason, files: files.length });
      for (const file of files) {
        if (lifecycleEpoch !== this.lifecycleEpoch) break;
        try {
          await this.scanRemoteQueueFile(file, lifecycleEpoch);
        } catch (error) {
          logger.warn("RemoteQueue", "file-scan-failed", {
            reason,
            path: file.path,
            error: logger.errorSummary(error),
          });
        }
      }
    } catch (error) {
      logger.warn("RemoteQueue", "scan-failed", { reason, error: logger.errorSummary(error) });
    } finally {
      if (this.remoteQueueScanEpoch === lifecycleEpoch) this.remoteQueueScanEpoch = null;
    }
  }

  private async scanRemoteQueueFile(file: TFile, lifecycleEpoch: number): Promise<void> {
    if (!remoteAiJobFileSizeIsAllowed(file.stat.size)) {
      logger.warn("RemoteQueue", "invalid-job", { path: file.path, reason: "file-size-limit" });
      return;
    }
    let job = parseRemoteAiJob(await this.app.vault.read(file));
    if (lifecycleEpoch !== this.lifecycleEpoch) return;
    if (!job || remoteAiJobPath(job.id) !== file.path) {
      logger.warn("RemoteQueue", "invalid-job", { path: file.path });
      return;
    }
    const initialRecovery = recoverRemoteAiNotificationState(job);
    if (initialRecovery.changed) {
      const recovered = await transitionRemoteAiJobFile(this.app.vault, file, (current) => {
        const recovery = recoverRemoteAiNotificationState(current);
        return recovery.changed
          ? { ...recovery.job, revision: nextRemoteAiJobRevision(current) }
          : null;
      });
      if (recovered.job) job = recovered.job;
      if (recovered.changed) {
        logger.flow("RemoteQueue", "notification-state-recovered", {
          jobId: job.id,
          taskId: job.taskId,
          state: job.completionNotification?.policy === "send"
            ? job.completionNotification.delivery.state
            : "suppressed",
        });
      }
    }
    if (remoteAiJobPath(job.id) !== file.path
      || lifecycleEpoch !== this.lifecycleEpoch
      || !remoteAiJobIsClaimable(job)) return;

    const claimId = makeTraceId(`claim-${job.id}`);
    const startedAt = new Date().toISOString();
    const claim = await transitionRemoteAiJobFile(this.app.vault, file, (current) => {
      if (!remoteAiJobIsClaimable(current)) return null;
      return {
        ...current,
        revision: nextRemoteAiJobRevision(current),
        status: "processing",
        controllerDeviceId: this.getDeviceId(),
        claimId,
        startedAt,
        updatedAt: startedAt,
        result: undefined,
        error: undefined,
      };
    });
    if (!claim.changed || !claim.job || claim.job.claimId !== claimId) return;
    logger.flow("RemoteQueue", "claimed", { jobId: claim.job.id, taskId: claim.job.taskId, claimId });
    await this.processRemoteJob(file, claim.job, lifecycleEpoch);
  }

  private async processRemoteJob(file: TFile, claimed: RemoteAiJob, lifecycleEpoch: number): Promise<void> {
    let terminal: RemoteAiJob;
    try {
      const result = await this.completeStructuredLocally({ taskId: claimed.taskId, messages: claimed.messages, schema: claimed.schema, preferredProviders: claimed.preferredProviders, metadata: claimed.metadata });
      if (!remoteAiResultDataIsWithinBudget(result.data)) {
        throw new Error("Provider result exceeded the remote AI result budget.");
      }
      terminal = { ...claimed, status: "complete", updatedAt: new Date().toISOString(), result, error: undefined };
      this.serializeRemoteJob(terminal);
      logger.flow("RemoteQueue", "execution-completed", { jobId: claimed.id, taskId: claimed.taskId, provider: result.provider, model: result.model });
    } catch (error) {
      const message = logger.errorSummary(error, [this.readSecret(this.settings.openAiApiKeySecret), this.readSecret(this.settings.geminiApiKeySecret)]);
      terminal = { ...claimed, status: "failed", updatedAt: new Date().toISOString(), result: undefined, error: message };
      logger.warn("RemoteQueue", "execution-failed", { jobId: claimed.id, taskId: claimed.taskId, error: message });
    }
    await this.persistTerminalJobAndNotify(file, terminal, lifecycleEpoch);
  }

  private async persistTerminalJobAndNotify(
    file: TFile,
    terminal: RemoteAiJob,
    lifecycleEpoch: number,
  ): Promise<void> {
    const attemptId = makeTraceId(`notify-${terminal.id}`);
    const transition = await transitionRemoteAiJobFile(this.app.vault, file, (current) => {
      if (current.id !== terminal.id
        || current.status !== "processing"
        || !terminal.claimId
        || current.claimId !== terminal.claimId) return null;
      const ownedTerminal: RemoteAiJob = {
        ...current,
        revision: nextRemoteAiJobRevision(current),
        status: terminal.status,
        updatedAt: terminal.updatedAt,
        result: terminal.result,
        error: terminal.error,
      };
      if (!remoteAiJobWantsCompletionNotification(ownedTerminal)) {
        return suppressRemoteAiCompletionNotification(ownedTerminal);
      }
      return beginRemoteAiNotificationAttempt(ownedTerminal, attemptId);
    });
    if (!transition.changed || !transition.job) {
      logger.warn("RemoteQueue", "terminal-state-conflict", { jobId: terminal.id, taskId: terminal.taskId });
      return;
    }
    const persisted = transition.job;
    if (persisted.completionNotification?.policy === "suppressed") {
      logger.flow("RemoteQueue", "terminal-persisted", { jobId: terminal.id, taskId: terminal.taskId, status: terminal.status });
      logger.flow("RemoteQueue", "notification-skipped", { jobId: terminal.id, taskId: terminal.taskId });
      return;
    }
    logger.flow("RemoteQueue", "terminal-persisted", { jobId: terminal.id, taskId: terminal.taskId, status: terminal.status });

    const succeeded = terminal.status === "complete";
    const label = typeof terminal.metadata?.notificationTitle === "string" && terminal.metadata.notificationTitle.trim()
      ? terminal.metadata.notificationTitle.trim().slice(0, 80)
      : "TPS AI request";
    const title = succeeded ? `${label} complete` : `${label} failed`;
    const body = succeeded
      ? `${label} finished on the Controller. If the original 20-minute wait ended, run that action again; it cannot resume automatically.`
      : `${label} could not be completed on the Controller.`;

    let delivery: TPSNotifierConsumerDeliveryResult;
    if (lifecycleEpoch !== this.lifecycleEpoch) {
      logger.flow("RemoteQueue", "notification-interrupted", { jobId: terminal.id, taskId: terminal.taskId, boundary: "before-send" });
      await this.settleRemoteJobNotification(file, terminal, attemptId, Object.freeze({
        state: "not-attempted" as const,
        transport: "unavailable" as const,
        evidence: "interrupted" as const,
        attempted: false,
      }));
      return;
    }
    try {
      delivery = this.notifierClient
        ? await this.notifierClient.send({ title, body })
        : Object.freeze({
          state: "not-attempted" as const,
          transport: "unavailable" as const,
          evidence: "interrupted" as const,
          attempted: false,
        });
    } catch {
      delivery = Object.freeze({
        state: "unknown" as const,
        transport: "unknown" as const,
        evidence: "interrupted" as const,
        attempted: "unknown" as const,
      });
    }
    if (lifecycleEpoch !== this.lifecycleEpoch) {
      logger.flow("RemoteQueue", "notification-interrupted", { jobId: terminal.id, taskId: terminal.taskId, boundary: "after-send" });
      return;
    }
    await this.settleRemoteJobNotification(file, terminal, attemptId, delivery);
  }

  private async settleRemoteJobNotification(
    file: TFile,
    terminal: RemoteAiJob,
    attemptId: string,
    delivery: TPSNotifierConsumerDeliveryResult,
  ): Promise<void> {
    const settlement = await transitionRemoteAiJobFile(this.app.vault, file, (current) => {
      const settled = settleRemoteAiNotificationAttempt(current, attemptId, delivery);
      return settled ? { ...settled, revision: nextRemoteAiJobRevision(current) } : null;
    });
    if (!settlement.changed) {
      logger.warn("RemoteQueue", "notification-state-conflict", { jobId: terminal.id, taskId: terminal.taskId });
      return;
    }
    logger.flow("RemoteQueue", "notification-settled", {
      jobId: terminal.id,
      taskId: terminal.taskId,
      state: delivery.state,
      transport: delivery.transport,
      evidence: delivery.evidence,
      attempted: delivery.attempted,
      httpStatus: delivery.httpStatus,
    });
  }

  private serializeRemoteJob(job: RemoteAiJob): string {
    const serialized = JSON.stringify(job, null, 2);
    if (!remoteAiJobSerializedSizeIsAllowed(serialized, REMOTE_AI_JOB_LIFECYCLE_RESERVE_BYTES)
      || !parseRemoteAiJob(serialized)) {
      throw new Error("Remote AI queue payload exceeded its supported validation or size budget.");
    }
    return serialized;
  }

  private isControllerDevice(): boolean {
    const controller = (this.app as any).plugins?.getPlugin?.("tps-controller");
    return controller?.api?.isController?.() === true;
  }

  private getDeviceId(): string {
    const key = `tps-ai-gateway-device-id-${this.app.vault.getName()}`;
    const existing = window.localStorage.getItem(key);
    if (existing) return existing;
    const created = `device-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    window.localStorage.setItem(key, created);
    return created;
  }

  private async ensureRemoteQueueFolder(): Promise<void> {
    let path = "";
    for (const segment of REMOTE_AI_QUEUE_FOLDER.split("/")) {
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
    this.settings = sanitizeSettings(raw);
    logger.setLogging(this.settings.enableLogging);
    const migration = planLegacyApiKeyMigration(raw, this.settings, (name) => this.app.secretStorage.getSecret(name));
    for (const write of migration.writes) this.app.secretStorage.setSecret(write.secretName, write.value);
    if (migration.shouldPersist) await this.saveData(this.settings);
    if (migration.writes.length) logger.flow("Settings", "legacy-api-keys-migrated", { providers: migration.writes.map((write) => write.provider) });
  }
  async saveSettings(): Promise<void> {
    this.settings = sanitizeSettings(this.settings); logger.setLogging(this.settings.enableLogging);
    if (this.saveInFlight) { this.saveQueued = true; await this.saveInFlight; return; }
    do { this.saveQueued = false; this.saveInFlight = this.saveData(this.settings); try { await this.saveInFlight; } finally { this.saveInFlight = null; } } while (this.saveQueued);
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

class AiGatewaySettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: TpsAiGatewayPlugin) { super(app, plugin); }
  display(): void {
    const { containerEl } = this; containerEl.empty(); containerEl.createEl("h2", { text: "TPS AI Gateway" });
    containerEl.createEl("p", { text: "Central AI transport for TPS. Domain plugins retain ownership of actions and resource creation." });
    const coreSettings = containerEl.createDiv({ cls: "tps-settings-core" });
    new Setting(coreSettings).setName("Core cloud providers").setHeading();
    secretReferenceSetting(coreSettings, this.plugin, "OpenAI API key", "Select or create a device-local Obsidian secret. API billing is separate from ChatGPT/Codex subscriptions.", "openAiApiKeySecret");
    textSetting(coreSettings, this.plugin, "OpenAI model", "OpenAI structured-output model.", "openAiModel");
    secretReferenceSetting(coreSettings, this.plugin, "Gemini API key", "Select or create a device-local Obsidian secret for the mobile-capable cloud fallback.", "geminiApiKeySecret");
    textSetting(coreSettings, this.plugin, "Gemini model", "Gemini structured-output model.", "geminiModel");

    const ollamaSettings = createSettingsSection(containerEl, "Optional local Ollama", "Local inference is tried before configured cloud providers.");
    new Setting(ollamaSettings).setName("Use local Ollama").setDesc("Try local structured inference before configured cloud providers.").addToggle((toggle) => toggle.setValue(this.plugin.settings.ollamaEnabled).onChange(async (value) => { this.plugin.settings.ollamaEnabled = value; await this.plugin.saveSettings(); }));
    textSetting(ollamaSettings, this.plugin, "Ollama URL", "Local or secured Ollama endpoint.", "ollamaUrl");
    textSetting(ollamaSettings, this.plugin, "Ollama model", "Local structured-output model.", "ollamaModel");

    const diagnostics = createSettingsSection(containerEl, "Diagnostics", "Optional privacy-safe provider routing logs.");
    new Setting(diagnostics).setName("Enable logging").setDesc("Log provider/capability routing and metadata counts without prompts, responses, metadata values, or secrets.").addToggle((toggle) => toggle.setValue(this.plugin.settings.enableLogging).onChange(async (value) => { this.plugin.settings.enableLogging = value; await this.plugin.saveSettings(); }));
  }
}

function createSettingsSection(parent: HTMLElement, title: string, description: string): HTMLElement {
  const details = parent.createEl("details", { cls: "tps-collapsible-section" });
  const summary = details.createEl("summary", { cls: "tps-collapsible-section-summary" });
  summary.createSpan({ cls: "tps-collapsible-section-title", text: title });
  details.createEl("p", { cls: "tps-collapsible-section-description", text: description });
  return details.createDiv({ cls: "tps-collapsible-section-content" });
}

type TextSettingKey = "ollamaUrl" | "ollamaModel" | "openAiModel" | "geminiModel";
function textSetting(container: HTMLElement, plugin: TpsAiGatewayPlugin, name: string, description: string, key: TextSettingKey): void { new Setting(container).setName(name).setDesc(description).addText((text) => text.setValue(plugin.settings[key]).onChange(async (value) => { plugin.settings[key] = value.trim(); await plugin.saveSettings(); })); }
function secretReferenceSetting(container: HTMLElement, plugin: TpsAiGatewayPlugin, name: string, description: string, key: "openAiApiKeySecret" | "geminiApiKeySecret"): void {
  new Setting(container).setName(name).setDesc(description).addComponent((element) => new SecretComponent(plugin.app, element)
    .setValue(plugin.settings[key])
    .onChange(async (value) => {
      plugin.settings[key] = value;
      await plugin.saveSettings();
    }));
}
function makeTraceId(taskId: string): string { return `${taskId.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 40)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
function delay(ms: number): Promise<void> { return new Promise((resolve) => window.setTimeout(resolve, ms)); }
