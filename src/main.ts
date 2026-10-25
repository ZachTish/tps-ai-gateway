import { DEVICE_SETTINGS_KEY, resolveDeviceSettings } from "./settings";
import { App, Notice, Platform, Plugin, PluginSettingTab, SecretComponent, Setting } from "obsidian";
import { APPLE_CALLBACK, AppleShortcutConnection, parseAppleShortcutResponse } from "./apple-shortcuts";
import { cancelSubscriptionRequests, openSubscriptionLogin } from "./subscription-cli";
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
  private appleShortcut = new AppleShortcutConnection(url => { window.open(url); });
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
      features: { googleSearchGrounding: true, appleIntelligence: false, appleShortcuts: Boolean(Platform.isMacOS || Platform.isIosApp) },
      completeStructured: <T>(request: StructuredRequest) => this.completeStructured<T>(request),
      choose: <T>(request: Omit<StructuredRequest, "schema"> & { options: DecisionOption<T>[] }) => this.choose<T>(request),
      registerCapability: <TInput, TOutput>(capability: GatewayCapability<TInput, TOutput>) => this.registerCapability(capability as GatewayCapability),
      listCapabilities: () => this.listCapabilities(),
      proposeCapability: <TInput>(request: Omit<StructuredRequest, "schema"> & { capabilityIds: string[] }) => this.proposeCapability<TInput>(request),
      executeCapability: <TOutput>(proposal: CapabilityProposal, context: Omit<CapabilityContext, "traceId">) => this.executeCapability<TOutput>(proposal, context),
    };
    (this as any).api = this.api;
    (this.app as any).tpsAiGateway = this.api;
    this.registerObsidianProtocolHandler(APPLE_CALLBACK, params => this.appleShortcut.receive(params, this.app.vault.getName()));
    this.addSettingTab(new AiGatewaySettingTab(this.app, this));
    this.addCommand({ id: "validate-provider-chain", name: "Validate provider chain", callback: () => void this.validateProviderChain() });
    logger.flow("Plugin", "load", { providers: this.settings.providerOrder, ollamaEnabled: this.settings.ollamaEnabled });
  }

  onunload(): void {
    this.unloading = true;
    this.appleShortcut.dispose();
    cancelSubscriptionRequests();
    if ((this.app as any).tpsAiGateway === this.api) delete (this.app as any).tpsAiGateway;
    this.capabilities.clear();
    delete (this as any).api;
  }

  private async completeStructured<T>(request: StructuredRequest): Promise<StructuredResult<T>> {
    if (!request.taskId.trim()) throw new Error("AI gateway taskId is required.");
    if (!request.messages.length) throw new Error("AI gateway messages are required.");
    if (this.unloading) throw new Error("AI Gateway is closed.");
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
      if (this.unloading) throw new Error("AI Gateway closed before another provider could start.");
      if (provider === "apple") throw new Error("TishOS Apple Intelligence is unavailable in Obsidian: the file-based AI bridge is retired. Choose a direct provider in AI settings.");
      if (provider === "apple-shortcuts") {
        // A foreground handoff must never race a backup after cancellation/timeout.
        return this.completeAppleShortcut<T>(request);
      }
      if ((provider === "gemini-cli" || provider === "grok-cli") && !Platform.isMacOS) {
        lastError = new Error("Subscription sign-in tools require macOS. Choose an API connection or Apple Shortcuts on this device.");
        continue;
      }
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
    if (lastError) throw lastError;
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
    if (this.unloading) throw new Error("AI Gateway is closed.");
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
      compatibleApiKey: this.readSecret(this.settings.compatibleApiKeySecret),
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
      if (this.unloading) throw new Error("AI Gateway closed before another provider could start.");
      attempts += 1;
      try {
        const work = callProvider(provider, this.settings, credentials, request.messages, request.schema, request.media, request.grounding);
        // Subscription subprocesses have their own deadline which terminates the process.
        const response = await (provider === "gemini-cli" || provider === "grok-cli" ? work : withProviderTimeout(provider, work));
        if (!response.text) throw new Error("Provider returned no structured result.");
        let data: T;
        try { data = JSON.parse(response.text) as T; } catch { throw new Error("Provider returned invalid JSON."); }
        assertSchema(data, request.schema);
        logger.flow("Request", "success", { traceId, taskId: request.taskId, provider, model: response.model, attempts });
        return { data, provider, model: response.model, traceId, attempts, sources: response.sources };
      } catch (error) {
        const summary = logger.errorSummary(error, [credentials.openAiApiKey, credentials.geminiApiKey, credentials.compatibleApiKey]);
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

  private async completeAppleShortcut<T>(request: StructuredRequest): Promise<StructuredResult<T>> {
    if (this.unloading) throw new Error("AI Gateway is closed.");
    if (!Platform.isMacOS && !Platform.isIosApp) throw new Error("Apple Shortcuts requires macOS or iOS with Apple Intelligence.");
    if (request.media?.length || request.grounding) throw new Error("The Apple shortcut connection supports text requests only.");
    const response = await this.appleShortcut.request(this.settings.appleShortcutName, this.app.vault.getName(), request.messages, request.schema);
    const data = parseAppleShortcutResponse(response.text) as T;
    assertSchema(data, request.schema);
    return { data, provider: "apple-shortcuts", model: response.model, traceId: makeTraceId(request.taskId), attempts: 1 };
  }

  async validateProviderChain(provider?: AiProviderId): Promise<void> {
    const request: StructuredRequest = { taskId: "gateway-diagnostic", messages: [{ role: "user", content: "Return ok as true." }], schema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } } };
    try {
      const result = provider === "apple-shortcuts" ? await this.completeAppleShortcut<{ ok: boolean }>(request)
        : provider ? await this.completeStructuredLocally<{ ok: boolean }>(request, [provider])
        : await this.completeStructured<{ ok: boolean }>(request);
      if (result.data.ok !== true) throw new Error("The provider answered, but did not pass the connection test.");
      new Notice(`Connected: ${result.provider} (${result.model}).`);
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
  private panel: AiConnectionSettings | null = null;
  constructor(app: App, private plugin: TpsAiGatewayPlugin) { super(app, plugin); }
  display(): void {
    this.panel?.dispose();
    this.panel = new AiConnectionSettings(this.app, this.plugin, this.containerEl);
    this.panel.display();
  }
  hide(): void { this.panel?.dispose(); this.panel = null; }
}

export const AI_PROVIDERS: AiProviderId[] = ["gemini-cli", "grok-cli", "apple-shortcuts", "ollama", "compatible", "gemini", "openai"];
export const PROVIDER_LABELS: Record<AiProviderId, string> = {
  "gemini-cli": "Gemini Code Assist · Eligible work account · Mac",
  "grok-cli": "Grok subscription · Mac",
  "apple-shortcuts": "Apple Intelligence · Shortcuts",
  ollama: "Local / open models · Ollama",
  compatible: "Other provider · Compatible API",
  gemini: "Google Gemini / Gemma · API key",
  openai: "OpenAI · API key",
  apple: "Retired TishOS bridge · Choose another provider",
};

export class AiConnectionSettings {
  private disposed = false;
  private advancedOpen = false;
  private backupEditor: AiProviderId | null = null;
  constructor(private app: App, private plugin: TpsAiGatewayPlugin, readonly containerEl: HTMLElement) {}
  dispose(): void { this.disposed = true; }
  display(): void { this.renderSettings(); }

  private async selectPrimary(provider: AiProviderId | ""): Promise<void> {
    const previous = [...this.plugin.settings.providerOrder];
    this.plugin.settings.providerOrder = provider ? [provider, ...previous.slice(1).filter(item => item !== provider)] : [];
    try { await this.plugin.saveSettings(); } catch { this.plugin.settings.providerOrder = previous; new Notice("Could not save the provider. Try again."); }
    this.renderSettings("primary");
  }

  private renderSettings(focus?: string): void {
    if (this.disposed) return;
    const { containerEl } = this;
    const scrollTop = containerEl.scrollTop;
    containerEl.empty(); containerEl.addClass("tps-ai-settings-page");
    containerEl.createEl("h2", { text: "AI connection" });
    containerEl.createEl("p", { cls: "tps-ai-settings-note", text: "Choose a provider, connect, then test. This setup is saved on this device. Opening settings sends nothing." });
    const primary = this.plugin.settings.providerOrder[0];
    new Setting(containerEl).setName("Provider").setDesc("Subscriptions, API accounts and local models connect differently.")
      .addDropdown(dropdown => {
        dropdown.selectEl.setAttribute("aria-label", "AI provider"); dropdown.selectEl.setAttribute("data-ai-focus", "primary");
        dropdown.addOption("", "Choose a provider");
        for (const id of AI_PROVIDERS) dropdown.addOption(id, PROVIDER_LABELS[id]);
        if (primary === "apple") dropdown.addOption("apple", PROVIDER_LABELS.apple);
        dropdown.setValue(primary || "").onChange(value => { void this.selectPrimary(value as AiProviderId | ""); });
      });
    if (primary) this.renderProvider(containerEl.createDiv({ cls: "tps-ai-settings-provider" }), primary);

    const advanced = containerEl.createEl("details", { cls: "tps-ai-settings-diagnostics" });
    if (this.advancedOpen) advanced.setAttribute("open", "");
    advanced.addEventListener("toggle", () => { this.advancedOpen = advanced.open; });
    advanced.createEl("summary", { text: "Advanced" });
    if (primary) this.renderOptionalTools(advanced, primary);
    const backups = this.plugin.settings.providerOrder.slice(1);
    new Setting(advanced).setName("Backup provider").setDesc("Optional. A failed direct request can be sent to this provider. Apple Shortcuts never starts a backup after a handoff.")
      .addDropdown(dropdown => {
        dropdown.selectEl.setAttribute("aria-label", "Backup provider"); dropdown.selectEl.setAttribute("data-ai-focus", "backup");
        dropdown.addOption("none", "None");
        if (backups.length > 1) dropdown.addOption("existing", `Keep existing backups (${backups.length})`);
        for (const id of AI_PROVIDERS) if (id !== primary) dropdown.addOption(id, PROVIDER_LABELS[id]);
        if (backups.includes("apple")) dropdown.addOption("apple", PROVIDER_LABELS.apple);
        dropdown.setValue(backups.length > 1 ? "existing" : backups[0] || "none").setDisabled(!primary).onChange(async value => {
          if (value === "existing" || !primary) return;
          const previous = [...this.plugin.settings.providerOrder];
          this.plugin.settings.providerOrder = [primary, ...(value === "none" ? [] : [value as AiProviderId])];
          try { await this.plugin.saveSettings(); } catch { this.plugin.settings.providerOrder = previous; new Notice("Could not save the backup provider."); }
          this.renderSettings("backup");
        });
      });
    if (backups.length) {
      if (!this.backupEditor || !backups.includes(this.backupEditor)) this.backupEditor = backups[0];
      if (backups.length > 1) new Setting(advanced).setName("Configure existing backup").setDesc(backups.map(id => PROVIDER_LABELS[id]).join(" → "))
        .addDropdown(dropdown => {
          dropdown.selectEl.setAttribute("data-ai-focus", "backup-editor");
          for (const id of backups) dropdown.addOption(id, PROVIDER_LABELS[id]);
          dropdown.setValue(this.backupEditor!).onChange(value => { this.backupEditor = value as AiProviderId; this.renderSettings("backup-editor"); });
        });
      this.renderProvider(advanced.createDiv({ cls: "tps-ai-settings-provider" }), this.backupEditor);
      this.renderOptionalTools(advanced, this.backupEditor);
    }
    new Setting(advanced).setName("Enable logging · This device").setDesc("Log routing without prompts, responses or secrets.")
      .addToggle(toggle => toggle.setValue(this.plugin.settings.enableLogging).onChange(async value => { this.plugin.settings.enableLogging = value; await this.plugin.saveSettings(); }));
    if (focus) { containerEl.scrollTop = scrollTop; containerEl.querySelector<HTMLElement>(`[data-ai-focus="${focus}"]`)?.focus({ preventScroll: true }); }
  }

  private renderOptionalTools(container: HTMLElement, provider: AiProviderId): void {
    if (provider !== "gemini-cli" && provider !== "grok-cli") return;
    const gemini = provider === "gemini-cli";
    textSetting(container, this.plugin, gemini ? "Gemini CLI path" : "Grok Build path", "Usually no change needed. Use an executable name or full path, without arguments.", gemini ? "geminiCliPath" : "grokCliPath");
    textSetting(container, this.plugin, "Model (optional)", "Leave blank for the subscription tool’s default.", gemini ? "geminiCliModel" : "grokCliModel");
  }

  private renderProvider(container: HTMLElement, provider: AiProviderId): void {
    if (provider === "gemini-cli" || provider === "grok-cli") {
      const gemini = provider === "gemini-cli";
      const label = gemini ? "Gemini CLI" : "Grok Build";
      container.createEl("p", { text: gemini
        ? "Gemini CLI requires an eligible Code Assist work account. Google ended personal Google AI Pro/Ultra access to this CLI; those subscriptions now use Antigravity, which this connection does not support."
        : `Use your subscription through ${label} on this Mac. Sign in with an account that includes access to the tool.` });
      if (!Platform.isMacOS) container.createEl("p", { text: "This connection cannot run on iPhone. Choose Apple Shortcuts or an API provider on this device." });
      new Setting(container).setName(`Connect ${gemini ? "Google Gemini" : "Grok"}`)
        .setDesc(gemini ? "Install Gemini CLI 0.65.0 or newer, then sign in with Google in the opened Terminal. Close Terminal after signing in." : "Install current Grok Build, then sign in in the opened Terminal.")
        .addButton(button => button.setButtonText("Setup guide").onClick(() => window.open(gemini ? "https://geminicli.com/docs/get-started/installation/" : "https://github.com/xai-org/grok-build")))
        .addButton(button => button.setButtonText("Connect").setDisabled(!Platform.isMacOS).onClick(async () => {
          button.setDisabled(true);
          try { await openSubscriptionLogin(provider, this.plugin.settings); } catch (error) { new Notice(logger.errorSummary(error)); }
          finally { if (!this.disposed) button.setDisabled(!Platform.isMacOS); }
        }));
    } else if (provider === "apple-shortcuts") {
      container.createEl("p", { text: "In Apple Shortcuts, create a shortcut named TPS AI: add Use Model, choose On-Device or Private Cloud Compute, use Shortcut Input as its prompt, and return the model response as text. Turn off Follow Up. Requires Apple Intelligence on this device. Approve Obsidian’s Open Link prompt and Shortcuts’ output prompt when shown." });
      textSetting(container, this.plugin, "Shortcut name", "Each request opens Shortcuts and returns its answer to Obsidian. Keep Obsidian open; requests are not queued.", "appleShortcutName");
      new Setting(container).setName("Apple setup").addButton(button => button.setButtonText("Setup guide").onClick(() => window.open("https://support.apple.com/guide/shortcuts/use-apple-intelligence-in-shortcuts-tpg3vrvwmclv/ios")));
    } else if (provider === "compatible") {
      container.createEl("p", { text: "Connect an OpenAI-compatible model server or provider. OpenCode is a client; use its provider’s documented API endpoint and credentials here. Subscription-only coding plans may not permit general note requests." });
      textSetting(container, this.plugin, "API base URL", "For example https://api.x.ai/v1 for an xAI API account, or a local server’s /v1 endpoint. This is separate from Grok subscription sign-in.", "compatibleUrl");
      secretReferenceSetting(container, this.plugin, "Provider API key", "Select a device-local secret. Leave the secret empty only for a local server that does not need authentication.", "compatibleApiKeySecret");
      textSetting(container, this.plugin, "Provider model", "Use a model ID offered by your provider.", "compatibleModel");
    } else if (provider === "openai") {
      secretReferenceSetting(container, this.plugin, "OpenAI API key", "API billing is separate from ChatGPT subscriptions.", "openAiApiKeySecret");
      textSetting(container, this.plugin, "OpenAI model", "Structured-output model ID.", "openAiModel");
    } else if (provider === "gemini") {
      secretReferenceSetting(container, this.plugin, "Google AI API key", "This is an AI Studio API connection, billed separately from Google AI Pro/Ultra. Consumer subscription sign-in is not supported here.", "geminiApiKeySecret");
      textSetting(container, this.plugin, "Google AI model", "Hosted Gemini or Gemma model ID. Images and Google Search grounding use this connection.", "geminiModel");
    } else if (provider === "ollama") {
      new Setting(container).setName("Use local Ollama · This device").setDesc("Use an installed open model without a cloud subscription.")
        .addToggle(toggle => toggle.setValue(this.plugin.settings.ollamaEnabled).onChange(async value => { this.plugin.settings.ollamaEnabled = value; await this.plugin.saveSettings(); }));
      textSetting(container, this.plugin, "Ollama URL", "On Mac, localhost uses this Mac. On iPhone, use a secured reachable server.", "ollamaUrl");
      textSetting(container, this.plugin, "Ollama model", "Name of a model installed on that server.", "ollamaModel");
    } else {
      new Setting(container).setName("Retired Apple bridge").setDesc("Choose Apple Intelligence · Shortcuts for a new connection. Existing settings and old queue files have not been changed.");
      return;
    }
    new Setting(container).setName("Test connection").setDesc("Sends only a small synthetic request to this provider. Uses its normal allowance; no note content is sent.")
      .addButton(button => button.setButtonText("Test connection").setDisabled((provider === "gemini-cli" || provider === "grok-cli") && !Platform.isMacOS).onClick(async () => {
        button.setDisabled(true);
        try { await this.plugin.validateProviderChain(provider); } finally { if (!this.disposed) button.setDisabled(false); }
      }));
  }
}

type TextSettingKey = "ollamaUrl" | "ollamaModel" | "openAiModel" | "geminiModel" | "geminiCliPath" | "geminiCliModel" | "grokCliPath" | "grokCliModel" | "compatibleUrl" | "compatibleModel" | "appleShortcutName";
function textSetting(container: HTMLElement, plugin: TpsAiGatewayPlugin, name: string, description: string, key: TextSettingKey): void {
  new Setting(container).setName(name).setDesc(description).addText(text => text.setValue(plugin.settings[key]).onChange(async value => { plugin.settings[key] = value.trim(); await plugin.saveSettings(); }));
}
function secretReferenceSetting(container: HTMLElement, plugin: TpsAiGatewayPlugin, name: string, description: string, key: "openAiApiKeySecret" | "geminiApiKeySecret" | "compatibleApiKeySecret"): void {
  new Setting(container).setName(name).setDesc(description).addComponent(element => new SecretComponent(plugin.app, element).setValue(plugin.settings[key]).onChange(async value => { plugin.settings[key] = value; await plugin.saveSettings(); }));
}
function makeTraceId(taskId: string): string { return `${taskId.replace(/[^a-z0-9_-]+/gi, "-").slice(0, 40)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
