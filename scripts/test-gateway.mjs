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
const stylesSource = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
const schemaModule = transformSync(schemaSource, { loader: "ts", format: "esm", target: "es2020" }).code;
const { assertSchema } = await import(`data:text/javascript;base64,${Buffer.from(schemaModule).toString("base64")}`);
const settingsModule = transformSync(settingsSource, { loader: "ts", format: "esm", target: "es2020" }).code;
const {
  resolveDeviceSettings,
  AiGatewaySettingsSaveCoordinator,
  changedSettingsKeys,
  mergeChangedSettings,
  reconcilePersistedSettings,
  sanitizeSettings,
} = await import(`data:text/javascript;base64,${Buffer.from(settingsModule).toString("base64")}`);
const loggerModule = transformSync(loggerSource, { loader: "ts", format: "esm", target: "es2020" }).code;
const { errorSummary, metadataSummary } = await import(`data:text/javascript;base64,${Buffer.from(loggerModule).toString("base64")}`);
const timeoutModule = transformSync(timeoutSource, { loader: "ts", format: "esm", target: "es2020" }).code;
const { withProviderTimeout } = await import(`data:text/javascript;base64,${Buffer.from(timeoutModule).toString("base64")}`);

const clone = (value) => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve;
  const promise = new Promise((complete) => { resolve = complete; });
  return { promise, resolve };
};

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
  assert.match(main, /features: \{ googleSearchGrounding: true, appleIntelligence: false, appleShortcuts: Boolean\(Platform.isMacOS \|\| Platform.isIosApp\) \}/);
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
  assert.match(main, /logger\.errorSummary\(error, \[credentials\.openAiApiKey, credentials\.geminiApiKey, credentials\.compatibleApiKey\]\)/);
});

test("gateway diagnostics never log caller-controlled metadata values", () => {
  const summary = metadataSummary({ sourcePluginId: "tps-health", noteBody: "private health details" });
  assert.deepEqual(summary, { metadataFieldCount: 2 });
  assert.doesNotMatch(JSON.stringify(summary), /tps-health|private health details|sourcePluginId|noteBody/);
  const requestStartLog = main.slice(main.indexOf('logger.flow("Request", "start"'), main.indexOf("for (const provider of callableProviders)"));
  assert.match(requestStartLog, /\.\.\.logger\.metadataSummary\(request\.metadata\)/);
  assert.doesNotMatch(requestStartLog, /metadata: request\.metadata/);
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

test("direct device credentials preserve text, image and grounding validation", async()=>{
 const {default:Gateway,validateInlineMedia}=await importGatewayPlugin();
 const plugin=Object.create(Gateway.prototype);plugin.settings={providerOrder:['gemini','openai'],geminiApiKeySecret:'gemini',openAiApiKeySecret:'openai'};
 plugin.readSecret=name=>name==='gemini'?'synthetic':'';
 const calls=[];plugin.completeStructuredLocally=async request=>{calls.push(request);return {provider:'gemini',attempts:1};};
 const request={taskId:'direct',messages:[{role:'user',content:'synthetic'}],schema:{type:'object'}};
 for(const options of [{},{media:[{mimeType:'image/jpeg',data:'aGVsbG8='}]},{grounding:'google-search'}])assert.equal((await plugin.completeStructured({...request,...options})).provider,'gemini');
 assert.equal(calls.length,3);
 await assert.rejects(plugin.completeStructured({...request,durableJobId:'existing-job'}),/Durable AI jobs are retired/);
 await assert.rejects(plugin.completeStructured({...request,grounding:'google-search',media:[{mimeType:'image/jpeg',data:'aGVsbG8='}]}),/cannot be combined/);
 assert.throws(()=>validateInlineMedia({...request,media:[{mimeType:'image/gif',data:'aGVsbG8='}]}),/Unsupported inline image/);
 plugin.readSecret=()=>'';await assert.rejects(plugin.completeStructured(request),/File-queue fallback is retired/);assert.equal(calls.length,3);
});

test("gateway settings keep one native provider selector and one optional disclosure", () => {
  for (const label of ["AI connection", "Provider", "Backup provider", "OpenAI API key", "OpenAI model", "Google AI API key", "Google AI model", "Use local Ollama", "Ollama URL", "Ollama model", "Retired Apple bridge", "Enable logging", "Connect", "Test connection"]) assert.ok(main.includes(label), label);
  assert.equal((main.match(/createEl\("details"/g) || []).length, 1);
  assert.match(main, /"aria-label", "AI provider"/);
  assert.match(main, /focus\(\{ preventScroll: true \}\)/);
  assert.match(stylesSource, /:focus-visible/);assert.match(stylesSource, /height: auto/);
  assert.match(stylesSource, /@media \(max-width: 700px\)/);assert.match(stylesSource, /flex-direction: column/);
});

test("device provider settings isolate two devices and retain explicit disabled values", () => {
  const legacy = {ollamaUrl:"http://old-host:11434",ollamaEnabled:true};
  const first = resolveDeviceSettings(null, legacy);
  const second = resolveDeviceSettings(null, legacy);
  first.ollamaEnabled = false; first.ollamaUrl = "http://localhost:11434";
  assert.equal(resolveDeviceSettings(first, {ollamaEnabled:true}).ollamaEnabled, false);
  assert.equal(resolveDeviceSettings(second, first).ollamaUrl, legacy.ollamaUrl);
  assert.match(main, /loadLatest: async \(\) => this.app.loadLocalStorage\(DEVICE_SETTINGS_KEY\)/);
});


test("direct primary and configured backup run in order",async()=>{
 const {default:Gateway}=await importGatewayPlugin();const plugin=Object.create(Gateway.prototype);
 plugin.settings=sanitizeSettings({settingsVersion:3,providerOrder:['openai','gemini']});plugin.readSecret=()=> 'synthetic';
 const calls=[];plugin.completeStructuredLocally=async (_request,[provider])=>{calls.push(provider);if(provider==='openai')throw Error('unavailable');return {provider,attempts:1};};
 const result=await plugin.completeStructured({taskId:'backup',messages:[{role:'user',content:'synthetic'}],schema:{type:'object'}});
 assert.equal(result.provider,'gemini');assert.equal(result.attempts,2);assert.deepEqual(calls,['openai','gemini']);
});

test("Ollama works on a user device and no backup does not call another provider", async () => {
  const { default: Gateway } = await importGatewayPlugin();
  const plugin = Object.create(Gateway.prototype);
  plugin.settings = sanitizeSettings({ settingsVersion: 3, providerOrder: ["ollama"], ollamaEnabled: true });
  plugin.isControllerDevice = () => false;
  plugin.readSecret = () => "";
  const calls = [];
  plugin.completeStructuredLocally = async (_request, exact) => { calls.push(exact); return { provider: "ollama" }; };
  plugin.completeStructuredRemotely = async () => { throw new Error("unexpected queue"); };
  const request = { taskId: "local", messages: [{ role: "user", content: "test" }], schema: { type: "object" } };
  assert.equal((await plugin.completeStructured(request)).provider, "ollama");
  assert.deepEqual(calls, [["ollama"]]);
  plugin.completeStructuredLocally = async () => { throw new Error("offline"); };
  await assert.rejects(() => plugin.completeStructured(request), /offline/);
  plugin.settings.providerOrder = [];
  await assert.rejects(() => plugin.completeStructured(request), /Choose a primary/);
});

test("unload during a failed request prevents starting a backup or another diagnostic", async () => {
  const { default: Gateway } = await importGatewayPlugin();
  const plugin = Object.create(Gateway.prototype);
  plugin.settings = sanitizeSettings({providerOrder: ["openai", "gemini"]});
  plugin.readSecret = () => "synthetic";
  const calls = [];
  plugin.completeStructuredLocally = async (_request, [provider]) => {
    calls.push(provider); plugin.unloading = true; throw new Error("cancelled");
  };
  const request = {taskId: "unload", messages: [{role: "user", content: "synthetic"}], schema: {type: "object"}};
  await assert.rejects(plugin.completeStructured(request), /closed/);
  assert.deepEqual(calls, ["openai"]);
  await assert.rejects(Gateway.prototype.completeStructuredLocally.call(plugin, request, ["gemini-cli"]), /closed/);
  await assert.rejects(plugin.completeAppleShortcut(request), /closed/);
});


test("compatible API uses the explicit URL/model/secret and rejects unsafe endpoints", async () => {
  const calls=[];const imported=await importProvidersModule(async options=>{calls.push(options);return {status:200,json:{choices:[{message:{content:'{"ok":true}'}}]}};});
  try {
    const settings=sanitizeSettings({compatibleUrl:'https://api.example.test/v1/',compatibleModel:'model'});
    const result=await imported.module.callProvider('compatible',settings,{openAiApiKey:'',geminiApiKey:'',compatibleApiKey:'synthetic-key'},[{role:'user',content:'synthetic'}],{type:'object'});
    assert.equal(result.text,'{"ok":true}');assert.equal(calls[0].url,'https://api.example.test/v1/chat/completions');
    assert.equal(calls[0].headers.Authorization,'Bearer synthetic-key');assert.equal(JSON.parse(calls[0].body).model,'model');
    for(const url of ['http://remote.test/v1','https://u:p@host/v1','https://host/v1?key=bad','file:///tmp/test'])assert.throws(()=>imported.module.validateCompatibleUrl(url));
    assert.equal(imported.module.validateCompatibleUrl('http://localhost:1234/v1'),'http://localhost:1234/v1');
  } finally { imported.cleanup(); }
});
