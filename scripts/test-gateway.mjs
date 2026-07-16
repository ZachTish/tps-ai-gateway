import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { transformSync } from "esbuild";
import { Buffer } from "node:buffer";

const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const providers = readFileSync(new URL("../src/providers.ts", import.meta.url), "utf8");
const loggerSource = readFileSync(new URL("../src/logger.ts", import.meta.url), "utf8");
const timeoutSource = readFileSync(new URL("../src/provider-timeout.ts", import.meta.url), "utf8");
const settingsSource = readFileSync(new URL("../src/settings.ts", import.meta.url), "utf8");
const schemaSource = readFileSync(new URL("../src/schema.ts", import.meta.url), "utf8");
const remoteQueueSource = readFileSync(new URL("../src/remote-queue.ts", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
const schemaModule = transformSync(schemaSource, { loader: "ts", format: "esm", target: "es2020" }).code;
const { assertSchema } = await import(`data:text/javascript;base64,${Buffer.from(schemaModule).toString("base64")}`);
const settingsModule = transformSync(settingsSource, { loader: "ts", format: "esm", target: "es2020" }).code;
const { planLegacyApiKeyMigration, sanitizeSettings } = await import(`data:text/javascript;base64,${Buffer.from(settingsModule).toString("base64")}`);
const loggerModule = transformSync(loggerSource, { loader: "ts", format: "esm", target: "es2020" }).code;
const { errorSummary, metadataSummary } = await import(`data:text/javascript;base64,${Buffer.from(loggerModule).toString("base64")}`);
const timeoutModule = transformSync(timeoutSource, { loader: "ts", format: "esm", target: "es2020" }).code;
const { withProviderTimeout } = await import(`data:text/javascript;base64,${Buffer.from(timeoutModule).toString("base64")}`);
const remoteQueueModule = transformSync(remoteQueueSource, { loader: "ts", format: "esm", target: "es2020" }).code;
const { parseRemoteAiJob, remoteAiJobIsClaimable, remoteAiJobIsExpired, remoteAiJobPath } = await import(`data:text/javascript;base64,${Buffer.from(remoteQueueModule).toString("base64")}`);

test("gateway validates nested structured values", () => {
  const schema = { type: "object", additionalProperties: false, required: ["items"], properties: { items: { type: "array", items: { type: "object", required: ["id"], properties: { id: { type: "string" } } } } } };
  assert.doesNotThrow(() => assertSchema({ items: [{ id: "one" }] }, schema));
  assert.throws(() => assertSchema({ items: [{}] }, schema), /is required/);
  assert.throws(() => assertSchema({ items: [], extra: true }, schema), /not allowed/);
});

test("gateway owns provider transport and fallback", () => {
  assert.match(providers, /provider === "ollama"/);
  assert.match(providers, /provider === "openai"/);
  assert.match(providers, /generativelanguage\.googleapis\.com/);
  assert.match(main, /for \(const provider of providers\)/);
  assert.match(main, /assertSchema\(data, request\.schema\)/);
  assert.match(providers, /credentials\.openAiApiKey/);
  assert.match(providers, /credentials\.geminiApiKey/);
  assert.match(providers, /"x-goog-api-key": credentials\.geminiApiKey/);
  assert.doesNotMatch(providers, /generateContent\?key=/);
});

test("gateway bounds stalled providers and redacts credential-bearing failures", async () => {
  await assert.rejects(
    () => withProviderTimeout("ollama", new Promise(() => {}), 5),
    /ollama timed out after 1 seconds/,
  );
  assert.equal(
    errorSummary(new Error("failed https://example.test/run?key=top-secret&mode=1 Bearer top-secret"), ["top-secret"]),
    "failed https://example.test/run?key=[redacted]&mode=1 Bearer [redacted]",
  );
  assert.match(main, /withProviderTimeout/);
  assert.match(main, /logger\.errorSummary\(error, \[credentials\.openAiApiKey, credentials\.geminiApiKey\]\)/);
});

test("gateway diagnostics never log caller-controlled metadata values", () => {
  const summary = metadataSummary({ sourcePluginId: "tps-health", noteBody: "private health details" });
  assert.deepEqual(summary, { metadataFieldCount: 2 });
  assert.doesNotMatch(JSON.stringify(summary), /tps-health|private health details|sourcePluginId|noteBody/);
  const requestStartLog = main.slice(main.indexOf('logger.flow("Request", "start"'), main.indexOf("for (const provider of providers)"));
  assert.match(requestStartLog, /\.\.\.logger\.metadataSummary\(request\.metadata\)/);
  assert.doesNotMatch(requestStartLog, /metadata: request\.metadata/);
});

test("gateway migrates plaintext API keys into SecretStorage and purges them from settings", () => {
  const legacy = {
    settingsVersion: 1,
    openAiApiKey: " legacy-openai ",
    geminiApiKey: " legacy-gemini ",
  };
  const settings = sanitizeSettings(legacy);
  assert.equal(settings.settingsVersion, 2);
  assert.equal("openAiApiKey" in settings, false);
  assert.equal("geminiApiKey" in settings, false);

  const emptyPlan = planLegacyApiKeyMigration(legacy, settings, () => null);
  assert.deepEqual(emptyPlan.writes.map(({ provider, secretName }) => ({ provider, secretName })), [
    { provider: "openai", secretName: "tps-ai-gateway-openai-api-key" },
    { provider: "gemini", secretName: "tps-ai-gateway-gemini-api-key" },
  ]);
  assert.equal(emptyPlan.shouldPersist, true);

  const existingPlan = planLegacyApiKeyMigration(legacy, settings, () => "already-configured");
  assert.equal(existingPlan.writes.length, 0);
  assert.match(main, /secretStorage\.setSecret\(write\.secretName, write\.value\)/);
  assert.match(main, /new SecretComponent/);
  assert.equal(manifest.minAppVersion, "1.12.0");
});

test("gateway separates proposals from guarded execution", () => {
  assert.match(main, /registerCapability/);
  assert.match(main, /proposeCapability/);
  assert.match(main, /requiresConfirmation !== false && !context\.confirmed/);
  assert.match(main, /assertSchema\(proposal\.input, capability\.inputSchema\)/);
});

test("gateway routes user-device work through a durable Controller queue", () => {
  assert.match(main, /if \(!this\.isControllerDevice\(\)\) return this\.completeStructuredRemotely<T>\(request\)/);
  assert.match(main, /controller\?\.api\?\.isController\?\.\(\) === true/);
  assert.match(main, /this\.app\.vault\.create\(path, JSON\.stringify\(job, null, 2\)\)/);
  assert.match(main, /remoteAiJobIsClaimable\(job\)/);
  assert.match(main, /this\.completeStructuredLocally\(\{ taskId: job\.taskId/);
  assert.match(main, /notifier\?\.sendNotification/);
  assert.match(main, /job\.metadata\?\.notifyOnCompletion === false/);
  assert.match(main, /Sent to the Controller\. This can take a few minutes\./);
});

test("remote queue validates jobs, reclaims stale work, and expires retained results", () => {
  const now = Date.now();
  const job = {
    version: 1,
    id: "job-1",
    taskId: "health.describe-food.extract",
    requesterDeviceId: "phone",
    createdAt: new Date(now - 1000).toISOString(),
    updatedAt: new Date(now - 1000).toISOString(),
    status: "pending",
    messages: [{ role: "user", content: "one piece salmon sashimi" }],
    schema: { type: "object" },
  };
  assert.equal(parseRemoteAiJob(JSON.stringify(job))?.id, "job-1");
  assert.equal(remoteAiJobIsClaimable(job, now), true);
  assert.equal(remoteAiJobIsClaimable({ ...job, status: "processing", startedAt: new Date(now - 11 * 60 * 1000).toISOString() }, now), true);
  assert.equal(remoteAiJobIsClaimable({ ...job, status: "processing", startedAt: new Date(now).toISOString() }, now), false);
  assert.equal(remoteAiJobIsExpired({ ...job, status: "complete", updatedAt: new Date(now - 49 * 60 * 60 * 1000).toISOString() }, now), true);
  assert.equal(remoteAiJobPath("job / unsafe"), "_assets/TPS AI Queue/job-unsafe.md");
});
