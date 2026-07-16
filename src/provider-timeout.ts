import type { AiProviderId } from "./types";

export const PROVIDER_TIMEOUT_MS = 60_000;

export class ProviderTimeoutError extends Error {
  constructor(provider: AiProviderId, timeoutMs: number) {
    super(`${provider} timed out after ${Math.max(1, Math.ceil(timeoutMs / 1000))} seconds.`);
    this.name = "ProviderTimeoutError";
  }
}

export async function withProviderTimeout<T>(
  provider: AiProviderId,
  request: Promise<T>,
  timeoutMs = PROVIDER_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof globalThis.setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = globalThis.setTimeout(() => reject(new ProviderTimeoutError(provider, timeoutMs)), timeoutMs);
  });
  try {
    return await Promise.race([request, timeout]);
  } finally {
    if (timer !== null) globalThis.clearTimeout(timer);
  }
}
