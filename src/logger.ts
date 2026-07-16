let enabled = false;
export const setLogging = (value: boolean) => { enabled = value; };
export const flow = (scope: string, event: string, data: Record<string, unknown> = {}) => { if (enabled) console.log(`[TPS AI Gateway][${scope}] ${event}`, data); };
export const warn = (scope: string, event: string, data: Record<string, unknown> = {}) => console.warn(`[TPS AI Gateway][${scope}] ${event}`, data);
export const metadataSummary = (value: unknown): { metadataFieldCount: number } => ({
  metadataFieldCount: value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value as Record<string, unknown>).length
    : 0,
});
export const errorSummary = (value: unknown, secrets: string[] = []): string => {
  let summary = value instanceof Error ? value.message : String(value || "Unknown error");
  for (const secret of secrets.filter((candidate) => candidate.length >= 4)) summary = summary.split(secret).join("[redacted]");
  summary = summary
    .replace(/([?&](?:key|api_key|token|access_token)=)[^&\s]+/gi, "$1[redacted]")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]+/gi, "$1[redacted]");
  return summary.length > 500 ? `${summary.slice(0, 497)}…` : summary;
};
