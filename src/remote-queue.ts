import type { AiGroundingMode, AiMessage, AiProviderId, StructuredResult } from "./types";

export const REMOTE_AI_QUEUE_FOLDER = "_assets/TPS AI Queue";
export const REMOTE_AI_WAIT_TIMEOUT_MS = 20 * 60 * 1000;
export const REMOTE_AI_CLAIM_TIMEOUT_MS = 10 * 60 * 1000;
export const REMOTE_AI_RETENTION_MS = 48 * 60 * 60 * 1000;

export interface RemoteAiJob {
  version: 1;
  id: string;
  taskId: string;
  requesterDeviceId: string;
  createdAt: string;
  updatedAt: string;
  status: "pending" | "processing" | "complete" | "failed";
  durable?: boolean;
  messages: AiMessage[];
  schema: Record<string, unknown>;
  grounding?: AiGroundingMode;
  preferredProviders?: AiProviderId[];
  metadata?: Record<string, string | number | boolean>;
  controllerDeviceId?: string;
  startedAt?: string;
  result?: StructuredResult<unknown>;
  error?: string;
}

export function remoteAiJobPath(id: string): string {
  return `${REMOTE_AI_QUEUE_FOLDER}/${id.replace(/[^a-z0-9_-]+/gi, "-")}.md`;
}

export function parseRemoteAiJob(value: string): RemoteAiJob | null {
  try {
    const job = JSON.parse(value) as Partial<RemoteAiJob>;
    if (job.version !== 1 || !job.id || !job.taskId || !job.requesterDeviceId || !job.createdAt || !job.updatedAt) return null;
    if (!Array.isArray(job.messages) || !job.messages.length || !job.schema || typeof job.schema !== "object") return null;
    if (!job.status || !["pending", "processing", "complete", "failed"].includes(job.status)) return null;
    return job as RemoteAiJob;
  } catch {
    return null;
  }
}

export function remoteAiJobIsClaimable(job: RemoteAiJob, now = Date.now()): boolean {
  if (job.status === "pending") return true;
  if (job.status !== "processing" || !job.startedAt) return false;
  const startedAt = Date.parse(job.startedAt);
  return !Number.isFinite(startedAt) || now - startedAt >= REMOTE_AI_CLAIM_TIMEOUT_MS;
}

export function remoteAiJobIsExpired(job: RemoteAiJob, now = Date.now()): boolean {
  const updatedAt = Date.parse(job.updatedAt);
  return Number.isFinite(updatedAt) && now - updatedAt >= REMOTE_AI_RETENTION_MS;
}
