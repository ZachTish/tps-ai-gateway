export type AiProviderId = "ollama" | "openai" | "gemini";

export interface AiGatewaySettings {
  settingsVersion: number;
  providerOrder: AiProviderId[];
  ollamaEnabled: boolean;
  ollamaUrl: string;
  ollamaModel: string;
  openAiApiKeySecret: string;
  openAiModel: string;
  geminiApiKeySecret: string;
  geminiModel: string;
  enableLogging: boolean;
}

export interface AiProviderCredentials {
  openAiApiKey: string;
  geminiApiKey: string;
}

export interface AiMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AiInlineMedia {
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  data: string;
}

export interface StructuredRequest {
  taskId: string;
  messages: AiMessage[];
  schema: Record<string, unknown>;
  /**
   * Stable caller-owned id for text work that must survive an app close. Durable
   * requests are written to the synced queue and may be completed by any device
   * with an eligible local cloud credential.
   */
  durableJobId?: string;
  media?: AiInlineMedia[];
  preferredProviders?: AiProviderId[];
  metadata?: Record<string, string | number | boolean>;
}

export interface StructuredResult<T> {
  data: T;
  provider: AiProviderId;
  model: string;
  traceId: string;
  attempts: number;
}

export interface DecisionOption<T = unknown> {
  id: string;
  label: string;
  description?: string;
  value?: T;
}

export interface DecisionResult<T = unknown> extends StructuredResult<{ optionId: string; reason: string }> {
  option: DecisionOption<T>;
}

export interface CapabilityContext {
  sourcePluginId: string;
  traceId: string;
  confirmed: boolean;
}

export interface GatewayCapability<TInput = unknown, TOutput = unknown> {
  id: string;
  ownerPluginId: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requiresConfirmation?: boolean;
  execute: (input: TInput, context: CapabilityContext) => Promise<TOutput>;
}

export interface CapabilityProposal<TInput = unknown> {
  capabilityId: string;
  input: TInput;
  reason: string;
  traceId: string;
}

export interface TpsAiGatewayApi {
  completeStructured<T>(request: StructuredRequest): Promise<StructuredResult<T>>;
  choose<T>(request: Omit<StructuredRequest, "schema"> & { options: DecisionOption<T>[] }): Promise<DecisionResult<T>>;
  registerCapability<TInput, TOutput>(capability: GatewayCapability<TInput, TOutput>): () => void;
  listCapabilities(): Array<Pick<GatewayCapability, "id" | "ownerPluginId" | "description" | "inputSchema" | "requiresConfirmation">>;
  proposeCapability<TInput>(request: Omit<StructuredRequest, "schema"> & { capabilityIds: string[] }): Promise<CapabilityProposal<TInput>>;
  executeCapability<TOutput>(proposal: CapabilityProposal, context: Omit<CapabilityContext, "traceId">): Promise<TOutput>;
}
