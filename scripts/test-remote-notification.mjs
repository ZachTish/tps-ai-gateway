import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const outdir = await mkdtemp(join(tmpdir(), "tps-ai-remote-notification-"));
const outfile = join(outdir, "remote-queue.mjs");
await build({
  entryPoints: [fileURLToPath(new URL("../src/remote-queue.ts", import.meta.url))],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "silent",
});
const {
  REMOTE_AI_MAX_JOB_FILE_BYTES,
  REMOTE_AI_MAX_JOB_JSON_CHARS,
  REMOTE_AI_MAX_MESSAGE_CHARS,
  REMOTE_AI_MAX_RESULT_DEPTH,
  REMOTE_AI_MAX_RESULT_NODES,
  REMOTE_AI_MAX_RESULT_STRING_CHARS,
  REMOTE_AI_MAX_SCHEMA_DEPTH,
  REMOTE_AI_MAX_SCHEMA_NODES,
  REMOTE_AI_MAX_SCHEMA_STRING_CHARS,
  beginRemoteAiNotificationAttempt,
  parseRemoteAiJob,
  recoverRemoteAiNotificationState,
  remoteAiJobFileSizeIsAllowed,
  remoteAiJobIsClaimable,
  remoteAiJobSerializedSizeIsAllowed,
  remoteAiResultDataIsWithinBudget,
  remoteAiSchemaIsWithinBudget,
  settleRemoteAiNotificationAttempt,
  suppressRemoteAiCompletionNotification,
  transitionRemoteAiJobFile,
} = await import(pathToFileURL(outfile).href);

test.after(async () => {
  await rm(outdir, { recursive: true, force: true });
});

const baseJob = (overrides = {}) => ({
  version: 1,
  id: "job-1",
  taskId: "health.describe-food.extract",
  requesterDeviceId: "phone",
  createdAt: "2026-07-19T12:00:00.000Z",
  updatedAt: "2026-07-19T12:01:00.000Z",
  status: "complete",
  messages: [{ role: "user", content: "one piece salmon sashimi" }],
  schema: { type: "object" },
  result: {
    data: { ok: true },
    provider: "openai",
    model: "test-model",
    traceId: "trace-1",
    attempts: 1,
  },
  ...overrides,
});

const nestedObject = (depth) => {
  let value = {};
  for (let index = 0; index < depth; index += 1) value = { child: value };
  return value;
};

test("legacy terminal jobs migrate to unknown without inventing a transport", () => {
  const original = baseJob();
  const recovered = recoverRemoteAiNotificationState(original, "2026-07-19T12:02:00.000Z");
  assert.equal(recovered.changed, true);
  assert.equal(recovered.job.completionNotification.policy, "send");
  assert.deepEqual(recovered.job.completionNotification.delivery, {
    state: "unknown",
    attemptCount: 0,
    updatedAt: "2026-07-19T12:02:00.000Z",
    transport: "unknown",
    evidence: "legacy-untracked",
    attempted: "unknown",
  });
  assert.equal(parseRemoteAiJob(JSON.stringify(recovered.job))?.id, original.id);
});

test("nonterminal jobs remain untouched by completion-notification recovery", () => {
  for (const status of ["pending", "processing"]) {
    const job = baseJob({ status, result: undefined, startedAt: status === "processing" ? "2026-07-19T12:01:00.000Z" : undefined });
    const recovered = recoverRemoteAiNotificationState(job, "2026-07-19T12:02:00.000Z");
    assert.equal(recovered.changed, false);
    assert.equal(recovered.job, job);
    assert.equal(recovered.job.completionNotification, undefined);
  }
});

test("startup converts an interrupted attempt to unknown without changing its ownership", () => {
  const attempting = beginRemoteAiNotificationAttempt(
    baseJob(),
    "attempt-one",
    "2026-07-19T12:02:00.000Z",
  );
  const recovered = recoverRemoteAiNotificationState(attempting, "2026-07-19T12:03:00.000Z");
  assert.equal(recovered.changed, true);
  assert.deepEqual(recovered.job.completionNotification.delivery, {
    state: "unknown",
    attemptId: "attempt-one",
    attemptCount: 1,
    updatedAt: "2026-07-19T12:03:00.000Z",
    transport: "unknown",
    evidence: "interrupted",
    attempted: "unknown",
  });
  assert.equal(recoverRemoteAiNotificationState(recovered.job).changed, false);
});

test("attempt settlement requires the exact persisted attempt id", () => {
  const attempting = beginRemoteAiNotificationAttempt(
    baseJob(),
    "attempt-one",
    "2026-07-19T12:02:00.000Z",
  );
  const accepted = {
    state: "accepted",
    transport: "notifier-v2",
    evidence: "structured-receipt",
    attempted: true,
    httpStatus: 200,
    providerMessageId: "provider-message-1",
  };
  assert.equal(settleRemoteAiNotificationAttempt(attempting, "stale-attempt", accepted), null);
  const settled = settleRemoteAiNotificationAttempt(
    attempting,
    "attempt-one",
    accepted,
    "2026-07-19T12:03:00.000Z",
  );
  assert.ok(settled);
  assert.deepEqual(settled.completionNotification.delivery, {
    state: "accepted",
    attemptId: "attempt-one",
    attemptCount: 1,
    updatedAt: "2026-07-19T12:03:00.000Z",
    transport: "notifier-v2",
    evidence: "structured-receipt",
    attempted: true,
    httpStatus: 200,
    providerMessageId: "provider-message-1",
  });
  assert.equal(parseRemoteAiJob(JSON.stringify(settled))?.completionNotification.delivery.state, "accepted");
});

test("all consumer outcomes persist without raw error text", () => {
  const outcomes = [
    { state: "legacy-accepted", transport: "notifier-v1", evidence: "legacy-promise-resolved", attempted: true },
    { state: "rejected", transport: "notifier-v2", evidence: "structured-rejection", attempted: true, code: "delivery-rejected", httpStatus: 401 },
    { state: "not-attempted", transport: "unavailable", evidence: "service-unavailable", attempted: false },
    { state: "unknown", transport: "notifier-v1", evidence: "legacy-rejection", attempted: "unknown" },
    { state: "unknown", transport: "notifier-v2", evidence: "malformed-v2-result", attempted: "unknown" },
    { state: "unknown", transport: "notifier-v2", evidence: "consumer-timeout", attempted: "unknown" },
  ];
  for (const [index, outcome] of outcomes.entries()) {
    const attemptId = `attempt-${index}`;
    const attempting = beginRemoteAiNotificationAttempt(baseJob(), attemptId);
    const settled = settleRemoteAiNotificationAttempt(attempting, attemptId, outcome);
    assert.ok(settled);
    const serialized = JSON.stringify(settled);
    assert.equal(parseRemoteAiJob(serialized)?.completionNotification.delivery.state, outcome.state);
    assert.equal(settled.status, "complete");
    assert.deepEqual(settled.result, baseJob().result);
    assert.doesNotMatch(serialized, /raw provider failure|private topic|Bearer /i);
  }
});

test("suppressed completion notifications carry no delivery attempt", () => {
  const job = suppressRemoteAiCompletionNotification(baseJob({ metadata: { notifyOnCompletion: false } }));
  assert.deepEqual(job.completionNotification, { version: 1, policy: "suppressed" });
  assert.equal(parseRemoteAiJob(JSON.stringify(job))?.completionNotification.policy, "suppressed");
  const legacyRecovery = recoverRemoteAiNotificationState(baseJob({ metadata: { notifyOnCompletion: false } }));
  assert.equal(legacyRecovery.changed, true);
  assert.deepEqual(legacyRecovery.job.completionNotification, { version: 1, policy: "suppressed" });
  assert.throws(
    () => beginRemoteAiNotificationAttempt(baseJob({ status: "processing", result: undefined }), "attempt-one"),
    /Only terminal remote AI jobs/,
  );
});

test("remote job parsing rejects malformed core fields and contradictory notification evidence", () => {
  const invalidJobs = [
    baseJob({ id: 42 }),
    baseJob({ messages: [{}] }),
    baseJob({ schema: [] }),
    baseJob({ status: "processing", result: undefined, controllerDeviceId: "controller", startedAt: undefined }),
    baseJob({ status: "processing", result: undefined, controllerDeviceId: "controller", claimId: "", startedAt: "2026-07-19T12:02:00.000Z" }),
    baseJob({ status: "processing", result: undefined, controllerDeviceId: "controller", claimId: "claim-one", startedAt: "07/19/2026 12:02" }),
    baseJob({
      completionNotification: {
        version: 1,
        policy: "send",
        delivery: {
          state: "accepted",
          attemptId: "attempt-one",
          attemptCount: 1,
          updatedAt: "2026-07-19T12:02:00.000Z",
          transport: "unknown",
          evidence: "invalid-record",
          attempted: true,
        },
      },
    }),
    baseJob({
      status: "pending",
      result: undefined,
      completionNotification: {
        version: 1,
        policy: "send",
        delivery: {
          state: "accepted",
          attemptId: "prior-attempt",
          attemptCount: 1,
          updatedAt: "2026-07-19T12:02:00.000Z",
          transport: "notifier-v2",
          evidence: "structured-receipt",
          attempted: true,
          httpStatus: 200,
          providerMessageId: "prior-receipt",
        },
      },
    }),
    baseJob({
      status: "processing",
      result: undefined,
      controllerDeviceId: "controller-one",
      claimId: "claim-one",
      startedAt: "2026-07-19T12:02:00.000Z",
      completionNotification: {
        version: 1,
        policy: "suppressed",
      },
    }),
  ];
  for (const job of invalidJobs) assert.equal(parseRemoteAiJob(JSON.stringify(job)), null);
});

test("remote queue enforces file, raw JSON, per-message, and aggregate-message boundaries", () => {
  assert.equal(remoteAiJobFileSizeIsAllowed(REMOTE_AI_MAX_JOB_FILE_BYTES), true);
  assert.equal(remoteAiJobFileSizeIsAllowed(REMOTE_AI_MAX_JOB_FILE_BYTES + 1), false);
  assert.equal(remoteAiJobFileSizeIsAllowed(-1), false);
  assert.equal(remoteAiJobSerializedSizeIsAllowed("x".repeat(REMOTE_AI_MAX_JOB_JSON_CHARS)), true);
  assert.equal(remoteAiJobSerializedSizeIsAllowed("x".repeat(REMOTE_AI_MAX_JOB_JSON_CHARS + 1)), false);
  assert.equal(remoteAiJobSerializedSizeIsAllowed("é".repeat(REMOTE_AI_MAX_JOB_FILE_BYTES / 2)), true);
  assert.equal(remoteAiJobSerializedSizeIsAllowed("é".repeat((REMOTE_AI_MAX_JOB_FILE_BYTES / 2) + 1)), false);
  assert.equal(parseRemoteAiJob(" ".repeat(REMOTE_AI_MAX_JOB_JSON_CHARS + 1)), null);
  const multibyteOversizeJob = JSON.stringify({
    ...baseJob(),
    ignoredPadding: "é".repeat((REMOTE_AI_MAX_JOB_FILE_BYTES / 2) + 1),
  });
  assert.ok(multibyteOversizeJob.length < REMOTE_AI_MAX_JOB_JSON_CHARS);
  assert.equal(parseRemoteAiJob(multibyteOversizeJob), null);

  const boundaryMessages = [
    { role: "user", content: "a".repeat(REMOTE_AI_MAX_MESSAGE_CHARS) },
    { role: "assistant", content: "b".repeat(REMOTE_AI_MAX_MESSAGE_CHARS) },
  ];
  assert.ok(parseRemoteAiJob(JSON.stringify(baseJob({ messages: boundaryMessages }))));
  assert.equal(parseRemoteAiJob(JSON.stringify(baseJob({
    messages: [...boundaryMessages, { role: "user", content: "x" }],
  }))), null);
  assert.equal(parseRemoteAiJob(JSON.stringify(baseJob({
    messages: [{ role: "user", content: "x".repeat(REMOTE_AI_MAX_MESSAGE_CHARS + 1) }],
  }))), null);
});

test("schema and result budgets enforce depth, node, and aggregate-string boundaries", () => {
  assert.equal(remoteAiSchemaIsWithinBudget(nestedObject(REMOTE_AI_MAX_SCHEMA_DEPTH)), true);
  assert.equal(remoteAiSchemaIsWithinBudget(nestedObject(REMOTE_AI_MAX_SCHEMA_DEPTH + 1)), false);
  assert.equal(remoteAiSchemaIsWithinBudget({ values: Array(REMOTE_AI_MAX_SCHEMA_NODES - 2).fill(null) }), true);
  assert.equal(remoteAiSchemaIsWithinBudget({ values: Array(REMOTE_AI_MAX_SCHEMA_NODES - 1).fill(null) }), false);
  assert.equal(remoteAiSchemaIsWithinBudget({ value: "x".repeat(REMOTE_AI_MAX_SCHEMA_STRING_CHARS - "value".length) }), true);
  assert.equal(remoteAiSchemaIsWithinBudget({ value: "x".repeat(REMOTE_AI_MAX_SCHEMA_STRING_CHARS - "value".length + 1) }), false);

  assert.equal(remoteAiResultDataIsWithinBudget(nestedObject(REMOTE_AI_MAX_RESULT_DEPTH)), true);
  assert.equal(remoteAiResultDataIsWithinBudget(nestedObject(REMOTE_AI_MAX_RESULT_DEPTH + 1)), false);
  assert.equal(remoteAiResultDataIsWithinBudget(Array(REMOTE_AI_MAX_RESULT_NODES - 1).fill(null)), true);
  assert.equal(remoteAiResultDataIsWithinBudget(Array(REMOTE_AI_MAX_RESULT_NODES).fill(null)), false);
  assert.equal(remoteAiResultDataIsWithinBudget("x".repeat(REMOTE_AI_MAX_RESULT_STRING_CHARS)), true);
  assert.equal(remoteAiResultDataIsWithinBudget("x".repeat(REMOTE_AI_MAX_RESULT_STRING_CHARS + 1)), false);

  let wideArrayElementReads = 0;
  const tooWideResult = new Proxy(new Array(REMOTE_AI_MAX_RESULT_NODES + 1), {
    get(target, property, receiver) {
      if (typeof property === "string" && /^\d+$/.test(property)) wideArrayElementReads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  assert.equal(remoteAiResultDataIsWithinBudget(tooWideResult), false);
  assert.equal(wideArrayElementReads, 0);

  assert.equal(parseRemoteAiJob(JSON.stringify(baseJob({ schema: nestedObject(REMOTE_AI_MAX_SCHEMA_DEPTH + 1) }))), null);
  assert.equal(parseRemoteAiJob(JSON.stringify(baseJob({
    result: { ...baseJob().result, data: nestedObject(REMOTE_AI_MAX_RESULT_DEPTH + 1) },
  }))), null);
});

test("only structurally valid stale processing claims are reclaimable", () => {
  const current = {
    ...baseJob({ status: "processing", result: undefined }),
    controllerDeviceId: "controller-one",
    claimId: "claim-one",
    startedAt: "2026-07-19T12:02:00.000Z",
  };
  assert.ok(parseRemoteAiJob(JSON.stringify(current)));
  assert.equal(remoteAiJobIsClaimable(current, Date.parse("2026-07-19T12:11:59.999Z")), false);
  assert.equal(remoteAiJobIsClaimable(current, Date.parse("2026-07-19T12:12:00.000Z")), true);
  assert.equal(remoteAiJobIsClaimable({ ...current, claimId: undefined }, Date.parse("2026-07-19T13:00:00.000Z")), false);
  assert.equal(remoteAiJobIsClaimable({ ...current, startedAt: "not-a-date" }, Date.parse("2026-07-19T13:00:00.000Z")), false);
});

test("notification settlement refuses nonterminal jobs", () => {
  const processing = {
    ...beginRemoteAiNotificationAttempt(baseJob(), "attempt-one"),
    status: "processing",
    result: undefined,
    controllerDeviceId: "controller-one",
    startedAt: "2026-07-19T12:02:00.000Z",
  };
  assert.equal(settleRemoteAiNotificationAttempt(processing, "attempt-one", {
    state: "accepted",
    transport: "notifier-v2",
    evidence: "structured-receipt",
    attempted: true,
    httpStatus: 200,
    providerMessageId: "provider-message-1",
  }), null);
});

test("a known pre-send interruption CAS-settles as definitely not attempted", async () => {
  const attempting = beginRemoteAiNotificationAttempt(baseJob(), "attempt-one", "2026-07-19T12:02:00.000Z");
  const store = {
    data: JSON.stringify(attempting, null, 2),
    async process(_file, update) {
      this.data = update(this.data);
      return this.data;
    },
  };
  const transition = await transitionRemoteAiJobFile(store, {}, (current) => settleRemoteAiNotificationAttempt(
    current,
    "attempt-one",
    { state: "not-attempted", transport: "unavailable", evidence: "interrupted", attempted: false },
    "2026-07-19T12:03:00.000Z",
  ));
  assert.equal(transition.changed, true);
  assert.deepEqual(parseRemoteAiJob(store.data).completionNotification.delivery, {
    state: "not-attempted",
    attemptId: "attempt-one",
    attemptCount: 1,
    updatedAt: "2026-07-19T12:03:00.000Z",
    transport: "unavailable",
    evidence: "interrupted",
    attempted: false,
  });
});

test("atomic transitions see the latest file and reject stale ownership", async () => {
  const store = {
    data: JSON.stringify(baseJob(), null, 2),
    async process(_file, update) {
      this.data = update(this.data);
      return this.data;
    },
  };
  const attempting = beginRemoteAiNotificationAttempt(baseJob(), "attempt-new");
  store.data = JSON.stringify(attempting, null, 2);
  const stale = await transitionRemoteAiJobFile(store, { path: "job.md" }, (current) => (
    settleRemoteAiNotificationAttempt(current, "attempt-old", {
      state: "accepted",
      transport: "notifier-v2",
      evidence: "structured-receipt",
      attempted: true,
      httpStatus: 200,
      providerMessageId: "stale",
    })
  ));
  assert.equal(stale.changed, false);
  assert.equal(parseRemoteAiJob(store.data).completionNotification.delivery.attemptId, "attempt-new");

  const current = await transitionRemoteAiJobFile(store, { path: "job.md" }, (job) => (
    settleRemoteAiNotificationAttempt(job, "attempt-new", {
      state: "accepted",
      transport: "notifier-v2",
      evidence: "structured-receipt",
      attempted: true,
      httpStatus: 200,
      providerMessageId: "current",
    })
  ));
  assert.equal(current.changed, true);
  assert.equal(parseRemoteAiJob(store.data).completionNotification.delivery.providerMessageId, "current");
});

test("atomic claiming permits only one local claimant", async () => {
  const pending = baseJob({ status: "pending", result: undefined });
  const store = {
    data: JSON.stringify(pending, null, 2),
    async process(_file, update) {
      this.data = update(this.data);
      return this.data;
    },
  };
  const claim = (claimId) => transitionRemoteAiJobFile(store, {}, (job) => {
    if (!remoteAiJobIsClaimable(job, Date.parse("2026-07-19T12:03:00.000Z"))) return null;
    return {
      ...job,
      status: "processing",
      controllerDeviceId: "controller-one",
      claimId,
      startedAt: "2026-07-19T12:02:00.000Z",
      updatedAt: "2026-07-19T12:02:00.000Z",
    };
  });
  const first = await claim("claim-one");
  const second = await claim("claim-two");
  assert.equal(first.changed, true);
  assert.equal(first.job.claimId, "claim-one");
  assert.equal(second.changed, false);
  assert.equal(parseRemoteAiJob(store.data).claimId, "claim-one");
});

test("atomic transition does not resolve before durable processing completes", async () => {
  let release;
  const durable = new Promise((resolve) => { release = resolve; });
  let callbackRan = false;
  const store = {
    data: JSON.stringify(baseJob(), null, 2),
    async process(_file, update) {
      this.data = update(this.data);
      callbackRan = true;
      await durable;
      return this.data;
    },
  };
  let resolved = false;
  const transition = transitionRemoteAiJobFile(store, {}, (job) => ({ ...job, revision: 1 }))
    .then((result) => { resolved = true; return result; });
  await Promise.resolve();
  assert.equal(callbackRan, true);
  assert.equal(resolved, false);
  release();
  assert.equal((await transition).changed, true);
});
