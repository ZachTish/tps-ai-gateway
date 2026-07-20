import type { TPSAiProviderId } from "./tps-ai-gateway-contract";

export type AiProviderId = TPSAiProviderId;

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

export type {
  TPSAiGatewayMessage as AiMessage,
  TPSAiGatewayStructuredRequest as StructuredRequest,
  TPSAiGatewayStructuredResult as StructuredResult,
  TPSAiGatewayDecisionOption as DecisionOption,
  TPSAiGatewayDecisionResult as DecisionResult,
  TPSAiGatewayCapabilityContext as CapabilityContext,
  TPSAiGatewayCapability as GatewayCapability,
  TPSAiGatewayCapabilityProposal as CapabilityProposal,
  TPSAiGatewayApi as TpsAiGatewayApi,
} from "./tps-ai-gateway-contract";
