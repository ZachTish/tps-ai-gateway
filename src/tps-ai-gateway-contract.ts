// Canonical TPS AI Gateway inter-plugin contract.
// Keep this file self-contained so consumers can synchronize it without importing provider internals.

export const TPS_AI_GATEWAY_SERVICE_EVENTS = Object.freeze({
  REQUEST: "tps:ai-gateway-api-request",
  AVAILABLE: "tps:ai-gateway-api-available",
  UNAVAILABLE: "tps:ai-gateway-api-unavailable",
} as const);

export const TPS_AI_GATEWAY_SERVICE_PROTOCOL_VERSION = 1 as const;
export const TPS_AI_GATEWAY_API_VERSION = 1 as const;
export const TPS_AI_GATEWAY_PROVIDER_PLUGIN_ID = "tps-ai-gateway" as const;

export const TPS_AI_GATEWAY_API_CAPABILITIES = Object.freeze({
  structuredCompletion: true as const,
  guardedDecisionSelection: true as const,
  guardedCapabilityExecution: true as const,
});

export type TPSAiProviderId = "ollama" | "openai" | "gemini";

export interface TPSAiGatewayMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface TPSAiGatewayStructuredRequest {
  taskId: string;
  messages: TPSAiGatewayMessage[];
  schema: Record<string, unknown>;
  preferredProviders?: TPSAiProviderId[];
  metadata?: Record<string, string | number | boolean>;
}

export interface TPSAiGatewayStructuredResult<T> {
  data: T;
  provider: TPSAiProviderId;
  model: string;
  traceId: string;
  attempts: number;
}

export interface TPSAiGatewayDecisionOption<T = unknown> {
  id: string;
  label: string;
  description?: string;
  value?: T;
}

export interface TPSAiGatewayDecisionResult<T = unknown>
  extends TPSAiGatewayStructuredResult<{ optionId: string; reason: string }> {
  option: TPSAiGatewayDecisionOption<T>;
}

export interface TPSAiGatewayCapabilityContext {
  sourcePluginId: string;
  traceId: string;
  confirmed: boolean;
}

export interface TPSAiGatewayCapability<TInput = unknown, TOutput = unknown> {
  id: string;
  ownerPluginId: string;
  description: string;
  inputSchema: Record<string, unknown>;
  requiresConfirmation?: boolean;
  execute: (input: TInput, context: TPSAiGatewayCapabilityContext) => Promise<TOutput>;
}

export interface TPSAiGatewayCapabilityProposal<TInput = unknown> {
  capabilityId: string;
  input: TInput;
  reason: string;
  traceId: string;
}

export interface TPSAiGatewayApi {
  readonly apiVersion: 1;
  readonly capabilities: typeof TPS_AI_GATEWAY_API_CAPABILITIES;
  completeStructured<T>(request: TPSAiGatewayStructuredRequest): Promise<TPSAiGatewayStructuredResult<T>>;
  choose<T>(
    request: Omit<TPSAiGatewayStructuredRequest, "schema"> & {
      options: TPSAiGatewayDecisionOption<T>[];
    },
  ): Promise<TPSAiGatewayDecisionResult<T>>;
  registerCapability<TInput, TOutput>(
    capability: TPSAiGatewayCapability<TInput, TOutput>,
  ): () => void;
  listCapabilities(): Array<Pick<
    TPSAiGatewayCapability,
    "id" | "ownerPluginId" | "description" | "inputSchema" | "requiresConfirmation"
  >>;
  proposeCapability<TInput>(
    request: Omit<TPSAiGatewayStructuredRequest, "schema"> & { capabilityIds: string[] },
  ): Promise<TPSAiGatewayCapabilityProposal<TInput>>;
  executeCapability<TOutput>(
    proposal: TPSAiGatewayCapabilityProposal,
    context: Omit<TPSAiGatewayCapabilityContext, "traceId">,
  ): Promise<TOutput>;
}

export interface TPSAiGatewayServiceDescriptor {
  readonly protocolVersion: 1;
  readonly providerPluginId: "tps-ai-gateway";
  readonly api: Readonly<TPSAiGatewayApi>;
}

export interface TPSAiGatewayServiceRequest {
  readonly protocolVersion: 1;
  readonly consumerPluginId: string;
  readonly accept: (descriptor: unknown) => void;
}

export interface TPSAiGatewayApiSnapshot extends TPSAiGatewayApi {
  /** Exact source identity for lifecycle withdrawal. Never inspect it after parsing. */
  readonly sourceApi: object;
}

export interface TPSAiGatewayServiceDescriptorSnapshot {
  readonly protocolVersion: 1;
  readonly providerPluginId: "tps-ai-gateway";
  readonly api: Readonly<TPSAiGatewayApiSnapshot>;
  /** Exact source identity for lifecycle withdrawal. Never inspect it after parsing. */
  readonly sourceDescriptor: object;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function parseTPSAiGatewayApiSnapshot(
  value: unknown,
): Readonly<TPSAiGatewayApiSnapshot> | undefined {
  try {
    if (!isRecord(value)) return undefined;
    const apiVersion = value.apiVersion;
    const capabilitiesValue = value.capabilities;
    const completeStructuredValue = value.completeStructured;
    const chooseValue = value.choose;
    const registerCapabilityValue = value.registerCapability;
    const listCapabilitiesValue = value.listCapabilities;
    const proposeCapabilityValue = value.proposeCapability;
    const executeCapabilityValue = value.executeCapability;
    if (apiVersion !== TPS_AI_GATEWAY_API_VERSION
      || !isRecord(capabilitiesValue)
      || capabilitiesValue.structuredCompletion !== true
      || capabilitiesValue.guardedDecisionSelection !== true
      || capabilitiesValue.guardedCapabilityExecution !== true
      || typeof completeStructuredValue !== "function"
      || typeof chooseValue !== "function"
      || typeof registerCapabilityValue !== "function"
      || typeof listCapabilitiesValue !== "function"
      || typeof proposeCapabilityValue !== "function"
      || typeof executeCapabilityValue !== "function") return undefined;

    const sourceApi = value;
    const completeStructured = completeStructuredValue as TPSAiGatewayApi["completeStructured"];
    const choose = chooseValue as TPSAiGatewayApi["choose"];
    const registerCapability = registerCapabilityValue as TPSAiGatewayApi["registerCapability"];
    const listCapabilities = listCapabilitiesValue as TPSAiGatewayApi["listCapabilities"];
    const proposeCapability = proposeCapabilityValue as TPSAiGatewayApi["proposeCapability"];
    const executeCapability = executeCapabilityValue as TPSAiGatewayApi["executeCapability"];
    return Object.freeze({
      apiVersion: TPS_AI_GATEWAY_API_VERSION,
      capabilities: TPS_AI_GATEWAY_API_CAPABILITIES,
      completeStructured: <T>(request: TPSAiGatewayStructuredRequest) => (
        completeStructured.call(sourceApi, request) as Promise<TPSAiGatewayStructuredResult<T>>
      ),
      choose: <T>(request: Omit<TPSAiGatewayStructuredRequest, "schema"> & {
        options: TPSAiGatewayDecisionOption<T>[];
      }) => choose.call(sourceApi, request) as Promise<TPSAiGatewayDecisionResult<T>>,
      registerCapability: <TInput, TOutput>(capability: TPSAiGatewayCapability<TInput, TOutput>) => {
        const unregister = registerCapability.call(sourceApi, capability);
        if (typeof unregister !== "function") {
          throw new Error("TPS AI Gateway returned an invalid capability unregister callback.");
        }
        let active = true;
        return () => {
          if (!active) return;
          active = false;
          unregister();
        };
      },
      listCapabilities: () => listCapabilities.call(sourceApi),
      proposeCapability: <TInput>(request: Omit<TPSAiGatewayStructuredRequest, "schema"> & {
        capabilityIds: string[];
      }) => proposeCapability.call(sourceApi, request) as Promise<TPSAiGatewayCapabilityProposal<TInput>>,
      executeCapability: <TOutput>(
        proposal: TPSAiGatewayCapabilityProposal,
        context: Omit<TPSAiGatewayCapabilityContext, "traceId">,
      ) => executeCapability.call(sourceApi, proposal, context) as Promise<TOutput>,
      sourceApi,
    });
  } catch {
    return undefined;
  }
}

export function parseTPSAiGatewayServiceDescriptor(
  value: unknown,
): Readonly<TPSAiGatewayServiceDescriptorSnapshot> | undefined {
  try {
    if (!isRecord(value)) return undefined;
    const protocolVersion = value.protocolVersion;
    const providerPluginId = value.providerPluginId;
    if (protocolVersion !== TPS_AI_GATEWAY_SERVICE_PROTOCOL_VERSION
      || providerPluginId !== TPS_AI_GATEWAY_PROVIDER_PLUGIN_ID) return undefined;
    const api = parseTPSAiGatewayApiSnapshot(value.api);
    if (!api) return undefined;
    return Object.freeze({
      protocolVersion,
      providerPluginId,
      api,
      sourceDescriptor: value,
    });
  } catch {
    return undefined;
  }
}

export function parseTPSAiGatewayServiceRequest(
  value: unknown,
): Readonly<TPSAiGatewayServiceRequest> | undefined {
  try {
    if (!isRecord(value)) return undefined;
    const protocolVersion = value.protocolVersion;
    const consumerPluginId = value.consumerPluginId;
    const acceptValue = value.accept;
    if (protocolVersion !== TPS_AI_GATEWAY_SERVICE_PROTOCOL_VERSION
      || typeof consumerPluginId !== "string"
      || consumerPluginId.length === 0
      || consumerPluginId.length > 128
      || consumerPluginId.trim() !== consumerPluginId
      || typeof acceptValue !== "function") return undefined;
    const accept = acceptValue as TPSAiGatewayServiceRequest["accept"];
    return Object.freeze({
      protocolVersion,
      consumerPluginId,
      accept: (descriptor: unknown) => accept.call(value, descriptor),
    });
  } catch {
    return undefined;
  }
}

export function isTPSAiGatewayApi(value: unknown): value is Readonly<TPSAiGatewayApi> {
  return parseTPSAiGatewayApiSnapshot(value) !== undefined;
}

export function isTPSAiGatewayServiceDescriptor(
  value: unknown,
): value is Readonly<TPSAiGatewayServiceDescriptor> {
  return parseTPSAiGatewayServiceDescriptor(value) !== undefined;
}

export function isTPSAiGatewayServiceRequest(
  value: unknown,
): value is Readonly<TPSAiGatewayServiceRequest> {
  return parseTPSAiGatewayServiceRequest(value) !== undefined;
}
