import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build as esbuildBuild, transformSync } from "esbuild";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";

const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const providers = readFileSync(new URL("../src/providers.ts", import.meta.url), "utf8");
const loggerSource = readFileSync(new URL("../src/logger.ts", import.meta.url), "utf8");
const timeoutSource = readFileSync(new URL("../src/provider-timeout.ts", import.meta.url), "utf8");
const settingsSource = readFileSync(new URL("../src/settings.ts", import.meta.url), "utf8");
const schemaSource = readFileSync(new URL("../src/schema.ts", import.meta.url), "utf8");
const remoteQueueSource = readFileSync(new URL("../src/remote-queue.ts", import.meta.url), "utf8");
const stylesSource = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
const schemaModule = transformSync(schemaSource, { loader: "ts", format: "esm", target: "es2020" }).code;
const { assertSchema } = await import(`data:text/javascript;base64,${Buffer.from(schemaModule).toString("base64")}`);
const settingsModule = transformSync(settingsSource, { loader: "ts", format: "esm", target: "es2020" }).code;
const {
  AiGatewaySettingsSaveCoordinator,
  changedSettingsKeys,
  mergeChangedSettings,
  planLegacyApiKeyMigration,
  reconcilePersistedSettings,
  sanitizeSettings,
} = await import(`data:text/javascript;base64,${Buffer.from(settingsModule).toString("base64")}`);
const loggerModule = transformSync(loggerSource, { loader: "ts", format: "esm", target: "es2020" }).code;
const { errorSummary, metadataSummary } = await import(`data:text/javascript;base64,${Buffer.from(loggerModule).toString("base64")}`);
const timeoutModule = transformSync(timeoutSource, { loader: "ts", format: "esm", target: "es2020" }).code;
const { withProviderTimeout } = await import(`data:text/javascript;base64,${Buffer.from(timeoutModule).toString("base64")}`);
const remoteQueueModule = transformSync(remoteQueueSource, { loader: "ts", format: "esm", target: "es2020" }).code;
const { parseRemoteAiJob, remoteAiJobIsClaimable, remoteAiJobIsExpired, remoteAiJobPath, REMOTE_AI_QUEUE_FOLDER } = await import(`data:text/javascript;base64,${Buffer.from(remoteQueueModule).toString("base64")}`);

const clone = (value) => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
};
const queueFile = (path) => ({
  kind: "file",
  path,
  extension: path.includes(".") ? path.slice(path.lastIndexOf(".") + 1) : "",
});
const queueFolder = (path, children = []) => ({ kind: "folder", path, children });
const queueVault = (getChildren, methods = {}) => ({
  getFolderByPath: (path) => path === REMOTE_AI_QUEUE_FOLDER
    ? queueFolder(REMOTE_AI_QUEUE_FOLDER, getChildren())
    : null,
  getMarkdownFiles: () => {
    throw new Error("Remote queue scans must not enumerate all vault Markdown files.");
  },
  ...methods,
});

async function importGatewayPlugin() {
  const bundle = await esbuildBuild({
    entryPoints: [fileURLToPath(new URL("../src/main.ts", import.meta.url))],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
    plugins: [{
      name: "obsidian-stub",
      setup(build) {
        build.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian-stub", namespace: "stub" }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          loader: "js",
          contents: `
            export class App {}
            export class Notice {}
            export class Plugin {}
            export class PluginSettingTab {}
            export class SecretComponent {}
            export class Setting {}
            export class TFile {
              static [Symbol.hasInstance](value) {
                return value?.kind === "file";
              }
            }
            export class TFolder {
              static [Symbol.hasInstance](value) {
                return value?.kind === "folder";
              }
            }
            export class Vault {
              static recurseChildren(root, callback) {
                for (const child of root.children) {
                  callback(child);
                  if (child instanceof TFolder) Vault.recurseChildren(child, callback);
                }
              }
            }
            export async function requestUrl() {
              throw new Error("Network access is not available in gateway unit tests.");
            }
          `,
        }));
      },
    }],
  });
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`);
}

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

test("gateway preserves explicit provider choices and empty text settings", () => {
  const settings = sanitizeSettings({
    settingsVersion: 2,
    providerOrder: ["openai"],
    ollamaUrl: "",
    ollamaModel: "",
    openAiModel: "",
    geminiModel: "",
  });
  assert.deepEqual(settings.providerOrder, ["openai"]);
  assert.equal(settings.ollamaUrl, "");
  assert.equal(settings.ollamaModel, "");
  assert.equal(settings.openAiModel, "");
  assert.equal(settings.geminiModel, "");
});

test("gateway never downgrades future settings and merges only local changes", () => {
  const future = {
    settingsVersion: 3,
    providerOrder: ["gemini"],
    openAiModel: "mobile-model",
    geminiModel: "future-gemini",
    futureProvider: { model: "future-model" },
  };
  const baseline = sanitizeSettings({ ...future, openAiModel: "desktop-old" });
  const local = sanitizeSettings({ ...future, openAiModel: "desktop-new" });
  const changed = changedSettingsKeys(baseline, local);
  const merged = mergeChangedSettings(future, local, changed);

  assert.deepEqual([...changed], ["openAiModel"]);
  assert.equal(merged.settingsVersion, 3);
  assert.equal(merged.openAiModel, "desktop-new");
  assert.equal(merged.geminiModel, "future-gemini");
  assert.deepEqual(merged.futureProvider, { model: "future-model" });
  assert.equal(sanitizeSettings(future).settingsVersion, 3);
  assert.deepEqual(planLegacyApiKeyMigration({ ...future, openAiApiKey: "do-not-migrate" }, sanitizeSettings(future), () => null), {
    writes: [],
    shouldPersist: false,
  });
  assert.match(main, /new AiGatewaySettingsSaveCoordinator/);
});

test("settings coordinator merges local edits into the latest future-version payload", async () => {
  const baseline = sanitizeSettings({
    settingsVersion: 2,
    openAiModel: "desktop-old",
    geminiModel: "desktop-old",
  });
  let stored = {
    ...clone(baseline),
    settingsVersion: 3,
    geminiModel: "mobile-new",
    futureProvider: { model: "future-model" },
  };
  const live = clone(baseline);
  live.openAiModel = "desktop-new";
  const coordinator = new AiGatewaySettingsSaveCoordinator({
    loadLatest: async () => clone(stored),
    saveMerged: async (value) => { stored = clone(value); },
    onPersisted: (requested, persisted) => reconcilePersistedSettings(live, requested, persisted),
  }, baseline);

  await coordinator.request(live);

  assert.equal(stored.settingsVersion, 3);
  assert.equal(stored.openAiModel, "desktop-new");
  assert.equal(stored.geminiModel, "mobile-new");
  assert.deepEqual(stored.futureProvider, { model: "future-model" });
  assert.equal(live.geminiModel, "mobile-new");
});

test("settings coordinator carries a three-request revert plus a separate edit", async () => {
  const baseline = sanitizeSettings({ openAiModel: "old-model" });
  let stored = clone(baseline);
  const writes = [];
  const firstEntered = deferred();
  const allowFirst = deferred();
  const secondEntered = deferred();
  const allowSecond = deferred();
  const coordinator = new AiGatewaySettingsSaveCoordinator({
    loadLatest: async () => clone(stored),
    saveMerged: async (value) => {
      writes.push(clone(value));
      if (writes.length === 1) {
        firstEntered.resolve();
        await allowFirst.promise;
      } else if (writes.length === 2) {
        secondEntered.resolve();
        await allowSecond.promise;
      }
      stored = clone(value);
    },
  }, baseline);

  const first = coordinator.request({ ...clone(baseline), openAiModel: "new-model" });
  await firstEntered.promise;
  const second = coordinator.request(clone(baseline));
  let thirdResolved = false;
  const third = coordinator.request({ ...clone(baseline), geminiModel: "separate-edit" }).then(() => { thirdResolved = true; });
  allowFirst.resolve();
  await secondEntered.promise;
  assert.equal(thirdResolved, false);
  allowSecond.resolve();
  await Promise.all([first, second, third]);

  assert.deepEqual(writes.map((value) => value.openAiModel), ["new-model", "old-model"]);
  assert.equal(stored.openAiModel, "old-model");
  assert.equal(stored.geminiModel, "separate-edit");
});

test("pending settings do not turn a synced known field into local intent", async () => {
  const baseline = sanitizeSettings({
    openAiModel: "old-openai",
    geminiModel: "old-gemini",
    ollamaModel: "old-ollama",
  });
  let stored = clone(baseline);
  const writes = [];
  const firstLoadEntered = deferred();
  const allowFirstLoad = deferred();
  let loadCount = 0;
  const coordinator = new AiGatewaySettingsSaveCoordinator({
    loadLatest: async () => {
      loadCount += 1;
      if (loadCount === 1) {
        firstLoadEntered.resolve();
        await allowFirstLoad.promise;
      }
      return clone(stored);
    },
    saveMerged: async (value) => {
      writes.push(clone(value));
      stored = clone(value);
    },
  }, baseline);

  const first = coordinator.request({ ...clone(baseline), openAiModel: "new-openai" });
  await firstLoadEntered.promise;
  stored.geminiModel = "synced-gemini";
  const second = coordinator.request({
    ...clone(baseline),
    openAiModel: "new-openai",
    ollamaModel: "new-ollama",
  });
  allowFirstLoad.resolve();
  await Promise.all([first, second]);

  assert.equal(writes.length, 2);
  assert.equal(writes[0].geminiModel, "synced-gemini");
  assert.equal(writes[1].geminiModel, "synced-gemini");
  assert.equal(stored.openAiModel, "new-openai");
  assert.equal(stored.ollamaModel, "new-ollama");
  assert.equal(stored.geminiModel, "synced-gemini");
});

test("settings coordinator lets a newer snapshot supersede a failed in-flight write", async () => {
  const baseline = sanitizeSettings({ openAiModel: "old-model" });
  let stored = clone(baseline);
  const writes = [];
  const firstEntered = deferred();
  const failFirst = deferred();
  const coordinator = new AiGatewaySettingsSaveCoordinator({
    loadLatest: async () => clone(stored),
    saveMerged: async (value) => {
      writes.push(clone(value));
      if (writes.length === 1) {
        firstEntered.resolve();
        await failFirst.promise;
        throw new Error("simulated write failure");
      }
      stored = clone(value);
    },
  }, baseline);

  const first = coordinator.request({ ...clone(baseline), openAiModel: "new-model" });
  await firstEntered.promise;
  const second = coordinator.request(clone(baseline));
  failFirst.resolve();
  await Promise.all([first, second]);

  assert.deepEqual(writes.map((value) => value.openAiModel), ["new-model", "old-model"]);
  assert.equal(stored.openAiModel, "old-model");
});

test("settings reconciliation preserves edits made while persistence is in flight", async () => {
  const baseline = sanitizeSettings({ openAiModel: "old-model", geminiModel: "old-gemini" });
  let stored = clone(baseline);
  const live = { ...clone(baseline), openAiModel: "new-model" };
  const saveEntered = deferred();
  const allowSave = deferred();
  const coordinator = new AiGatewaySettingsSaveCoordinator({
    loadLatest: async () => clone(stored),
    saveMerged: async (value) => {
      saveEntered.resolve();
      await allowSave.promise;
      stored = clone(value);
    },
    onPersisted: (requested, persisted) => reconcilePersistedSettings(live, requested, persisted),
  }, baseline);

  const saving = coordinator.request(live);
  await saveEntered.promise;
  live.geminiModel = "typed-during-save";
  allowSave.resolve();
  await saving;

  assert.equal(stored.openAiModel, "new-model");
  assert.equal(stored.geminiModel, "old-gemini");
  assert.equal(live.geminiModel, "typed-during-save");
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

test("remote queue scans only recursive Markdown children in public traversal order", async () => {
  const { default: GatewayPlugin } = await importGatewayPlugin();
  const directZ = queueFile(`${REMOTE_AI_QUEUE_FOLDER}/z-direct.md`);
  const nestedM = queueFile(`${REMOTE_AI_QUEUE_FOLDER}/a-folder/m-middle.md`);
  const deepB = queueFile(`${REMOTE_AI_QUEUE_FOLDER}/a-folder/deeper/b-deep.md`);
  const directC = queueFile(`${REMOTE_AI_QUEUE_FOLDER}/c-direct.md`);
  const ignoredFile = queueFile(`${REMOTE_AI_QUEUE_FOLDER}/a-folder/ignored.json`);
  const root = queueFolder(REMOTE_AI_QUEUE_FOLDER, [
    directZ,
    queueFolder(`${REMOTE_AI_QUEUE_FOLDER}/a-folder`, [
      nestedM,
      ignoredFile,
      queueFolder(`${REMOTE_AI_QUEUE_FOLDER}/a-folder/deeper`, [deepB]),
    ]),
    directC,
  ]);
  const readPaths = [];
  let folderLookups = 0;
  let wholeVaultCalls = 0;
  const plugin = Object.create(GatewayPlugin.prototype);
  plugin.remoteQueueScanInFlight = false;
  plugin.remoteQueueRescanRequested = false;
  plugin.isControllerDevice = () => true;
  plugin.app = {
    vault: {
      getFolderByPath: (path) => {
        folderLookups += 1;
        return path === REMOTE_AI_QUEUE_FOLDER ? root : null;
      },
      getMarkdownFiles: () => {
        wholeVaultCalls += 1;
        throw new Error("Whole-vault enumeration is forbidden in this regression.");
      },
      read: async (file) => {
        readPaths.push(file.path);
        return JSON.stringify({
          version: 1,
          id: file.path.split("/").pop().replace(/\.md$/, ""),
          taskId: "health.describe-food.extract",
          requesterDeviceId: "phone",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          status: "complete",
          messages: [{ role: "user", content: "synthetic request" }],
          schema: { type: "object" },
        });
      },
    },
  };

  await plugin.scanRemoteQueue("targeted-enumeration");

  assert.deepEqual(readPaths, [directZ.path, nestedM.path, deepB.path, directC.path]);
  assert.equal(folderLookups, 1);
  assert.equal(wholeVaultCalls, 0);
  const scannerSource = main.slice(
    main.indexOf("private getRemoteQueueMarkdownFiles"),
    main.indexOf("private async processRemoteJob"),
  );
  assert.match(scannerSource, /getFolderByPath\(REMOTE_AI_QUEUE_FOLDER\)/);
  assert.match(scannerSource, /Vault\.recurseChildren/);
  assert.doesNotMatch(scannerSource, /getMarkdownFiles/);
});

test("remote queue treats a missing folder or exact-path file collision as an empty snapshot", async () => {
  const { default: GatewayPlugin } = await importGatewayPlugin();
  for (const collision of [false, true]) {
    let reads = 0;
    let wholeVaultCalls = 0;
    const warnings = [];
    const originalWarn = console.warn;
    const plugin = Object.create(GatewayPlugin.prototype);
    plugin.remoteQueueScanInFlight = false;
    plugin.remoteQueueRescanRequested = false;
    plugin.isControllerDevice = () => true;
    plugin.app = {
      vault: {
        getFolderByPath: () => null,
        getAbstractFileByPath: () => collision ? queueFile(REMOTE_AI_QUEUE_FOLDER) : null,
        getMarkdownFiles: () => {
          wholeVaultCalls += 1;
          return [];
        },
        read: async () => {
          reads += 1;
          return "";
        },
      },
    };

    console.warn = (...args) => warnings.push(args);
    try {
      await plugin.scanRemoteQueue(collision ? "path-collision" : "missing-folder");
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(reads, 0);
    assert.equal(wholeVaultCalls, 0);
    assert.deepEqual(warnings, []);
    assert.equal(plugin.remoteQueueScanInFlight, false);
    assert.equal(plugin.remoteQueueRescanRequested, false);
  }
});

test("remote queue materializes a snapshot before reading its first file", async () => {
  const { default: GatewayPlugin } = await importGatewayPlugin();
  const firstFile = queueFile(`${REMOTE_AI_QUEUE_FOLDER}/first.md`);
  const laterFile = queueFile(`${REMOTE_AI_QUEUE_FOLDER}/later.md`);
  const root = queueFolder(REMOTE_AI_QUEUE_FOLDER, [firstFile]);
  const readPaths = [];
  const plugin = Object.create(GatewayPlugin.prototype);
  plugin.remoteQueueScanInFlight = false;
  plugin.remoteQueueRescanRequested = false;
  plugin.isControllerDevice = () => true;
  plugin.app = {
    vault: {
      getFolderByPath: () => root,
      read: async (file) => {
        readPaths.push(file.path);
        if (readPaths.length === 1) root.children.push(laterFile);
        return JSON.stringify({
          version: 1,
          id: file.path.split("/").pop().replace(/\.md$/, ""),
          taskId: "health.describe-food.extract",
          requesterDeviceId: "phone",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          status: "complete",
          messages: [{ role: "user", content: "synthetic request" }],
          schema: { type: "object" },
        });
      },
    },
  };

  await plugin.scanRemoteQueue("snapshot");
  assert.deepEqual(readPaths, [firstFile.path]);
  await plugin.scanRemoteQueue("next-snapshot");
  assert.deepEqual(readPaths, [firstFile.path, firstFile.path, laterFile.path]);
});

test("remote queue contains folder-enumeration failures to one scan pass", async () => {
  const { default: GatewayPlugin } = await importGatewayPlugin();
  const warnings = [];
  const originalWarn = console.warn;
  const plugin = Object.create(GatewayPlugin.prototype);
  plugin.remoteQueueScanInFlight = false;
  plugin.remoteQueueRescanRequested = false;
  plugin.isControllerDevice = () => true;
  plugin.app = {
    vault: {
      getFolderByPath: () => {
        throw new Error("synthetic enumeration failure");
      },
    },
  };

  console.warn = (...args) => warnings.push(args);
  try {
    await plugin.scanRemoteQueue("enumeration-failure");
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /scan-failed/);
  assert.equal(warnings[0][1].reason, "enumeration-failure");
  assert.match(warnings[0][1].error, /synthetic enumeration failure/);
  assert.equal(plugin.remoteQueueScanInFlight, false);
  assert.equal(plugin.remoteQueueRescanRequested, false);
});

test("remote queue coalesces overlapping scan requests into one trailing pass", async () => {
  const { default: GatewayPlugin } = await importGatewayPlugin();
  const firstReadEntered = deferred();
  const allowFirstRead = deferred();
  const firstFile = queueFile(`${REMOTE_AI_QUEUE_FOLDER}/complete-job-a.md`);
  const secondFile = queueFile(`${REMOTE_AI_QUEUE_FOLDER}/nested/complete-job-b.md`);
  const createCompleteJob = (id) => JSON.stringify({
    version: 1,
    id,
    taskId: "health.describe-food.extract",
    requesterDeviceId: "phone",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "complete",
    messages: [{ role: "user", content: "synthetic request" }],
    schema: { type: "object" },
  });
  let children = [firstFile];
  let snapshots = 0;
  const readPaths = [];
  let activeReads = 0;
  let maxActiveReads = 0;
  const plugin = Object.create(GatewayPlugin.prototype);
  plugin.remoteQueueScanInFlight = false;
  plugin.remoteQueueRescanRequested = false;
  plugin.isControllerDevice = () => true;
  plugin.app = {
    vault: queueVault(
      () => {
        snapshots += 1;
        return [...children];
      },
      {
        read: async (file) => {
          readPaths.push(file.path);
          activeReads += 1;
          maxActiveReads = Math.max(maxActiveReads, activeReads);
          try {
            if (readPaths.length === 1) {
              firstReadEntered.resolve();
              await allowFirstRead.promise;
            }
            return createCompleteJob(file === firstFile ? "complete-job-a" : "complete-job-b");
          } finally {
            activeReads -= 1;
          }
        },
      },
    ),
  };

  const activeScan = plugin.scanRemoteQueue("initial");
  await firstReadEntered.promise;
  children = [firstFile, queueFolder(`${REMOTE_AI_QUEUE_FOLDER}/nested`, [secondFile])];
  await Promise.all(Array.from({ length: 100 }, () => plugin.scanRemoteQueue("file-modified")));
  allowFirstRead.resolve();
  await activeScan;

  assert.equal(snapshots, 2);
  assert.equal(readPaths[0], firstFile.path);
  assert.ok(readPaths.includes(secondFile.path));
  assert.equal(maxActiveReads, 1);
  assert.equal(plugin.remoteQueueScanInFlight, false);
  assert.equal(plugin.remoteQueueRescanRequested, false);

  const snapshotsBeforeQuietScan = snapshots;
  children = [];
  await plugin.scanRemoteQueue("quiet");
  assert.equal(snapshots, snapshotsBeforeQuietScan + 1);
});

test("remote queue isolates a failed file without blocking later jobs", async () => {
  const { default: GatewayPlugin } = await importGatewayPlugin();
  const files = Array.from(
    { length: 100 },
    (_, index) => queueFile(`${REMOTE_AI_QUEUE_FOLDER}/job-${String(index).padStart(3, "0")}.md`),
  );
  const failedFile = files[37];
  const readPaths = [];
  const processedPaths = [];
  const warnings = [];
  let activeReads = 0;
  let maxActiveReads = 0;
  const originalWarn = console.warn;
  const plugin = Object.create(GatewayPlugin.prototype);
  plugin.remoteQueueScanInFlight = false;
  plugin.remoteQueueRescanRequested = false;
  plugin.isControllerDevice = () => true;
  plugin.processRemoteJob = async (file) => {
    processedPaths.push(file.path);
  };
  plugin.app = {
    vault: queueVault(
      () => [...files],
      {
        read: async (file) => {
          readPaths.push(file.path);
          activeReads += 1;
          maxActiveReads = Math.max(maxActiveReads, activeReads);
          try {
            if (file === failedFile) throw new Error("synthetic read failure");
            return JSON.stringify({
              version: 1,
              id: file.path.split("/").pop().replace(/\.md$/, ""),
              taskId: "health.describe-food.extract",
              requesterDeviceId: "phone",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              status: "pending",
              messages: [{ role: "user", content: "synthetic request" }],
              schema: { type: "object" },
            });
          } finally {
            activeReads -= 1;
          }
        },
      },
    ),
  };

  console.warn = (...args) => warnings.push(args);
  try {
    await plugin.scanRemoteQueue("qa");
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(readPaths, files.map((file) => file.path));
  assert.deepEqual(processedPaths, files.filter((file) => file !== failedFile).map((file) => file.path));
  assert.equal(maxActiveReads, 1);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0][0], /file-scan-failed/);
  assert.equal(warnings[0][1].path, failedFile.path);
  assert.equal(plugin.remoteQueueScanInFlight, false);
  assert.equal(plugin.remoteQueueRescanRequested, false);
});

test("remote queue bounds an active epoch and defers work raised during its trailing pass", async () => {
  const { default: GatewayPlugin } = await importGatewayPlugin();
  const firstReadEntered = deferred();
  const allowFirstRead = deferred();
  const trailingReadEntered = deferred();
  const allowTrailingRead = deferred();
  const firstFile = queueFile(`${REMOTE_AI_QUEUE_FOLDER}/complete-job-a.md`);
  const trailingFile = queueFile(`${REMOTE_AI_QUEUE_FOLDER}/nested/complete-job-b.md`);
  let children = [firstFile];
  let snapshots = 0;
  let activeReads = 0;
  let maxActiveReads = 0;
  const scheduledReasons = [];
  const plugin = Object.create(GatewayPlugin.prototype);
  plugin.remoteQueueScanInFlight = false;
  plugin.remoteQueueRescanRequested = false;
  plugin.isControllerDevice = () => true;
  plugin.scheduleRemoteQueueScan = (reason) => scheduledReasons.push(reason);
  plugin.app = {
    vault: queueVault(
      () => {
        snapshots += 1;
        return [...children];
      },
      {
        read: async (file) => {
          activeReads += 1;
          maxActiveReads = Math.max(maxActiveReads, activeReads);
          try {
            if (file === firstFile) {
              firstReadEntered.resolve();
              await allowFirstRead.promise;
            } else {
              trailingReadEntered.resolve();
              await allowTrailingRead.promise;
            }
            return JSON.stringify({
              version: 1,
              id: file === firstFile ? "complete-job-a" : "complete-job-b",
              taskId: "health.describe-food.extract",
              requesterDeviceId: "phone",
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              status: "complete",
              messages: [{ role: "user", content: "synthetic request" }],
              schema: { type: "object" },
            });
          } finally {
            activeReads -= 1;
          }
        },
      },
    ),
  };

  const activeScan = plugin.scanRemoteQueue("initial");
  await firstReadEntered.promise;
  children = [queueFolder(`${REMOTE_AI_QUEUE_FOLDER}/nested`, [trailingFile])];
  await plugin.scanRemoteQueue("during-initial");
  allowFirstRead.resolve();
  await trailingReadEntered.promise;
  await plugin.scanRemoteQueue("during-trailing");
  allowTrailingRead.resolve();
  await activeScan;

  assert.equal(snapshots, 2);
  assert.equal(maxActiveReads, 1);
  assert.deepEqual(scheduledReasons, ["queued-after-trailing"]);
  assert.equal(plugin.remoteQueueScanInFlight, false);
  assert.equal(plugin.remoteQueueRescanRequested, false);
});

test("remote queue skips a requested trailing pass after controller authority is lost", async () => {
  const { default: GatewayPlugin } = await importGatewayPlugin();
  const firstReadEntered = deferred();
  const allowFirstRead = deferred();
  const file = queueFile(`${REMOTE_AI_QUEUE_FOLDER}/complete-job-a.md`);
  let isController = true;
  let snapshots = 0;
  const scheduledReasons = [];
  const plugin = Object.create(GatewayPlugin.prototype);
  plugin.remoteQueueScanInFlight = false;
  plugin.remoteQueueRescanRequested = false;
  plugin.isControllerDevice = () => isController;
  plugin.scheduleRemoteQueueScan = (reason) => scheduledReasons.push(reason);
  plugin.app = {
    vault: queueVault(
      () => {
        snapshots += 1;
        return [file];
      },
      {
        read: async () => {
          firstReadEntered.resolve();
          await allowFirstRead.promise;
          return JSON.stringify({
            version: 1,
            id: "complete-job-a",
            taskId: "health.describe-food.extract",
            requesterDeviceId: "phone",
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            status: "complete",
            messages: [{ role: "user", content: "synthetic request" }],
            schema: { type: "object" },
          });
        },
      },
    ),
  };

  const activeScan = plugin.scanRemoteQueue("initial");
  await firstReadEntered.promise;
  await plugin.scanRemoteQueue("file-modified");
  isController = false;
  allowFirstRead.resolve();
  await activeScan;

  assert.equal(snapshots, 1);
  assert.deepEqual(scheduledReasons, []);
  assert.equal(plugin.remoteQueueScanInFlight, false);
  assert.equal(plugin.remoteQueueRescanRequested, false);
});

test("gateway settings use a shallow three-destination routed hub", () => {
  assert.match(main, /Choose what to configure/);
  assert.match(main, /title: "Cloud providers"/);
  assert.match(main, /title: "Local Ollama"/);
  assert.match(main, /title: "Diagnostics"/);
  assert.match(main, /"aria-pressed": String\(isActive\)/);
  assert.match(main, /pageHeading\.focus\(\{ preventScroll: true \}\)/);
  assert.match(main, /pageHeading\.scrollIntoView\(\{ block: "start" \}\)/);
  assert.match(main, /activeRouteButton\?\.scrollIntoView\(\{ block: "nearest", inline: "nearest" \}\)/);
  assert.doesNotMatch(main, /createEl\("details"/);
  assert.doesNotMatch(main, /tps-collapsible-section/);

  for (const control of [
    "OpenAI API key",
    "OpenAI model",
    "Gemini API key",
    "Gemini model",
    "Use local Ollama",
    "Ollama URL",
    "Ollama model",
    "Enable logging",
  ]) {
    assert.match(main, new RegExp(control.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }

  assert.match(stylesSource, /\.tps-ai-settings-route-button:focus-visible/);
  assert.match(stylesSource, /\.tps-ai-settings-page > h3:focus-visible/);
  assert.match(stylesSource, /height: auto/);
  assert.match(stylesSource, /\.tps-ai-settings-page > h3\s*\{[^}]*scroll-margin-top:/s);
  assert.match(stylesSource, /@media \(max-width: 700px\)/);
  assert.match(stylesSource, /overflow-x: auto/);
  assert.match(stylesSource, /\.tps-ai-settings-page \.setting-item\s*\{[^}]*flex-direction:\s*column/s);
  assert.match(stylesSource, /\.tps-ai-settings-page \.setting-item-control\s*\{[^}]*width:\s*100%/s);
  assert.match(stylesSource, /\.tps-ai-settings-page \.setting-item-control input\[type="text"\][\s\S]*width:\s*100%/);
});
