import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const outdir = await mkdtemp(join(tmpdir(), "tps-ai-gateway-service-"));
const outfile = join(outdir, "main.mjs");
const obsidianStub = `
export class TFile {
  constructor(path = "file.md") { this.path = path; this.extension = path.split(".").pop(); this.stat = { size: 0 }; }
}
export class TFolder {
  constructor(path = "folder") { this.path = path; this.children = []; }
}
class SyntheticWorkspace {
  constructor() { this.listeners = new Map(); this.layoutCallbacks = []; }
  reset() { this.listeners.clear(); this.layoutCallbacks = []; }
  on(name, callback) {
    const ref = { name, callback };
    const listeners = this.listeners.get(name) || new Set();
    listeners.add(ref);
    this.listeners.set(name, listeners);
    return ref;
  }
  offref(ref) { this.listeners.get(ref.name)?.delete(ref); }
  trigger(name, ...args) {
    for (const ref of Array.from(this.listeners.get(name) || [])) ref.callback(...args);
  }
  onLayoutReady(callback) { this.layoutCallbacks.push(callback); }
}
globalThis.__tpsAiWorkspace = new SyntheticWorkspace();
const vault = {
  getName: () => "Synthetic Test Vault",
  getAbstractFileByPath: () => null,
  create: async (path) => new TFile(path),
  createFolder: async () => undefined,
  read: async () => "",
  process: async (_file, callback) => callback(""),
  on: (name, callback) => ({ name: "vault:" + name, callback }),
};
const secrets = new Map();
export class Plugin {
  constructor() {
    this.manifest = { id: "tps-ai-gateway" };
    this.app = {
      vault,
      workspace: globalThis.__tpsAiWorkspace,
      secretStorage: {
        getSecret: (name) => secrets.get(name) || "",
        setSecret: (name, value) => { secrets.set(name, value); },
      },
    };
  }
  async loadData() { return null; }
  async saveData() {}
  addCommand(command) { (this.__commands ||= []).push(command); }
  addSettingTab(tab) { this.__settingTab = tab; }
  registerEvent(ref) { (this.__events ||= []).push(ref); }
  registerInterval(interval) { (this.__intervals ||= []).push(interval); }
  register(callback) { (this.__cleanups ||= []).push(callback); }
}
export class Notice { constructor(message) { (globalThis.__tpsAiNotices ||= []).push(String(message)); } }
export class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = {}; } }
export class SecretComponent {
  constructor() {}
  setValue() { return this; }
  onChange() { return this; }
}
export class Setting {
  constructor() {}
  setName() { return this; }
  setDesc() { return this; }
  setHeading() { return this; }
  addToggle() { return this; }
  addText() { return this; }
  addComponent() { return this; }
}
export class App {}
export class Events {}
export async function requestUrl(request) {
  if (typeof globalThis.__tpsAiRequestUrl !== "function") throw new Error("Unexpected requestUrl call");
  return await globalThis.__tpsAiRequestUrl(request);
}
`;

await build({
  entryPoints: [fileURLToPath(new URL("../src/main.ts", import.meta.url))],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "silent",
  plugins: [{
    name: "synthetic-obsidian",
    setup(buildApi) {
      buildApi.onResolve({ filter: /^obsidian$/ }, () => ({ path: "obsidian", namespace: "synthetic" }));
      buildApi.onLoad({ filter: /.*/, namespace: "synthetic" }, () => ({ contents: obsidianStub, loader: "js" }));
    },
  }],
});

const originalWindow = globalThis.window;
let nextTimerId = 1;
globalThis.window = {
  setInterval: () => nextTimerId++,
  clearInterval: () => undefined,
  setTimeout: () => nextTimerId++,
  clearTimeout: () => undefined,
  localStorage: {
    values: new Map(),
    getItem(key) { return this.values.get(key) || null; },
    setItem(key, value) { this.values.set(key, String(value)); },
  },
};
const { default: TPSAiGateway } = await import(pathToFileURL(outfile).href);

test.after(async () => {
  globalThis.window = originalWindow;
  delete globalThis.__tpsAiWorkspace;
  delete globalThis.__tpsAiNotices;
  delete globalThis.__tpsAiRequestUrl;
  await rm(outdir, { recursive: true, force: true });
});

const workspace = globalThis.__tpsAiWorkspace;

test.beforeEach(() => {
  workspace.reset();
  globalThis.__tpsAiNotices = [];
  globalThis.__tpsAiRequestUrl = async () => { throw new Error("provider transport must not run in service tests"); };
});

async function loadPlugin({ loadData = async () => null } = {}) {
  const plugin = new TPSAiGateway();
  plugin.loadData = loadData;
  await plugin.onload();
  return plugin;
}

function requestDescriptor(consumerPluginId = "test-consumer") {
  let accepted;
  workspace.trigger("tps:ai-gateway-api-request", {
    protocolVersion: 1,
    consumerPluginId,
    accept: (descriptor) => { accepted = descriptor; },
  });
  return accepted;
}

const capability = (id = "test-capability") => ({
  id,
  ownerPluginId: "test-consumer",
  description: "Synthetic capability",
  inputSchema: { type: "object" },
  execute: async () => "done",
});

test("publishes one frozen descriptor, answers late requests, and withdraws exact identity", async () => {
  const available = [];
  const unavailable = [];
  workspace.on("tps:ai-gateway-api-available", (value) => available.push(value));
  workspace.on("tps:ai-gateway-api-unavailable", (value) => unavailable.push(value));
  const plugin = await loadPlugin();
  assert.equal(available.length, 1);
  const descriptor = available[0];
  assert.equal(descriptor.protocolVersion, 1);
  assert.equal(descriptor.providerPluginId, "tps-ai-gateway");
  assert.equal(descriptor.api, plugin.api);
  assert.equal(requestDescriptor(), descriptor);
  assert.equal(Object.isFrozen(descriptor), true);
  assert.equal(Object.isFrozen(descriptor.api), true);
  assert.equal(Object.isFrozen(descriptor.api.capabilities), true);
  assert.equal(Object.prototype.hasOwnProperty.call(plugin.app, "tpsAiGateway"), false);
  plugin.onunload();
  assert.deepEqual(unavailable, [descriptor]);
  assert.equal(requestDescriptor(), undefined);
});

test("marks the API unavailable before the withdrawal announcement", async () => {
  const plugin = await loadPlugin();
  const descriptor = requestDescriptor();
  let reentrantError;
  workspace.on("tps:ai-gateway-api-unavailable", (withdrawn) => {
    assert.equal(withdrawn, descriptor);
    try {
      withdrawn.api.listCapabilities();
    } catch (error) {
      reentrantError = error;
    }
  });
  plugin.onunload();
  assert.equal(reentrantError?.code, "not-ready");
});

test("every stale API method is lifecycle-fenced and cannot repopulate capabilities", async () => {
  const plugin = await loadPlugin();
  const api = plugin.api;
  api.registerCapability(capability("active"));
  assert.equal(api.listCapabilities().length, 1);
  plugin.onunload();
  assert.equal(plugin.capabilities.size, 0);
  assert.throws(() => api.registerCapability(capability("stale")), (error) => error.code === "not-ready");
  assert.throws(() => api.listCapabilities(), (error) => error.code === "not-ready");
  const asyncCalls = [
    () => api.completeStructured({ taskId: "stale", messages: [{ role: "user", content: "test" }], schema: {} }),
    () => api.choose({ taskId: "stale", messages: [], options: [{ id: "one", label: "One" }] }),
    () => api.proposeCapability({ taskId: "stale", messages: [], capabilityIds: ["stale"] }),
    () => api.executeCapability({ capabilityId: "stale", input: {}, reason: "test", traceId: "trace" }, { sourcePluginId: "consumer", confirmed: true }),
  ];
  for (const invoke of asyncCalls) {
    await assert.rejects(invoke, (error) => error.code === "not-ready");
  }
  assert.equal(plugin.capabilities.size, 0);
});

test("same-instance reload creates new API and descriptor identities", async () => {
  const plugin = await loadPlugin();
  const firstDescriptor = requestDescriptor();
  const firstApi = firstDescriptor.api;
  plugin.onunload();
  await plugin.onload();
  const secondDescriptor = requestDescriptor();
  assert.ok(secondDescriptor);
  assert.notEqual(secondDescriptor, firstDescriptor);
  assert.notEqual(secondDescriptor.api, firstApi);
  assert.throws(() => firstApi.listCapabilities(), (error) => error.code === "not-ready");
  assert.deepEqual(secondDescriptor.api.listCapabilities(), []);
  plugin.onunload();
});

test("an unload during deferred settings load never publishes an API", async () => {
  let releaseLoad;
  const plugin = new TPSAiGateway();
  plugin.loadData = async () => await new Promise((resolve) => { releaseLoad = resolve; });
  const loading = plugin.onload();
  plugin.onunload();
  releaseLoad(null);
  await loading;
  assert.equal(Object.prototype.hasOwnProperty.call(plugin, "api"), false);
  assert.equal(requestDescriptor(), undefined);
});

test("hostile, shape-shifting, and throwing requests are isolated", async () => {
  const plugin = await loadPlugin();
  assert.doesNotThrow(() => workspace.trigger("tps:ai-gateway-api-request", new Proxy({}, {
    get() { throw new Error("hostile request getter"); },
  })));
  assert.doesNotThrow(() => workspace.trigger("tps:ai-gateway-api-request", {
    protocolVersion: 1,
    consumerPluginId: "throwing-consumer",
    accept: () => { throw new Error("consumer rejected descriptor"); },
  }));
  const reads = new Map();
  let accepted;
  const values = {
    protocolVersion: 1,
    consumerPluginId: "shape-shifting-consumer",
    accept: (value) => { accepted = value; },
  };
  const request = new Proxy({}, {
    get(_target, property) {
      if (!(property in values)) return undefined;
      const count = (reads.get(property) || 0) + 1;
      reads.set(property, count);
      if (count > 1) throw new Error(`request ${String(property)} re-read`);
      return values[property];
    },
  });
  assert.doesNotThrow(() => workspace.trigger("tps:ai-gateway-api-request", request));
  assert.equal(accepted.api, plugin.api);
  for (const count of reads.values()) assert.equal(count, 1);
  plugin.onunload();
});

test("misbehaving availability listeners cannot fail provider load or unload", async () => {
  const throwingAvailable = workspace.on("tps:ai-gateway-api-available", () => {
    throw new Error("available listener failed");
  });
  const plugin = await loadPlugin();
  workspace.offref(throwingAvailable);
  assert.ok(requestDescriptor());
  workspace.on("tps:ai-gateway-api-unavailable", () => {
    throw new Error("unavailable listener failed");
  });
  assert.doesNotThrow(() => plugin.onunload());
});
