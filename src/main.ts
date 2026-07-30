import { App, Notice, Plugin, PluginSettingTab, SecretComponent, Setting, TFile, Vault } from "obsidian";
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

export default class TpsAiGatewayPlugin extends Plugin {
  settings: AiGatewaySettings = DEFAULT_SETTINGS;
  api!: TpsAiGatewayApi;
  private capabilities = new Map<string, GatewayCapability>();
  private settingsPersistence: AiGatewaySettingsSaveCoordinator | null = null;
  private remoteQueueScanInFlight = false;
  private remoteQueueRescanRequested = false;
  private remoteQueueScanTimer: number | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
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
    if (this.remoteQueueScanTimer !== null) window.clearTimeout(this.remoteQueueScanTimer);
    this.remoteQueueRescanRequested = false;
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
    await this.ensureRemoteQueueFolder();
    const path = remoteAiJobPath(job.id);
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
    throw new Error("The Controller AI request is still queued. You will receive a notification when it finishes.");
  }

  private scheduleRemoteQueueScan(reason: string): void {
    if (!this.isControllerDevice() || this.remoteQueueScanTimer !== null) return;
    this.remoteQueueScanTimer = window.setTimeout(() => {
      this.remoteQueueScanTimer = null;
      void this.scanRemoteQueue(reason);
    }, 750);
  }

  private getRemoteQueueMarkdownFiles(): TFile[] {
    const folder = this.app.vault.getFolderByPath(REMOTE_AI_QUEUE_FOLDER);
    if (!folder) return [];
    const files: TFile[] = [];
    Vault.recurseChildren(folder, (child) => {
      if (child instanceof TFile && child.extension === "md") files.push(child);
    });
    return files;
  }

  private async scanRemoteQueue(reason: string): Promise<void> {
    if (!this.isControllerDevice()) return;
    if (this.remoteQueueScanInFlight) {
      this.remoteQueueRescanRequested = true;
      return;
    }
    this.remoteQueueScanInFlight = true;
    try {
      for (let pass = 0; pass < 2; pass += 1) {
        if (pass > 0 && (!this.remoteQueueRescanRequested || !this.isControllerDevice())) break;
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
              if (remoteAiJobIsClaimable(job)) await this.processRemoteJob(file, job);
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
      const scheduleFollowUp = this.remoteQueueRescanRequested && this.isControllerDevice();
      this.remoteQueueRescanRequested = false;
      this.remoteQueueScanInFlight = false;
      if (scheduleFollowUp) this.scheduleRemoteQueueScan("queued-after-trailing");
    }
  }

  private async processRemoteJob(file: TFile, job: RemoteAiJob): Promise<void> {
    const startedAt = new Date().toISOString();
    const claimed: RemoteAiJob = { ...job, status: "processing", controllerDeviceId: this.getDeviceId(), startedAt, updatedAt: startedAt, error: undefined };
    await this.app.vault.modify(file, JSON.stringify(claimed, null, 2));
    logger.flow("RemoteQueue", "claimed", { jobId: job.id, taskId: job.taskId });
    try {
      const result = await this.completeStructuredLocally({ taskId: job.taskId, messages: job.messages, schema: job.schema, preferredProviders: job.preferredProviders, metadata: job.metadata });
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
      ? `${label} finished on the Controller. Open Obsidian on the requesting device to continue.`
      : `${label} could not be completed on the Controller.`;
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
    if (migration.shouldPersist) {
      const migrated = createMigratedSettingsPayload(raw, this.settings);
      await this.saveData(migrated);
      this.settings = sanitizeSettings(migrated);
    }
    this.settingsPersistence = new AiGatewaySettingsSaveCoordinator({
      loadLatest: () => this.loadData(),
      saveMerged: (value) => this.saveData(value),
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

class AiGatewaySettingTab extends PluginSettingTab {
  private activeRoute: AiSettingsRoute = "cloud";

  constructor(app: App, private plugin: TpsAiGatewayPlugin) { super(app, plugin); }

  display(): void {
    this.renderSettings(false);
  }

  private renderSettings(focusPageHeading: boolean): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "TPS AI Gateway" });
    containerEl.createEl("p", { text: "Central AI transport for TPS. Domain plugins retain ownership of actions and resource creation." });

    containerEl.createEl("h3", { cls: "tps-ai-settings-hub-heading", text: "Choose what to configure" });
    const hub = containerEl.createDiv({ cls: "tps-ai-settings-hub" });
    let activeRouteButton: HTMLButtonElement | null = null;
    for (const route of AI_SETTINGS_ROUTES) {
      const isActive = route.id === this.activeRoute;
      const button = hub.createEl("button", {
        cls: "tps-ai-settings-route-button",
        attr: {
          type: "button",
          "aria-pressed": String(isActive),
          "aria-label": `${route.title}: ${route.description}`,
        },
      });
      if (isActive) activeRouteButton = button;
      button.createSpan({ cls: "tps-ai-settings-route-title", text: route.title });
      button.createSpan({ cls: "tps-ai-settings-route-description", text: route.description });
      button.addEventListener("click", () => {
        if (this.activeRoute === route.id) return;
        this.activeRoute = route.id;
        this.renderSettings(true);
      });
    }

    const route = AI_SETTINGS_ROUTES.find((candidate) => candidate.id === this.activeRoute) ?? AI_SETTINGS_ROUTES[0];
    const page = containerEl.createDiv({ cls: "tps-ai-settings-page" });
    const pageHeading = page.createEl("h3", {
      text: route.title,
      attr: { tabindex: "-1" },
    });
    page.createEl("p", { cls: "setting-item-description", text: route.description });

    if (this.activeRoute === "cloud") {
      secretReferenceSetting(page, this.plugin, "OpenAI API key", "Select or create a device-local Obsidian secret. API billing is separate from ChatGPT/Codex subscriptions.", "openAiApiKeySecret");
      textSetting(page, this.plugin, "OpenAI model", "OpenAI structured-output model.", "openAiModel");
      secretReferenceSetting(page, this.plugin, "Gemini API key", "Select or create a device-local Obsidian secret for the mobile-capable cloud fallback.", "geminiApiKeySecret");
      textSetting(page, this.plugin, "Gemini model", "Gemini structured-output model.", "geminiModel");
    } else if (this.activeRoute === "local") {
      new Setting(page).setName("Use local Ollama").setDesc("Try local structured inference before configured cloud providers.").addToggle((toggle) => toggle.setValue(this.plugin.settings.ollamaEnabled).onChange(async (value) => { this.plugin.settings.ollamaEnabled = value; await this.plugin.saveSettings(); }));
      textSetting(page, this.plugin, "Ollama URL", "Local or secured Ollama endpoint.", "ollamaUrl");
      textSetting(page, this.plugin, "Ollama model", "Local structured-output model.", "ollamaModel");
    } else {
      new Setting(page).setName("Enable logging").setDesc("Log provider/capability routing and metadata counts without prompts, responses, metadata values, or secrets.").addToggle((toggle) => toggle.setValue(this.plugin.settings.enableLogging).onChange(async (value) => { this.plugin.settings.enableLogging = value; await this.plugin.saveSettings(); }));
    }

    if (focusPageHeading) {
      containerEl.scrollTop = 0;
      window.requestAnimationFrame(() => {
        activeRouteButton?.scrollIntoView({ block: "nearest", inline: "nearest" });
        pageHeading.focus({ preventScroll: true });
        pageHeading.scrollIntoView({ block: "start" });
      });
    }
  }
}

type AiSettingsRoute = "cloud" | "local" | "diagnostics";
const AI_SETTINGS_ROUTES: ReadonlyArray<{ id: AiSettingsRoute; title: string; description: string }> = [
  { id: "cloud", title: "Cloud providers", description: "Choose device-local credentials and models for OpenAI and Gemini." },
  { id: "local", title: "Local Ollama", description: "Configure optional local-first inference before cloud fallbacks." },
  { id: "diagnostics", title: "Diagnostics", description: "Control privacy-safe provider and capability routing logs." },
];

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
