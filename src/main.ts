import { DEVICE_SETTINGS_KEY, resolveDeviceSettings } from "./settings";
import { App, Notice, Plugin, PluginSettingTab, SecretComponent, Setting } from "obsidian";
import { callProvider } from "./providers";
import { withProviderTimeout } from "./provider-timeout";
import { assertSchema } from "./schema";
import {
  AiGatewaySettingsSaveCoordinator,
  DEFAULT_SETTINGS,
  reconcilePersistedSettings,
  sanitizeSettings,
} from "./settings";
import * as logger from "./logger";
import type { AiGatewaySettings, AiProviderId, CapabilityContext, CapabilityProposal, DecisionOption, DecisionResult, GatewayCapability, StructuredRequest, StructuredResult, TpsAiGatewayApi } from "./types";

const INLINE_MEDIA_MAX_ITEMS = 3;
const INLINE_MEDIA_MAX_BASE64_CHARACTERS = 16 * 1024 * 1024;
const INLINE_MEDIA_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export default class TpsAiGatewayPlugin extends Plugin {
  settings: AiGatewaySettings = DEFAULT_SETTINGS;
  api!: TpsAiGatewayApi;
  private unloading = false;
  private capabilities = new Map<string, GatewayCapability>();
  private settingsPersistence: AiGatewaySettingsSaveCoordinator | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    if (this.unloading) return;
    this.api = {
      connectionSettings: { version: 1, render: (parent: HTMLElement) => {
        const panel = new AiConnectionSettings(this.app, this, parent);
        panel.display();
        return () => panel.dispose();
      } },
      features: { googleSearchGrounding: true, appleIntelligence: false },
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
    logger.flow("Plugin", "load", { providers: this.settings.providerOrder, ollamaEnabled: this.settings.ollamaEnabled });
  }

  onunload(): void {
    this.unloading = true;
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
    if (request.durableJobId) throw new Error("Durable AI jobs are retired in Obsidian. Existing queue files are unchanged; submit a direct request explicitly.");
    const requested = request.preferredProviders?.length ? request.preferredProviders : this.settings.providerOrder;
    const providers = [...new Set([...requested, ...this.settings.providerOrder])]
      .filter((provider) => !(request.grounding || request.media?.length) || provider === "gemini");
    let attempts = 0;
    let lastError: unknown;
    for (const provider of providers) {
      if (provider === "apple") throw new Error("TishOS Apple Intelligence is unavailable in Obsidian: the file-based AI bridge is retired. Choose a direct provider in AI settings.");
      if (provider === "ollama" && !this.settings.ollamaEnabled) continue;
      if ((provider === "openai" || provider === "gemini")
        && !this.deviceLocalCloudProviders({ ...request, preferredProviders: [provider] }).length) continue;
      attempts += 1;
      try {
        const result = await this.completeStructuredLocally<T>({ ...request, preferredProviders: [provider] }, [provider]);
        return { ...result, attempts: attempts - 1 + (result.attempts || 1) };
      } catch (error) {
        lastError = error;
        logger.warn("Request", "route-failed", { taskId: request.taskId, provider, reason: logger.errorSummary(error) });
      }
    }
    if (attempts) throw lastError;
    if (request.media?.length) throw new Error("Image requests require Gemini to be configured in TPS AI Gateway on this device.");
    if (!providers.length) throw new Error("Choose a primary AI provider in TPS AI Gateway.");
    throw new Error("No configured direct AI provider is available on this device. File-queue fallback is retired.");
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
    this.settingsPersistence = new AiGatewaySettingsSaveCoordinator({
      loadLatest: async () => this.app.loadLocalStorage(DEVICE_SETTINGS_KEY),
      saveMerged: async (value) => { this.app.saveLocalStorage(DEVICE_SETTINGS_KEY, value); },
      onPersisted: (requested, persisted) => reconcilePersistedSettings(this.settings, requested, persisted),
    }, this.settings);
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

export class AiGatewaySettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: TpsAiGatewayPlugin) { super(app, plugin); }
  display(): void {
    this.containerEl.empty();
    this.containerEl.createEl("h2", { text: "TPS AI Gateway" });
    new Setting(this.containerEl).setName("AI connections")
      .setDesc("Providers, models, backups, and request routing are managed in TPS Controller.")
      .addButton(button => button.setButtonText("Open connections").onClick(() => {
        const controller = (this.app as any).plugins?.plugins?.["tps-controller"]?.api;
        if (typeof controller?.openConnectionSettings === "function") controller.openConnectionSettings("ai");
        else new Notice("Enable or update TPS Controller to 2.6.0+ to manage AI connections.");
      }));
  }
}

export class AiConnectionSettings {
  private backupEditor: AiProviderId | null = null;

  private disposed = false;
  constructor(private app: App, private plugin: TpsAiGatewayPlugin, readonly containerEl: HTMLElement) {}
  dispose(): void { this.disposed = true; }
  display(): void { this.renderSettings(); }

  private async selectPrimary(provider: AiProviderId): Promise<void> {
    this.plugin.settings.providerOrder = [provider, ...this.plugin.settings.providerOrder.slice(1).filter((item) => item !== provider)];
    await this.plugin.saveSettings();
    this.renderSettings("primary");
  }

  private renderSettings(focus?: string): void {
    if (this.disposed) return;
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
    containerEl.createEl("p", { cls: "tps-ai-settings-note", text: "Backups apply to direct requests. The TishOS file bridge and durable jobs are retired; an unavailable bridge route requires an explicit provider change." });
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
      new Setting(container).setName("Apple Intelligence unavailable")
        .setDesc("The file-based TishOS bridge is retired. Choose Cloud or On device for direct requests. Existing queue files and settings are preserved.");
    }
  }
}

const AI_MODES = [
  { id: "cloud", title: "Cloud" },
  { id: "device", title: "On device" },
  { id: "tps", title: "TPS routed (unavailable)" },
] as const;
const AI_PROVIDERS: AiProviderId[] = ["gemini", "openai", "ollama", "apple"];
function providerMode(provider?: AiProviderId): string {
  return provider === "apple" ? "tps" : provider === "ollama" ? "device" : provider ? "cloud" : "";
}
function providerLabel(provider: AiProviderId): string {
  return { gemini: "Cloud · Google AI", openai: "Cloud · OpenAI", ollama: "On device · Ollama", apple: "Apple Intelligence (unavailable)" }[provider];
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
