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

async function importGatewayPlugin(isIosApp = false) {
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
            export const Platform = { isIosApp: ${JSON.stringify(isIosApp)} };
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

async function importProvidersModule(onRequest) {
  const requestKey = `__tpsAiGatewayRequest_${Date.now()}_${Math.random()}`;
  globalThis[requestKey] = onRequest;
  const bundle = await esbuildBuild({
    entryPoints: [fileURLToPath(new URL("../src/providers.ts", import.meta.url))],
    bundle: true,
    format: "esm",
    platform: "node",
    write: false,
    plugins: [{
      name: "obsidian-request-stub",
      setup(build) {
        build.onResolve({ filter: /^obsidian$/ }, () => ({
          path: "obsidian-request-stub",
          namespace: "stub",
        }));
        build.onLoad({ filter: /.*/, namespace: "stub" }, () => ({
          loader: "js",
          contents: `
            export async function requestUrl(options) {
              return globalThis[${JSON.stringify(requestKey)}](options);
            }
          `,
        }));
      },
    }],
  });
  return {
    module: await import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`),
    cleanup: () => {
      delete globalThis[requestKey];
    },
  };
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
  assert.match(main, /for \(const provider of callableProviders\)/);
  assert.match(main, /assertSchema\(data, request\.schema\)/);
  assert.match(providers, /credentials\.openAiApiKey/);
  assert.match(providers, /credentials\.geminiApiKey/);
  assert.match(providers, /"x-goog-api-key": apiKey/);
  assert.doesNotMatch(providers, /generateContent\?key=/);
  assert.match(main, /features: \{ googleSearchGrounding: true, appleIntelligence: true \}/);
});

test("all providers preserve system and conversational message request shapes", async () => {
  const requests = [];
  const imported = await importProvidersModule(async (options) => {
    requests.push(options);
    if (options.url.endsWith("/api/chat")) {
      return { json: { message: { content: ' {"ok":true} ' } } };
    }
    if (options.url === "https://api.openai.com/v1/responses") {
      return { json: { output_text: ' {"ok":true} ' } };
    }
    return {
      json: {
        candidates: [{ content: { parts: [{ text: ' {"ok":' }, { text: "true} " }] } }],
      },
    };
  });
  const settings = {
    ollamaEnabled: true,
    ollamaUrl: "http://127.0.0.1:11434",
    ollamaModel: "local-model",
    openAiModel: "openai-model",
    geminiModel: "gemini-model",
  };
  const credentials = {
    openAiApiKey: "openai-secret",
    geminiApiKey: "gemini-secret",
  };
  const messages = [
    { role: "system", content: "System one" },
    { role: "user", content: "Question" },
    { role: "assistant", content: "Earlier answer" },
    { role: "system", content: "System two" },
    { role: "user", content: "Follow-up" },
  ];
  const conversationalMessageCount = messages.filter(({ role }) => role !== "system").length;
  const schema = {
    type: "object",
    additionalProperties: false,
    required: ["ok"],
    properties: { ok: { type: "boolean" } },
  };

  try {
    for (const provider of ["ollama", "openai", "gemini"]) {
      let roleReads = 0;
      const instrumentedMessages = messages.map(({ role, content }) => ({
        get role() {
          roleReads += 1;
          return role;
        },
        content,
      }));
      assert.deepEqual(
        await imported.module.callProvider(
          provider,
          settings,
          credentials,
          instrumentedMessages,
          schema,
        ),
        {
          text: '{"ok":true}',
          model: provider === "ollama"
            ? "local-model"
            : provider === "openai"
              ? "openai-model"
              : "gemini-model",
        },
      );
      assert.equal(roleReads, messages.length + conversationalMessageCount);
    }
  } finally {
    imported.cleanup();
  }

  assert.equal(requests.length, 3);
  const [ollamaRequest, openAiRequest, geminiRequest] = requests;
  assert.deepEqual(JSON.parse(ollamaRequest.body), {
    model: "local-model",
    stream: false,
    format: schema,
    messages: [
      {
        role: "user",
        content: `System one\nSystem two\n\nReturn only JSON matching this schema:\n${JSON.stringify(schema)}`,
      },
      { role: "user", content: "Question" },
      { role: "assistant", content: "Earlier answer" },
      { role: "user", content: "Follow-up" },
    ],
    options: { temperature: 0 },
  });
  assert.deepEqual(JSON.parse(openAiRequest.body), {
    model: "openai-model",
    reasoning: { effort: "medium" },
    instructions: "System one\nSystem two",
    input: [
      { role: "user", content: "Question" },
      { role: "assistant", content: "Earlier answer" },
      { role: "user", content: "Follow-up" },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "tps_gateway_result",
        strict: true,
        schema,
      },
    },
  });
  assert.deepEqual(JSON.parse(geminiRequest.body), {
    system_instruction: { parts: [{ text: "System one\nSystem two" }] },
    contents: [
      { role: "user", parts: [{ text: "Question" }] },
      { role: "model", parts: [{ text: "Earlier answer" }] },
      { role: "user", parts: [{ text: "Follow-up" }] },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      responseJsonSchema: schema,
    },
  });
});

test("Gemini receives guarded inline images with structured output while text-only providers fail closed", async () => {
  const requests = [];
  const imported = await importProvidersModule(async (options) => {
    requests.push(options);
    return { json: { candidates: [{ content: { parts: [{ text: '{"ok":true}' }] } }] } };
  });
  const settings = {
    ollamaEnabled: true,
    ollamaUrl: "http://127.0.0.1:11434",
    ollamaModel: "local-model",
    openAiModel: "openai-model",
    geminiModel: "gemini-model",
  };
  const credentials = { openAiApiKey: "openai-secret", geminiApiKey: "gemini-secret" };
  const messages = [{ role: "system", content: "Extract the label." }, { role: "user", content: "Return the visible values." }];
  const schema = { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } };
  const media = [{ mimeType: "image/jpeg", data: "aGVsbG8=" }];
  try {
    assert.deepEqual(await imported.module.callProvider("gemini", settings, credentials, messages, schema, media), { text: '{"ok":true}', model: "gemini-model" });
    await assert.rejects(() => imported.module.callProvider("openai", settings, credentials, messages, schema, media), /does not support TPS inline image requests/);
  } finally {
    imported.cleanup();
  }
  assert.equal(requests.length, 1);
  const body = JSON.parse(requests[0].body);
  assert.deepEqual(body.contents, [{
    role: "user",
    parts: [
      { text: "Return the visible values." },
      { inline_data: { mime_type: "image/jpeg", data: "aGVsbG8=" } },
    ],
  }]);
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  assert.deepEqual(body.generationConfig.responseJsonSchema, schema);
});

test("hosted Gemma uses prompt-constrained JSON, image-first content, and one bounded repair", async () => {
  const requests = [];
  const imported = await importProvidersModule(async (options) => {
    requests.push(options);
    return {
      json: {
        candidates: [{ content: { parts: [{ text: requests.length === 1 ? "I think the answer is true." : '```json\n{"ok":true}\n```' }] } }],
      },
    };
  });
  const settings = { geminiModel: "gemma-4-26b-a4b-it" };
  const credentials = { openAiApiKey: "", geminiApiKey: "gemini-secret" };
  const messages = [{ role: "system", content: "Return the requested diagnostic value." }, { role: "user", content: "Set ok true." }];
  const schema = { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } };
  const media = [{ mimeType: "image/png", data: "aGVsbG8=" }];
  try {
    assert.deepEqual(
      await imported.module.callProvider("gemini", settings, credentials, messages, schema, media),
      { text: '{"ok":true}', model: "gemma-4-26b-a4b-it" },
    );
  } finally {
    imported.cleanup();
  }
  assert.equal(requests.length, 2);
  const firstBody = JSON.parse(requests[0].body);
  assert.deepEqual(firstBody.generationConfig, { thinkingConfig: { thinkingLevel: "minimal" } });
  assert.equal("system_instruction" in firstBody, false);
  assert.deepEqual(firstBody.contents[0].parts[0], { inline_data: { mime_type: "image/png", data: "aGVsbG8=" } });
  assert.match(firstBody.contents[0].parts[1].text, /Return only one valid JSON value/);
  assert.match(firstBody.contents[0].parts[1].text, /Return the requested diagnostic value/);
  assert.match(firstBody.contents[0].parts[1].text, /"ok"/);
  assert.equal(firstBody.contents[0].parts[2].text, "Set ok true.");
  const repairBody = JSON.parse(requests[1].body);
  assert.equal(repairBody.contents.at(-2).role, "model");
  assert.equal(repairBody.contents.at(-2).parts[0].text, "I think the answer is true.");
  assert.match(repairBody.contents.at(-1).parts[0].text, /Return only the corrected JSON value/);
});

test("hosted Gemma rejects Google Search grounding before transport", async () => {
  const requests = [];
  const imported = await importProvidersModule(async (options) => {
    requests.push(options);
    return { json: {} };
  });
  try {
    await assert.rejects(
      () => imported.module.callProvider(
        "gemini",
        { geminiModel: "models/gemma-4-31b-it" },
        { openAiApiKey: "", geminiApiKey: "gemini-secret" },
        [{ role: "user", content: "Research this." }],
        { type: "object" },
        [],
        "google-search",
      ),
      /grounding is unavailable for hosted Gemma/,
    );
  } finally {
    imported.cleanup();
  }
  assert.equal(requests.length, 0);
});

test("Gemini grounds product research before a separate schema-validated extraction", async () => {
  const requests = [];
  const imported = await importProvidersModule(async (options) => {
    requests.push(options);
    if (requests.length === 1) {
      return {
        json: {
          candidates: [{
            content: { parts: [{ text: "Clubtails lists Blue Hawaiian as 16 oz and 10% ABV. Nutrition listings conflict." }] },
            groundingMetadata: {
              groundingChunks: [
                { web: { title: "Clubtails Blue Hawaiian", uri: "https://clubtails.example/blue-hawaiian" } },
                { web: { title: "Nutrition listing", uri: "https://nutrition.example/clubtails" } },
                { web: { title: "Duplicate", uri: "https://clubtails.example/blue-hawaiian" } },
                { web: { title: "Unsafe", uri: "javascript:alert(1)" } },
              ],
            },
          }],
        },
      };
    }
    return { json: { candidates: [{ content: { parts: [{ text: '{"found":true}' }] } }] } };
  });
  const settings = { geminiModel: "gemini-2.5-flash" };
  const credentials = { openAiApiKey: "", geminiApiKey: "gemini-secret" };
  const messages = [
    { role: "system", content: "Research an exact packaged product." },
    { role: "user", content: "Clubtails Blue Hawaiian" },
  ];
  const schema = { type: "object", additionalProperties: false, required: ["found"], properties: { found: { type: "boolean" } } };
  try {
    assert.deepEqual(
      await imported.module.callProvider("gemini", settings, credentials, messages, schema, [], "google-search"),
      {
        text: '{"found":true}',
        model: "gemini-2.5-flash",
        sources: [
          { title: "Clubtails Blue Hawaiian", url: "https://clubtails.example/blue-hawaiian" },
          { title: "Nutrition listing", url: "https://nutrition.example/clubtails" },
        ],
      },
    );
    await assert.rejects(
      () => imported.module.callProvider("openai", settings, credentials, messages, schema, [], "google-search"),
      /does not support Google Search grounding/,
    );
  } finally {
    imported.cleanup();
  }
  assert.equal(requests.length, 2);
  const groundedBody = JSON.parse(requests[0].body);
  assert.deepEqual(groundedBody.tools, [{ google_search: {} }]);
  assert.equal(groundedBody.generationConfig.temperature, 0);
  assert.equal("responseJsonSchema" in groundedBody.generationConfig, false);
  const extractionBody = JSON.parse(requests[1].body);
  assert.equal(extractionBody.generationConfig.responseMimeType, "application/json");
  assert.deepEqual(extractionBody.generationConfig.responseJsonSchema, schema);
  assert.match(extractionBody.system_instruction.parts[0].text, /untrusted data/);
  assert.match(extractionBody.contents.at(-1).parts[0].text, /Nutrition listings conflict/);
  assert.match(extractionBody.contents.at(-1).parts[0].text, /https:\/\/clubtails\.example\/blue-hawaiian/);
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
  const requestStartLog = main.slice(main.indexOf('logger.flow("Request", "start"'), main.indexOf("for (const provider of callableProviders)"));
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
  assert.equal(settings.settingsVersion, 3);
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
  assert.deepEqual(settings.providerOrder, ["apple", "openai"]);
  assert.equal(settings.ollamaUrl, "");
  assert.equal(settings.ollamaModel, "");
  assert.equal(settings.openAiModel, "");
  assert.equal(settings.geminiModel, "");
});

test("gateway never downgrades future settings and merges only local changes", () => {
  const future = {
    settingsVersion: 4,
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
  assert.equal(merged.settingsVersion, 4);
  assert.equal(merged.openAiModel, "desktop-new");
  assert.equal(merged.geminiModel, "future-gemini");
  assert.deepEqual(merged.futureProvider, { model: "future-model" });
  assert.equal(sanitizeSettings(future).settingsVersion, 4);
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
    settingsVersion: 4,
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

  assert.equal(stored.settingsVersion, 4);
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

test("gateway uses device-local cloud credentials and reserves durable text work for the synced queue", async () => {
  assert.match(main, /deviceLocalCloudProviders\(request\)/);
  assert.match(main, /Image requests require Gemini to be configured in TPS AI Gateway on this device/);
  assert.match(main, /controller\?\.api\?\.isController\?\.\(\) === true/);
  assert.match(main, /this\.app\.vault\.create\(path, JSON\.stringify\(job, null, 2\)\)/);
  assert.match(main, /remoteAiJobIsClaimable\(job\)/);
  assert.match(main, /this\.completeStructuredLocally\(request, this\.isControllerDevice\(\) \? undefined : localProviders\)/);
  assert.match(main, /notifier\?\.sendNotification/);
  assert.match(main, /job\.metadata\?\.notifyOnCompletion === false/);
  assert.match(main, /Sent to the synced AI queue\. Another AI-enabled device can finish it\./);

  const { default: GatewayPlugin, validateInlineMedia } = await importGatewayPlugin();
  const plugin = Object.create(GatewayPlugin.prototype);
  plugin.settings = {
    providerOrder: ["gemini", "openai", "ollama"],
    geminiApiKeySecret: "gemini-ref",
    openAiApiKeySecret: "openai-ref",
  };
  plugin.isControllerDevice = () => false;
  plugin.readSecret = (name) => name === "gemini-ref" ? "device-gemini-secret" : "";
  let localCalls = 0;
  let remoteCalls = 0;
  let durableCalls = 0;
  const localRequests = [];
  plugin.completeStructuredLocally = async (request) => { localRequests.push(request); return { data: { ok: true }, provider: "gemini", model: "gemini-model", traceId: "local", attempts: 1 }; };
  plugin.completeStructuredRemotely = async () => { remoteCalls += 1; return { data: { ok: true }, provider: "gemini", model: "remote", traceId: "remote", attempts: 1 }; };
  plugin.completeStructuredDurably = async () => { durableCalls += 1; return { data: { ok: true }, provider: "gemini", model: "durable", traceId: "durable", attempts: 1 }; };
  const originalLocal = plugin.completeStructuredLocally;
  plugin.completeStructuredLocally = async (...args) => { localCalls += 1; return originalLocal(...args); };
  const base = { taskId: "device-local", messages: [{ role: "user", content: "Return ok." }], schema: { type: "object" } };
  assert.equal((await plugin.completeStructured(base)).traceId, "local");
  assert.equal((await plugin.completeStructured({ ...base, preferredProviders: ["gemini"], media: [{ mimeType: "image/jpeg", data: "aGVsbG8=" }] })).traceId, "local");
  assert.equal((await plugin.completeStructured({ ...base, preferredProviders: ["gemini"], grounding: "google-search" })).traceId, "local");
  assert.equal(localCalls, 3);
  assert.equal(remoteCalls, 0);
  assert.equal((await plugin.completeStructured({ ...base, durableJobId: "describe-food-job-123" })).traceId, "durable");
  assert.equal(durableCalls, 1);
  await assert.rejects(() => plugin.completeStructured({ ...base, durableJobId: "short" }), /durableJobId is invalid/);
  await assert.rejects(() => plugin.completeStructured({ ...base, durableJobId: "describe-food-image-123", media: [{ mimeType: "image/jpeg", data: "aGVsbG8=" }] }), /cannot contain images/);
  await assert.rejects(() => plugin.completeStructured({ ...base, grounding: "google-search", media: [{ mimeType: "image/jpeg", data: "aGVsbG8=" }] }), /cannot be combined with inline images/);
  assert.deepEqual(localRequests.map((request) => request.preferredProviders), [["gemini"], ["gemini"], ["gemini"]], "a user-role device must not stall on local Ollama when device Gemini is available");
  assert.doesNotThrow(() => validateInlineMedia({ ...base, media: [{ mimeType: "image/webp", data: "aGVsbG8=" }] }));
  assert.throws(() => validateInlineMedia({ ...base, media: [{ mimeType: "image/gif", data: "aGVsbG8=" }] }), /Unsupported inline image type/);

  plugin.readSecret = () => "";
  assert.equal((await plugin.completeStructured(base)).traceId, "remote");
  await assert.rejects(() => plugin.completeStructured({ ...base, preferredProviders: ["gemini"], media: [{ mimeType: "image/jpeg", data: "aGVsbG8=" }] }), /require Gemini/);
});

test("iOS routes eligible structured requests through TishOS Apple Intelligence", async () => {
  const { default: GatewayPlugin, tishOSAppleIntelligenceURL } = await importGatewayPlugin(true);
  assert.equal(
    tishOSAppleIntelligenceURL("health-job_1234"),
    "tishos://ai-gateway?job=health-job_1234",
  );
  assert.throws(() => tishOSAppleIntelligenceURL("short"), /job id is invalid/);

  const plugin = Object.create(GatewayPlugin.prototype);
  plugin.settings = {
    appleIntelligenceEnabled: true,
    providerOrder: ["apple", "gemini"],
  };
  plugin.isControllerDevice = () => true;
  let appleCalls = 0;
  let localCalls = 0;
  plugin.completeStructuredWithTishOSAppleIntelligence = async () => {
    appleCalls += 1;
    return {
      data: { ok: true },
      provider: "apple",
      model: "apple-on-device",
      traceId: "apple",
      attempts: 1,
    };
  };
  plugin.completeStructuredLocally = async () => {
    localCalls += 1;
    return {
      data: { ok: true },
      provider: "gemini",
      model: "gemini-model",
      traceId: "local",
      attempts: 1,
    };
  };
  const request = {
    taskId: "ios-structured",
    messages: [{ role: "user", content: "Return ok." }],
    schema: { type: "object" },
  };
  assert.equal((await plugin.completeStructured(request)).provider, "apple");
  assert.equal(appleCalls, 1);
  assert.equal(localCalls, 0);

  await plugin.completeStructured({
    ...request,
    media: [{ mimeType: "image/jpeg", data: "aGVsbG8=" }],
  });
  assert.equal(appleCalls, 1, "Apple handoff is text-only");
  assert.equal(localCalls, 1);
});

test("Apple handoff writes one explicit queue target and opens only the strict TishOS route", async () => {
  const { default: GatewayPlugin } = await importGatewayPlugin(true);
  const plugin = Object.create(GatewayPlugin.prototype);
  plugin.getDeviceId = () => "ios-device";
  let submittedJob;
  plugin.createRemoteJob = async (job) => {
    submittedJob = job;
    return queueFile(`${REMOTE_AI_QUEUE_FOLDER}/${job.id}.md`);
  };
  plugin.waitForRemoteJob = async () => ({
    data: { ok: true },
    provider: "apple",
    model: "apple-on-device",
    traceId: "apple",
    attempts: 1,
  });
  const events = [];
  plugin.app = { workspace: { trigger: (...args) => events.push(args) } };
  plugin.manifest = { id: "tps-ai-gateway" };
  const opened = [];
  const previousWindow = globalThis.window;
  globalThis.window = { open: (...args) => opened.push(args) };
  try {
    await plugin.completeStructuredWithTishOSAppleIntelligence({
      taskId: "health-describe-food",
      messages: [{ role: "user", content: "oatmeal" }],
      schema: { type: "object" },
      metadata: { workflow: "describe-food" },
    });
  } finally {
    globalThis.window = previousWindow;
  }

  assert.equal(submittedJob.executionTarget, "tishos-apple");
  assert.deepEqual(submittedJob.preferredProviders, ["apple"]);
  assert.match(opened[0][0], /^tishos:\/\/ai-gateway\?job=[a-z0-9_-]{8,160}$/i);
  assert.equal(opened[0][1], "_self");
  assert.equal(events.length, 1);
});

test("durable iOS work preserves its id and routes exclusively through TishOS Apple Intelligence", async () => {
  const { default: GatewayPlugin } = await importGatewayPlugin(true);
  const plugin = Object.create(GatewayPlugin.prototype);
  plugin.settings = {
    appleIntelligenceEnabled: true,
    providerOrder: ["apple", "gemini"],
  };
  plugin.getDeviceId = () => "ios-device";
  plugin.app = {
    vault: { getAbstractFileByPath: () => null },
  };
  let submittedJob;
  plugin.createRemoteJob = async (job) => {
    submittedJob = job;
    return queueFile(`${REMOTE_AI_QUEUE_FOLDER}/${job.id}.md`);
  };
  plugin.waitForRemoteJob = async () => ({
    data: { calories: 320 },
    provider: "apple",
    model: "apple-private-cloud",
    traceId: "apple-durable",
    attempts: 1,
  });
  const opened = [];
  const previousWindow = globalThis.window;
  globalThis.window = { open: (...args) => opened.push(args) };
  try {
    const result = await plugin.completeStructuredDurably({
      taskId: "health-describe-food",
      durableJobId: "health-describe-food-20260903",
      messages: [{ role: "user", content: "oatmeal and berries" }],
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["calories"],
        properties: { calories: { type: "number" } },
      },
    });
    assert.equal(result.provider, "apple");
  } finally {
    globalThis.window = previousWindow;
  }

  assert.equal(submittedJob.id, "health-describe-food-20260903");
  assert.equal(submittedJob.durable, true);
  assert.equal(submittedJob.executionTarget, "tishos-apple");
  assert.deepEqual(submittedJob.preferredProviders, ["apple"]);
  assert.deepEqual(opened, [[
    "tishos://ai-gateway?job=health-describe-food-20260903",
    "_self",
  ]]);
});

test("any device with a matching local cloud credential can finish durable queue work", async () => {
  const { default: GatewayPlugin } = await importGatewayPlugin();
  const plugin = Object.create(GatewayPlugin.prototype);
  plugin.settings = {
    providerOrder: ["gemini", "openai", "ollama"],
    geminiApiKeySecret: "gemini-ref",
    openAiApiKeySecret: "openai-ref",
  };
  plugin.isControllerDevice = () => false;
  plugin.readSecret = (name) => name === "gemini-ref" ? "device-gemini-secret" : "";
  plugin.getDeviceId = () => "phone";
  const job = {
    durable: true,
    requesterDeviceId: "phone",
    createdAt: new Date().toISOString(),
    taskId: "health.describe-food.extract",
    messages: [{ role: "user", content: "oatmeal and berries" }],
    schema: { type: "object" },
    preferredProviders: ["gemini"],
  };
  assert.equal(plugin.canProcessRemoteQueue(), true);
  assert.equal(plugin.canProcessRemoteJob(job), true);
  assert.equal(
    plugin.canProcessRemoteJob({ ...job, executionTarget: "tishos-apple" }),
    false,
    "Obsidian workers must leave explicit Apple jobs for TishOS",
  );
  assert.deepEqual(plugin.remoteJobLocalProviders(job), ["gemini"]);
  assert.equal(plugin.canProcessRemoteJob({ ...job, requesterDeviceId: "other-device" }), false, "a non-requester waits so the submitting device can claim first");
  assert.equal(plugin.canProcessRemoteJob({ ...job, requesterDeviceId: "other-device", createdAt: new Date(Date.now() - 60_000).toISOString() }), true, "an online Gemini device eventually recovers abandoned durable work");
  plugin.readSecret = () => "";
  assert.equal(plugin.canProcessRemoteQueue(), false);
  assert.equal(plugin.canProcessRemoteJob(job), false);
  assert.match(main, /Saved this AI request\. Another online device can finish it if needed\./);
  assert.match(main, /TPS_AI_JOB_PENDING/);
  assert.match(main, /durable-resumed/);
});

test("durable jobs resume completed results and user-role workers stay on eligible device providers", async () => {
  const { default: GatewayPlugin } = await importGatewayPlugin();
  const request = {
    taskId: "health.describe-food.extract",
    durableJobId: "describe-food-durable-123",
    messages: [{ role: "user", content: "oatmeal and berries" }],
    schema: { type: "object", additionalProperties: false, required: ["ok"], properties: { ok: { type: "boolean" } } },
    grounding: "google-search",
    preferredProviders: ["gemini"],
    metadata: { workflow: "describe-food" },
  };
  const completeJob = {
    version: 1,
    id: request.durableJobId,
    taskId: request.taskId,
    requesterDeviceId: "phone",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "complete",
    durable: true,
    messages: request.messages,
    schema: request.schema,
    grounding: request.grounding,
    preferredProviders: request.preferredProviders,
    metadata: request.metadata,
    result: { data: { ok: true }, provider: "gemini", model: "gemini-model", traceId: "trace", attempts: 1 },
  };
  const plugin = Object.create(GatewayPlugin.prototype);
  plugin.app = {
    vault: {
      getAbstractFileByPath: () => queueFile(`${REMOTE_AI_QUEUE_FOLDER}/${request.durableJobId}.md`),
      read: async () => JSON.stringify(completeJob),
    },
  };
  const resumed = await plugin.completeStructuredDurably(request);
  assert.deepEqual(resumed.data, { ok: true });
  await assert.rejects(() => plugin.completeStructuredDurably({ ...request, messages: [{ role: "user", content: "different" }] }), /different request/);
  await assert.rejects(() => plugin.completeStructuredDurably({ ...request, grounding: undefined }), /different request/);

  let submittedJob;
  const submittingPlugin = Object.create(GatewayPlugin.prototype);
  submittingPlugin.app = { vault: { getAbstractFileByPath: () => null } };
  submittingPlugin.getDeviceId = () => "requesting-device";
  submittingPlugin.createRemoteJob = async (job) => {
    submittedJob = job;
    return queueFile(`${REMOTE_AI_QUEUE_FOLDER}/${job.id}.md`);
  };
  submittingPlugin.canProcessRemoteJob = () => false;
  submittingPlugin.scheduleRemoteQueueScan = () => {};
  submittingPlugin.waitForRemoteJob = async () => completeJob.result;
  await submittingPlugin.completeStructuredDurably(request);
  assert.equal(submittedJob.durable, true, "new durable jobs must remain resumable after they sync and the app reopens");
  assert.equal(submittedJob.grounding, "google-search");

  const immediateOrder = [];
  const immediatePlugin = Object.create(GatewayPlugin.prototype);
  immediatePlugin.app = { vault: { getAbstractFileByPath: () => null } };
  immediatePlugin.getDeviceId = () => "requesting-device";
  immediatePlugin.createRemoteJob = async (job) => queueFile(`${REMOTE_AI_QUEUE_FOLDER}/${job.id}.md`);
  immediatePlugin.canProcessRemoteJob = () => true;
  immediatePlugin.processRemoteJob = async () => { immediateOrder.push("process"); };
  immediatePlugin.waitForRemoteJob = async () => { immediateOrder.push("read-complete"); return completeJob.result; };
  immediatePlugin.scheduleRemoteQueueScan = () => { throw new Error("a locally executable durable job must not wait for the background scanner"); };
  const immediate = await immediatePlugin.completeStructuredDurably(request);
  assert.equal(immediate.provider, "gemini");
  assert.deepEqual(immediateOrder, ["process", "read-complete"]);
  assert.match(main, /"durable-immediate"/);

  const writes = [];
  let exactProviders;
  plugin.app = { vault: { modify: async (_file, body) => writes.push(JSON.parse(body)) } };
  plugin.isControllerDevice = () => false;
  plugin.getDeviceId = () => "gemini-worker";
  plugin.remoteJobLocalProviders = () => ["gemini"];
  plugin.completeStructuredLocally = async (_request, providers) => {
    exactProviders = providers;
    return completeJob.result;
  };
  plugin.notifyRemoteJob = async () => {};
  await plugin.processRemoteJob(queueFile(`${REMOTE_AI_QUEUE_FOLDER}/worker.md`), { ...completeJob, id: "worker", status: "pending", result: undefined });
  assert.deepEqual(exactProviders, ["gemini"]);
  assert.deepEqual(writes.map((job) => job.status), ["processing", "complete"]);
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

test("remote queue skips a requested trailing pass after all processing authority is lost", async () => {
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
  plugin.settings = { openAiApiKeySecret: "", geminiApiKeySecret: "" };
  plugin.readSecret = () => "";
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
  assert.match(main, /title: "Device AI"/);
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
    "Google AI API key",
    "Google AI model",
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
