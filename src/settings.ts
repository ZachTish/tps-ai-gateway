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
  geminiModel: "gemma-4-26b-a4b-it",
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

export interface SettingsPersistenceAdapter {
  loadLatest: () => Promise<unknown>;
  saveMerged: (value: Record<string, unknown>) => Promise<void>;
  onPersisted?: (requested: AiGatewaySettings, persisted: AiGatewaySettings) => void;
}

interface SettingsSaveRequest {
  generation: number;
  snapshot: AiGatewaySettings;
  intentKeys: Set<keyof AiGatewaySettings>;
}

interface SettingsSaveWaiter {
  generation: number;
  resolve: () => void;
  reject: (error: unknown) => void;
}

const providerIds: AiProviderId[] = ["ollama", "openai", "gemini"];
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown, fallback: string): string => typeof value === "string" ? value.trim() : fallback;
const valuesMatch = (left: unknown, right: unknown): boolean => JSON.stringify(left) === JSON.stringify(right);
const cloneSettings = (settings: AiGatewaySettings): AiGatewaySettings => JSON.parse(JSON.stringify(settings)) as AiGatewaySettings;

export const asSettingsRecord = (value: unknown): Record<string, unknown> => ({ ...record(value) });

export function sanitizeSettings(value: unknown): AiGatewaySettings {
  const raw = record(value);
  const storedVersion = Number(raw.settingsVersion);
  const settingsVersion = Number.isFinite(storedVersion) && storedVersion > 2 ? storedVersion : 2;
  const order = Array.isArray(raw.providerOrder)
    ? raw.providerOrder.filter((item): item is AiProviderId => providerIds.includes(item as AiProviderId))
    : DEFAULT_SETTINGS.providerOrder;
  return {
    settingsVersion,
    providerOrder: [...new Set(order)],
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

export function changedSettingsKeys(
  baseline: AiGatewaySettings,
  snapshot: AiGatewaySettings,
): Set<keyof AiGatewaySettings> {
  return new Set(
    (Object.keys(DEFAULT_SETTINGS) as Array<keyof AiGatewaySettings>)
      .filter((key) => key !== "settingsVersion" && !valuesMatch(baseline[key], snapshot[key])),
  );
}

export function mergeChangedSettings(
  latestValue: unknown,
  snapshot: AiGatewaySettings,
  changedKeys: ReadonlySet<keyof AiGatewaySettings>,
): Record<string, unknown> {
  const latest = asSettingsRecord(latestValue);
  const merged: Record<string, unknown> = { ...latest };
  for (const key of changedKeys) merged[key] = JSON.parse(JSON.stringify(snapshot[key]));
  const latestVersion = Number(latest.settingsVersion);
  merged.settingsVersion = Number.isFinite(latestVersion) && latestVersion > 2 ? latestVersion : 2;
  return merged;
}

export function createMigratedSettingsPayload(
  rawValue: unknown,
  settings: AiGatewaySettings,
): Record<string, unknown> {
  const migrated: Record<string, unknown> = { ...asSettingsRecord(rawValue), ...settings };
  delete migrated.openAiApiKey;
  delete migrated.geminiApiKey;
  return migrated;
}

/**
 * Serializes settings writes while retaining only the newest requested snapshot.
 * Each persisted snapshot is merged into a fresh disk read so unrelated synced
 * fields and fields introduced by newer plugin versions are never replaced.
 */
export class AiGatewaySettingsSaveCoordinator {
  private baseline: AiGatewaySettings;
  private active: SettingsSaveRequest | null = null;
  private pending: SettingsSaveRequest | null = null;
  private waiters: SettingsSaveWaiter[] = [];
  private uncertainKeys = new Set<keyof AiGatewaySettings>();
  private generation = 0;
  private running = false;

  constructor(
    private readonly adapter: SettingsPersistenceAdapter,
    baseline: AiGatewaySettings,
  ) {
    this.baseline = cloneSettings(baseline);
  }

  setBaseline(settings: AiGatewaySettings): void {
    this.baseline = cloneSettings(settings);
  }

  request(settings: AiGatewaySettings): Promise<void> {
    const snapshot = cloneSettings(settings);
    const intentKeys = this.active
      ? new Set(this.active.intentKeys)
      : changedSettingsKeys(this.baseline, snapshot);
    if (this.active) {
      for (const key of changedSettingsKeys(this.active.snapshot, snapshot)) intentKeys.add(key);
    }
    for (const key of this.uncertainKeys) intentKeys.add(key);
    const request: SettingsSaveRequest = {
      generation: ++this.generation,
      snapshot,
      intentKeys,
    };
    this.pending = request;
    const completed = new Promise<void>((resolve, reject) => {
      this.waiters.push({ generation: request.generation, resolve, reject });
    });
    if (!this.running) {
      this.running = true;
      void this.drain();
    }
    return completed;
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending) {
        const requested = this.pending;
        this.pending = null;
        this.active = requested;
        const changedKeys = new Set(requested.intentKeys);
        for (const key of this.uncertainKeys) changedKeys.add(key);
        try {
          const latest = await this.adapter.loadLatest();
          const merged = mergeChangedSettings(latest, requested.snapshot, changedKeys);
          if (changedKeys.size > 0) await this.adapter.saveMerged(merged);
          const persisted = sanitizeSettings(merged);
          this.baseline = cloneSettings(persisted);
          for (const key of changedKeys) this.uncertainKeys.delete(key);
          this.rebasePending(persisted);
          this.active = null;
          this.adapter.onPersisted?.(requested.snapshot, persisted);
          this.resolveThrough(requested.generation);
        } catch (error) {
          // A rejected write can have an uncertain disk outcome. Force the next
          // snapshot's values for these fields even when they match our baseline.
          for (const key of changedKeys) this.uncertainKeys.add(key);
          // A newer complete snapshot supersedes a failed older attempt. Keep its
          // callers waiting until that newer state is durably saved.
          this.active = null;
          if (this.pending) continue;
          this.rejectThrough(requested.generation, error);
        }
      }
    } finally {
      this.running = false;
      // This guard also covers a request added as the previous drain completed.
      if (this.pending) {
        this.running = true;
        void this.drain();
      }
    }
  }

  private rebasePending(persisted: AiGatewaySettings): void {
    if (!this.pending) return;
    for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof AiGatewaySettings>) {
      if (this.pending.intentKeys.has(key)) {
        if (valuesMatch(this.pending.snapshot[key], persisted[key])) this.pending.intentKeys.delete(key);
        continue;
      }
      (this.pending.snapshot as any)[key] = JSON.parse(JSON.stringify(persisted[key]));
    }
  }

  private resolveThrough(generation: number): void {
    const completed = this.waiters.filter((waiter) => waiter.generation <= generation);
    this.waiters = this.waiters.filter((waiter) => waiter.generation > generation);
    for (const waiter of completed) waiter.resolve();
  }

  private rejectThrough(generation: number, error: unknown): void {
    const failed = this.waiters.filter((waiter) => waiter.generation <= generation);
    this.waiters = this.waiters.filter((waiter) => waiter.generation > generation);
    for (const waiter of failed) waiter.reject(error);
  }
}

export function reconcilePersistedSettings(
  live: AiGatewaySettings,
  requested: AiGatewaySettings,
  persisted: AiGatewaySettings,
): void {
  for (const key of Object.keys(DEFAULT_SETTINGS) as Array<keyof AiGatewaySettings>) {
    if (!valuesMatch(live[key], requested[key])) continue;
    (live as any)[key] = JSON.parse(JSON.stringify(persisted[key]));
  }
}

export function planLegacyApiKeyMigration(
  value: unknown,
  settings: AiGatewaySettings,
  readSecret: (name: string) => string | null,
): SettingsMigrationPlan {
  const raw = record(value);
  const storedVersion = Number(raw.settingsVersion);
  if (Number.isFinite(storedVersion) && storedVersion > 2) {
    return { writes: [], shouldPersist: false };
  }
  const candidates: Array<LegacyApiKeyMigration> = [
    { provider: "openai", secretName: settings.openAiApiKeySecret, value: string(raw.openAiApiKey, "") },
    { provider: "gemini", secretName: settings.geminiApiKeySecret, value: string(raw.geminiApiKey, "") },
  ];
  const writes = candidates.filter(({ secretName, value: legacyValue }) => (
    Boolean(legacyValue) && !String(readSecret(secretName) || "").trim()
  ));
  const shouldPersist = storedVersion !== 2
    || Object.prototype.hasOwnProperty.call(raw, "openAiApiKey")
    || Object.prototype.hasOwnProperty.call(raw, "geminiApiKey")
    || typeof raw.openAiApiKeySecret !== "string"
    || typeof raw.geminiApiKeySecret !== "string";
  return { writes, shouldPersist };
}
