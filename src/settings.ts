import type { AiGatewaySettings, AiProviderId } from "./types";

export const OPENAI_API_KEY_SECRET = "tps-ai-gateway-openai-api-key";
export const GEMINI_API_KEY_SECRET = "tps-ai-gateway-gemini-api-key";

export const DEFAULT_SETTINGS: AiGatewaySettings = {
  settingsVersion: 2,
  providerOrder: ["ollama", "openai", "gemini"],
  ollamaEnabled: true,
  ollamaUrl: "http://127.0.0.1:11434",
  ollamaModel: "gemma3:12b",
  openAiApiKeySecret: OPENAI_API_KEY_SECRET,
  openAiModel: "gpt-5-mini",
  geminiApiKeySecret: GEMINI_API_KEY_SECRET,
  geminiModel: "gemini-2.5-flash",
  enableLogging: false,
};

export interface LegacyApiKeyMigration {
  provider: "openai" | "gemini";
  secretName: string;
  value: string;
}

export interface SettingsMigrationPlan {
  writes: LegacyApiKeyMigration[];
  shouldPersist: boolean;
}

const providerIds: AiProviderId[] = ["ollama", "openai", "gemini"];
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown, fallback: string): string => typeof value === "string" ? value.trim() || fallback : fallback;

export function sanitizeSettings(value: unknown): AiGatewaySettings {
  const raw = record(value);
  const order = Array.isArray(raw.providerOrder)
    ? raw.providerOrder.filter((item): item is AiProviderId => providerIds.includes(item as AiProviderId))
    : [];
  return {
    settingsVersion: 2,
    providerOrder: [...new Set([...order, ...providerIds])],
    ollamaEnabled: typeof raw.ollamaEnabled === "boolean" ? raw.ollamaEnabled : DEFAULT_SETTINGS.ollamaEnabled,
    ollamaUrl: string(raw.ollamaUrl, DEFAULT_SETTINGS.ollamaUrl).replace(/\/+$/, ""),
    ollamaModel: string(raw.ollamaModel, DEFAULT_SETTINGS.ollamaModel),
    openAiApiKeySecret: string(raw.openAiApiKeySecret, DEFAULT_SETTINGS.openAiApiKeySecret),
    openAiModel: string(raw.openAiModel, DEFAULT_SETTINGS.openAiModel),
    geminiApiKeySecret: string(raw.geminiApiKeySecret, DEFAULT_SETTINGS.geminiApiKeySecret),
    geminiModel: string(raw.geminiModel, DEFAULT_SETTINGS.geminiModel),
    enableLogging: typeof raw.enableLogging === "boolean" ? raw.enableLogging : false,
  };
}

export function planLegacyApiKeyMigration(
  value: unknown,
  settings: AiGatewaySettings,
  readSecret: (name: string) => string | null,
): SettingsMigrationPlan {
  const raw = record(value);
  const candidates: Array<LegacyApiKeyMigration> = [
    { provider: "openai", secretName: settings.openAiApiKeySecret, value: string(raw.openAiApiKey, "") },
    { provider: "gemini", secretName: settings.geminiApiKeySecret, value: string(raw.geminiApiKey, "") },
  ];
  const writes = candidates.filter(({ secretName, value: legacyValue }) => (
    Boolean(legacyValue) && !String(readSecret(secretName) || "").trim()
  ));
  const shouldPersist = raw.settingsVersion !== 2
    || Object.prototype.hasOwnProperty.call(raw, "openAiApiKey")
    || Object.prototype.hasOwnProperty.call(raw, "geminiApiKey")
    || typeof raw.openAiApiKeySecret !== "string"
    || typeof raw.geminiApiKeySecret !== "string";
  return { writes, shouldPersist };
}
