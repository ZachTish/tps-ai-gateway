import type { AiMessage, AiProviderId, StructuredResult } from "./types";
import type {
  TPSNotifierConsumerDeliveryResult,
  TPSNotifierConsumerDeliveryState,
  TPSNotifierConsumerEvidence,
  TPSNotifierConsumerTransport,
  TPSNotifierErrorCode,
} from "./tps-notifier-contract";

export const REMOTE_AI_QUEUE_FOLDER = "_assets/TPS AI Queue";
export const REMOTE_AI_WAIT_TIMEOUT_MS = 20 * 60 * 1000;
export const REMOTE_AI_CLAIM_TIMEOUT_MS = 10 * 60 * 1000;
export const REMOTE_AI_MAX_JOB_FILE_BYTES = 2 * 1024 * 1024;
export const REMOTE_AI_MAX_JOB_JSON_CHARS = 2 * 1024 * 1024;
export const REMOTE_AI_MAX_MESSAGE_CHARS = 256 * 1024;
export const REMOTE_AI_MAX_TOTAL_MESSAGE_CHARS = 512 * 1024;
export const REMOTE_AI_MAX_SCHEMA_DEPTH = 64;
export const REMOTE_AI_MAX_SCHEMA_NODES = 4096;
export const REMOTE_AI_MAX_SCHEMA_STRING_CHARS = 128 * 1024;
export const REMOTE_AI_MAX_RESULT_DEPTH = 64;
export const REMOTE_AI_MAX_RESULT_NODES = 50_000;
export const REMOTE_AI_MAX_RESULT_STRING_CHARS = 512 * 1024;
export const REMOTE_AI_JOB_LIFECYCLE_RESERVE_BYTES = 16 * 1024;

export interface RemoteAiNotificationAttempt {
  state: "attempting";
  attemptId: string;
  attemptCount: number;
  updatedAt: string;
}

export interface RemoteAiNotificationOutcome {
  state: Exclude<TPSNotifierConsumerDeliveryState, "attempting">;
  attemptId?: string;
  attemptCount: number;
  updatedAt: string;
  transport: TPSNotifierConsumerTransport;
  evidence: TPSNotifierConsumerEvidence;
  attempted: boolean | "unknown";
  code?: TPSNotifierErrorCode;
  httpStatus?: number;
  providerMessageId?: string;
}

export type RemoteAiNotificationDelivery = RemoteAiNotificationAttempt | RemoteAiNotificationOutcome;

export type RemoteAiCompletionNotification =
  | {
    version: 1;
    policy: "suppressed";
  }
  | {
    version: 1;
    policy: "send";
    delivery: RemoteAiNotificationDelivery;
  };

export interface RemoteAiJob {
  version: 1;
  revision?: number;
  id: string;
  taskId: string;
  requesterDeviceId: string;
  createdAt: string;
  updatedAt: string;
  status: "pending" | "processing" | "complete" | "failed";
  messages: AiMessage[];
  schema: Record<string, unknown>;
  preferredProviders?: AiProviderId[];
  metadata?: Record<string, string | number | boolean>;
  controllerDeviceId?: string;
  claimId?: string;
  startedAt?: string;
  result?: StructuredResult<unknown>;
  error?: string;
  completionNotification?: RemoteAiCompletionNotification;
}

const NOTIFICATION_STATES = new Set<TPSNotifierConsumerDeliveryState>([
  "attempting",
  "accepted",
  "legacy-accepted",
  "rejected",
  "not-attempted",
  "unknown",
]);

const NOTIFICATION_TRANSPORTS = new Set<TPSNotifierConsumerTransport>([
  "notifier-v2",
  "notifier-v1",
  "unavailable",
  "unknown",
]);

const NOTIFICATION_EVIDENCE = new Set<string>([
  "structured-receipt",
  "structured-rejection",
  "structured-not-attempted",
  "unconfirmed",
  "legacy-promise-resolved",
  "legacy-rejection",
  "service-unavailable",
  "malformed-v2-result",
  "unclassified-v2-failure",
  "interrupted",
  "legacy-untracked",
  "invalid-record",
  "consumer-timeout",
]);

const NOTIFIER_ERROR_CODES = new Set<TPSNotifierErrorCode>([
  "not-ready",
  "settings-read-only",
  "delivery-disabled",
  "delivery-invalidated",
  "transport-dirty",
  "invalid-configuration",
  "invalid-payload",
  "internal-error",
  "delivery-busy",
  "delivery-rejected",
  "delivery-unconfirmed",
]);

const AI_PROVIDERS = new Set<AiProviderId>(["ollama", "openai", "gemini"]);
const AI_MESSAGE_ROLES = new Set(["system", "user", "assistant"]);

const isRecord = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const isBoundedString = (value: unknown, max: number): value is string => (
  typeof value === "string" && value.length > 0 && value.length <= max
);

const isIsoTimestamp = (value: unknown): value is string => {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
};

interface JsonValueBudget {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxStringChars: number;
}

function isJsonValueWithinBudget(value: unknown, budget: JsonValueBudget): boolean {
  try {
    const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
    let nodes = 0;
    let stringChars = 0;
    while (stack.length) {
      const current = stack.pop()!;
      nodes += 1;
      if (nodes > budget.maxNodes || current.depth > budget.maxDepth) return false;
      if (current.value === null || typeof current.value === "boolean") continue;
      if (typeof current.value === "number") {
        if (!Number.isFinite(current.value)) return false;
        continue;
      }
      if (typeof current.value === "string") {
        stringChars += current.value.length;
        if (stringChars > budget.maxStringChars) return false;
        continue;
      }
      if (Array.isArray(current.value)) {
        if (current.value.length > budget.maxNodes - nodes - stack.length) return false;
        for (let index = 0; index < current.value.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(current.value, String(index));
          if (!descriptor || !("value" in descriptor)) return false;
          stack.push({ value: descriptor.value, depth: current.depth + 1 });
        }
        continue;
      }
      if (!isRecord(current.value)) return false;
      for (const key in current.value) {
        if (!Object.prototype.hasOwnProperty.call(current.value, key)) continue;
        if (nodes + stack.length >= budget.maxNodes) return false;
        stringChars += key.length;
        if (stringChars > budget.maxStringChars) return false;
        const descriptor = Object.getOwnPropertyDescriptor(current.value, key);
        if (!descriptor || !("value" in descriptor)) return false;
        stack.push({ value: descriptor.value, depth: current.depth + 1 });
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function remoteAiSchemaIsWithinBudget(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && isJsonValueWithinBudget(value, {
    maxDepth: REMOTE_AI_MAX_SCHEMA_DEPTH,
    maxNodes: REMOTE_AI_MAX_SCHEMA_NODES,
    maxStringChars: REMOTE_AI_MAX_SCHEMA_STRING_CHARS,
  });
}

export function remoteAiResultDataIsWithinBudget(value: unknown): boolean {
  return isJsonValueWithinBudget(value, {
    maxDepth: REMOTE_AI_MAX_RESULT_DEPTH,
    maxNodes: REMOTE_AI_MAX_RESULT_NODES,
    maxStringChars: REMOTE_AI_MAX_RESULT_STRING_CHARS,
  });
}

export function remoteAiJobFileSizeIsAllowed(size: number): boolean {
  return Number.isSafeInteger(size) && size >= 0 && size <= REMOTE_AI_MAX_JOB_FILE_BYTES;
}

export function remoteAiJobSerializedSizeIsAllowed(value: string, reserveBytes = 0): boolean {
  if (!Number.isSafeInteger(reserveBytes)
    || reserveBytes < 0
    || reserveBytes > REMOTE_AI_MAX_JOB_FILE_BYTES) return false;
  return value.length <= REMOTE_AI_MAX_JOB_JSON_CHARS - reserveBytes
    && new TextEncoder().encode(value).byteLength <= REMOTE_AI_MAX_JOB_FILE_BYTES - reserveBytes;
}

function remoteAiMessagesAreWithinBudget(value: unknown): value is AiMessage[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 128) return false;
  let totalMessageChars = 0;
  for (const message of value) {
    if (!isRecord(message)
      || !AI_MESSAGE_ROLES.has(String(message.role))
      || typeof message.content !== "string"
      || message.content.length > REMOTE_AI_MAX_MESSAGE_CHARS) return false;
    totalMessageChars += message.content.length;
    if (totalMessageChars > REMOTE_AI_MAX_TOTAL_MESSAGE_CHARS) return false;
  }
  return true;
}

function remoteAiProvidersAreValid(value: unknown): value is AiProviderId[] | undefined {
  return value === undefined
    || (Array.isArray(value)
      && value.length <= AI_PROVIDERS.size
      && value.every((provider) => AI_PROVIDERS.has(provider as AiProviderId)));
}

function remoteAiMetadataIsValid(value: unknown): value is RemoteAiJob["metadata"] {
  if (value === undefined) return true;
  if (!isRecord(value) || Object.keys(value).length > 64) return false;
  for (const [key, metadataValue] of Object.entries(value)) {
    if (!isBoundedString(key, 128)
      || (typeof metadataValue === "string" && metadataValue.length > 4096)
      || (typeof metadataValue === "number" && !Number.isFinite(metadataValue))
      || (typeof metadataValue !== "string"
        && typeof metadataValue !== "number"
        && typeof metadataValue !== "boolean")) return false;
  }
  return true;
}

export function remoteAiRequestPayloadIsWithinBudget(value: Readonly<{
  messages: unknown;
  schema: unknown;
  preferredProviders?: unknown;
  metadata?: unknown;
}>): boolean {
  return remoteAiMessagesAreWithinBudget(value.messages)
    && remoteAiSchemaIsWithinBudget(value.schema)
    && remoteAiProvidersAreValid(value.preferredProviders)
    && remoteAiMetadataIsValid(value.metadata);
}

function hasNoProviderDetails(value: Record<string, unknown>): boolean {
  return value.code === undefined && value.httpStatus === undefined && value.providerMessageId === undefined;
}

function hasValidNotificationOutcomeSemantics(value: Record<string, unknown>): boolean {
  switch (value.evidence) {
    case "structured-receipt":
      return value.state === "accepted"
        && value.transport === "notifier-v2"
        && value.attempted === true
        && value.code === undefined
        && typeof value.httpStatus === "number"
        && value.httpStatus >= 200
        && value.httpStatus < 300
        && typeof value.providerMessageId === "string";
    case "structured-rejection":
      return value.state === "rejected"
        && value.transport === "notifier-v2"
        && value.attempted === true
        && value.code !== undefined
        && value.providerMessageId === undefined;
    case "structured-not-attempted":
      return value.state === "not-attempted"
        && value.transport === "notifier-v2"
        && value.attempted === false
        && value.code !== undefined
        && value.providerMessageId === undefined;
    case "unconfirmed":
      return value.state === "unknown"
        && value.transport === "notifier-v2"
        && value.attempted === true
        && value.code !== undefined
        && value.providerMessageId === undefined;
    case "legacy-promise-resolved":
      return value.state === "legacy-accepted"
        && value.transport === "notifier-v1"
        && value.attempted === true
        && hasNoProviderDetails(value);
    case "legacy-rejection":
      return value.state === "unknown"
        && value.transport === "notifier-v1"
        && value.attempted === "unknown"
        && hasNoProviderDetails(value);
    case "service-unavailable":
      return value.state === "not-attempted"
        && value.transport === "unavailable"
        && value.attempted === false
        && hasNoProviderDetails(value);
    case "malformed-v2-result":
    case "unclassified-v2-failure":
      return value.state === "unknown"
        && value.transport === "notifier-v2"
        && value.attempted === "unknown"
        && hasNoProviderDetails(value);
    case "consumer-timeout":
      return value.state === "unknown"
        && (value.transport === "notifier-v2" || value.transport === "notifier-v1")
        && value.attempted === "unknown"
        && hasNoProviderDetails(value);
    case "interrupted":
      return hasNoProviderDetails(value)
        && ((value.state === "not-attempted"
            && value.transport === "unavailable"
            && value.attempted === false)
          || (value.state === "unknown"
            && value.transport === "unknown"
            && value.attempted === "unknown"));
    case "legacy-untracked":
    case "invalid-record":
      return value.state === "unknown"
        && value.transport === "unknown"
        && value.attempted === "unknown"
        && hasNoProviderDetails(value);
    default:
      return false;
  }
}

function isNotificationDelivery(value: unknown): value is RemoteAiNotificationDelivery {
  if (!isRecord(value)
    || typeof value.state !== "string"
    || !NOTIFICATION_STATES.has(value.state as TPSNotifierConsumerDeliveryState)
    || !Number.isInteger(value.attemptCount)
    || (value.attemptCount as number) < 0
    || !isIsoTimestamp(value.updatedAt)) return false;

  if (value.state === "attempting") {
    return (value.attemptCount as number) > 0
      && typeof value.attemptId === "string"
      && value.attemptId.length > 0
      && value.attemptId.length <= 256;
  }

  if (typeof value.transport !== "string"
    || !NOTIFICATION_TRANSPORTS.has(value.transport as TPSNotifierConsumerTransport)
    || typeof value.evidence !== "string"
    || !NOTIFICATION_EVIDENCE.has(value.evidence as TPSNotifierConsumerEvidence)
    || (typeof value.attempted !== "boolean" && value.attempted !== "unknown")) return false;
  if (value.attemptId !== undefined
    && (typeof value.attemptId !== "string" || !value.attemptId || value.attemptId.length > 256)) return false;
  if (value.code !== undefined
    && (typeof value.code !== "string" || !NOTIFIER_ERROR_CODES.has(value.code as TPSNotifierErrorCode))) return false;
  if (value.httpStatus !== undefined
    && (!Number.isInteger(value.httpStatus)
      || (value.httpStatus as number) < 100
      || (value.httpStatus as number) > 599)) return false;
  if (value.providerMessageId !== undefined
    && (typeof value.providerMessageId !== "string"
      || !value.providerMessageId
      || value.providerMessageId.length > 256)) return false;
  const untracked = value.evidence === "legacy-untracked" || value.evidence === "invalid-record";
  if (untracked !== (value.attemptCount === 0)) return false;
  if (!untracked && !isBoundedString(value.attemptId, 256)) return false;
  return hasValidNotificationOutcomeSemantics(value);
}

function isCompletionNotification(value: unknown): value is RemoteAiCompletionNotification {
  if (!isRecord(value) || value.version !== 1) return false;
  if (value.policy === "suppressed") return value.delivery === undefined;
  return value.policy === "send" && isNotificationDelivery(value.delivery);
}

export function remoteAiJobPath(id: string): string {
  return `${REMOTE_AI_QUEUE_FOLDER}/${id.replace(/[^a-z0-9_-]+/gi, "-")}.md`;
}

export function parseRemoteAiJob(value: string): RemoteAiJob | null {
  try {
    if (!remoteAiJobSerializedSizeIsAllowed(value)) return null;
    const job = JSON.parse(value) as Record<string, unknown>;
    if (!isRecord(job)
      || job.version !== 1
      || !isBoundedString(job.id, 256)
      || !isBoundedString(job.taskId, 256)
      || !isBoundedString(job.requesterDeviceId, 256)
      || !isIsoTimestamp(job.createdAt)
      || !isIsoTimestamp(job.updatedAt)) return null;
    if (job.revision !== undefined
      && (!Number.isSafeInteger(job.revision) || (job.revision as number) < 0)) return null;
    if (!remoteAiRequestPayloadIsWithinBudget({
      messages: job.messages,
      schema: job.schema,
      preferredProviders: job.preferredProviders,
      metadata: job.metadata,
    })) return null;
    if (job.status !== "pending" && job.status !== "processing"
      && job.status !== "complete" && job.status !== "failed") return null;
    if (job.controllerDeviceId !== undefined && !isBoundedString(job.controllerDeviceId, 256)) return null;
    if (job.claimId !== undefined && !isBoundedString(job.claimId, 256)) return null;
    if (job.startedAt !== undefined && !isIsoTimestamp(job.startedAt)) return null;
    if (job.status === "pending"
      && (job.result !== undefined
        || job.error !== undefined
        || job.completionNotification !== undefined)) return null;
    if (job.status === "processing"
      && (!isBoundedString(job.controllerDeviceId, 256)
        || !isBoundedString(job.claimId, 256)
        || !isIsoTimestamp(job.startedAt)
        || job.result !== undefined
        || job.error !== undefined
        || job.completionNotification !== undefined)) return null;
    if (job.status === "complete" && (!isStructuredResult(job.result) || job.error !== undefined)) return null;
    if (job.status === "failed"
      && (!isBoundedString(job.error, 4096) || job.result !== undefined)) return null;
    if (job.completionNotification !== undefined
      && !isCompletionNotification(job.completionNotification)) return null;
    return job as unknown as RemoteAiJob;
  } catch {
    return null;
  }
}

function isStructuredResult(value: unknown): boolean {
  if (!isRecord(value)
    || !AI_PROVIDERS.has(value.provider as AiProviderId)
    || !isBoundedString(value.model, 256)
    || !isBoundedString(value.traceId, 256)
    || !Number.isSafeInteger(value.attempts)
    || (value.attempts as number) < 1
    || (value.attempts as number) > 1000) return false;
  return Object.prototype.hasOwnProperty.call(value, "data")
    && remoteAiResultDataIsWithinBudget(value.data);
}

export interface AtomicRemoteAiJobStore<TFile> {
  process(file: TFile, update: (data: string) => string): Promise<string>;
}

export interface AtomicRemoteAiJobTransitionResult {
  readonly changed: boolean;
  readonly job: RemoteAiJob | null;
}

export async function transitionRemoteAiJobFile<TFile>(
  store: AtomicRemoteAiJobStore<TFile>,
  file: TFile,
  transition: (current: RemoteAiJob) => RemoteAiJob | null,
): Promise<AtomicRemoteAiJobTransitionResult> {
  let changed = false;
  let job: RemoteAiJob | null = null;
  await store.process(file, (data) => {
    const current = parseRemoteAiJob(data);
    if (!current) {
      job = null;
      return data;
    }
    const next = transition(current);
    if (!next) {
      job = current;
      return data;
    }
    const serialized = JSON.stringify(next, null, 2);
    if (!remoteAiJobSerializedSizeIsAllowed(serialized)) {
      throw new Error("Remote AI transition exceeded the queue file-size budget.");
    }
    const validated = parseRemoteAiJob(serialized);
    if (!validated) throw new Error("Remote AI transition produced an invalid job.");
    changed = true;
    job = validated;
    return serialized;
  });
  return { changed, job };
}

export function nextRemoteAiJobRevision(job: RemoteAiJob): number {
  return (job.revision ?? 0) + 1;
}

export function remoteAiJobWantsCompletionNotification(job: RemoteAiJob): boolean {
  return job.metadata?.notifyOnCompletion !== false;
}

export function suppressRemoteAiCompletionNotification(job: RemoteAiJob): RemoteAiJob {
  return {
    ...job,
    completionNotification: {
      version: 1,
      policy: "suppressed",
    },
  };
}

export function beginRemoteAiNotificationAttempt(
  job: RemoteAiJob,
  attemptId: string,
  now = new Date().toISOString(),
): RemoteAiJob {
  if (job.status !== "complete" && job.status !== "failed") {
    throw new Error("Only terminal remote AI jobs can begin completion notification delivery.");
  }
  if (!attemptId || attemptId.length > 256) throw new Error("A bounded notification attempt id is required.");
  const previousAttemptCount = job.completionNotification?.policy === "send"
    ? job.completionNotification.delivery.attemptCount
    : 0;
  return {
    ...job,
    completionNotification: {
      version: 1,
      policy: "send",
      delivery: {
        state: "attempting",
        attemptId,
        attemptCount: previousAttemptCount + 1,
        updatedAt: now,
      },
    },
  };
}

export function settleRemoteAiNotificationAttempt(
  job: RemoteAiJob,
  attemptId: string,
  result: TPSNotifierConsumerDeliveryResult,
  now = new Date().toISOString(),
): RemoteAiJob | null {
  if (job.status !== "complete" && job.status !== "failed") return null;
  const notification = job.completionNotification;
  if (notification?.policy !== "send"
    || notification.delivery.state !== "attempting"
    || notification.delivery.attemptId !== attemptId) return null;
  let delivery: RemoteAiNotificationOutcome;
  try {
    delivery = {
      state: result.state,
      attemptId,
      attemptCount: notification.delivery.attemptCount,
      updatedAt: now,
      transport: result.transport,
      evidence: result.evidence,
      attempted: result.attempted,
      ...(result.code === undefined ? {} : { code: result.code }),
      ...(result.httpStatus === undefined ? {} : { httpStatus: result.httpStatus }),
      ...(result.providerMessageId === undefined ? {} : { providerMessageId: result.providerMessageId }),
    };
  } catch {
    return null;
  }
  if (!isNotificationDelivery(delivery)) return null;
  return {
    ...job,
    completionNotification: {
      version: 1,
      policy: "send",
      delivery,
    },
  };
}

export function recoverRemoteAiNotificationState(
  job: RemoteAiJob,
  now = new Date().toISOString(),
): { job: RemoteAiJob; changed: boolean } {
  if (job.status !== "complete" && job.status !== "failed") return { job, changed: false };
  if (!job.completionNotification) {
    if (!remoteAiJobWantsCompletionNotification(job)) {
      return { job: suppressRemoteAiCompletionNotification(job), changed: true };
    }
    return {
      changed: true,
      job: {
        ...job,
        completionNotification: {
          version: 1,
          policy: "send",
          delivery: {
            state: "unknown",
            attemptCount: 0,
            updatedAt: now,
            transport: "unknown",
            evidence: "legacy-untracked",
            attempted: "unknown",
          },
        },
      },
    };
  }
  if (job.completionNotification.policy !== "send"
    || job.completionNotification.delivery.state !== "attempting") {
    return { job, changed: false };
  }
  const attempt = job.completionNotification.delivery;
  return {
    changed: true,
    job: {
      ...job,
      completionNotification: {
        version: 1,
        policy: "send",
        delivery: {
          state: "unknown",
          attemptId: attempt.attemptId,
          attemptCount: attempt.attemptCount,
          updatedAt: now,
          transport: "unknown",
          evidence: "interrupted",
          attempted: "unknown",
        },
      },
    },
  };
}

export function remoteAiJobIsClaimable(job: RemoteAiJob, now = Date.now()): boolean {
  if (job.status === "pending") return true;
  if (job.status !== "processing"
    || !isBoundedString(job.controllerDeviceId, 256)
    || !isBoundedString(job.claimId, 256)
    || !isIsoTimestamp(job.startedAt)) return false;
  const startedAt = Date.parse(job.startedAt);
  return Number.isFinite(startedAt) && now - startedAt >= REMOTE_AI_CLAIM_TIMEOUT_MS;
}
