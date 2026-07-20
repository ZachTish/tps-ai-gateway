import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const outdir = await mkdtemp(join(tmpdir(), "tps-ai-gateway-client-"));
const outfile = join(outdir, "client.mjs");
await build({
  entryPoints: [fileURLToPath(new URL("../src/tps-ai-gateway-client.ts", import.meta.url))],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "silent",
});
const { TPSAiGatewayClient } = await import(pathToFileURL(outfile).href);

test.after(async () => {
  await rm(outdir, { recursive: true, force: true });
});

class FakeWorkspace {
  listeners = new Map();
  requestCount = 0;
  throwOnRequest = false;

  on(name, callback) {
    const listeners = this.listeners.get(name) || new Set();
    listeners.add(callback);
    this.listeners.set(name, listeners);
    return { name, callback };
  }

  offref(ref) {
    this.listeners.get(ref.name)?.delete(ref.callback);
  }

  trigger(name, ...args) {
    if (name === "tps:ai-gateway-api-request") {
      this.requestCount += 1;
      if (this.throwOnRequest) throw new Error("request listener failed");
    }
    for (const callback of [...(this.listeners.get(name) || [])]) callback(...args);
  }

  listenerCount(name) {
    return this.listeners.get(name)?.size || 0;
  }
}

function createApi(label) {
  const api = {
    apiVersion: 1,
    capabilities: {
      structuredCompletion: true,
      guardedDecisionSelection: true,
      guardedCapabilityExecution: true,
    },
    completeStructured: async () => ({ data: label, provider: "ollama", model: "test", traceId: label, attempts: 1 }),
    choose: async (request) => ({ data: { optionId: request.options[0].id, reason: label }, option: request.options[0], provider: "ollama", model: "test", traceId: label, attempts: 1 }),
    registerCapability: () => () => undefined,
    listCapabilities: () => [],
    proposeCapability: async (request) => ({ capabilityId: request.capabilityIds[0], input: {}, reason: label, traceId: label }),
    executeCapability: async () => label,
  };
  return api;
}

const descriptor = (api) => ({ protocolVersion: 1, providerPluginId: "tps-ai-gateway", api });

const startClient = (app, transitions = []) => {
  const refs = [];
  const client = new TPSAiGatewayClient(app, "test-consumer");
  client.start((ref) => refs.push(ref), (api) => transitions.push(api?.sourceApi));
  return { client, refs };
};

test("request handshake discovers a provider loaded before the consumer", () => {
  const workspace = new FakeWorkspace();
  const api = createApi("current");
  const current = descriptor(api);
  workspace.on("tps:ai-gateway-api-request", (request) => request.accept(current));
  const transitions = [];
  const { client } = startClient({ workspace }, transitions);
  assert.equal(client.getApi()?.sourceApi, api);
  assert.deepEqual(transitions, [api]);
  assert.ok(workspace.requestCount >= 2);
});

test("AVAILABLE supports consumer-first load and matching UNAVAILABLE withdraws it", () => {
  const workspace = new FakeWorkspace();
  const transitions = [];
  const { client } = startClient({ workspace }, transitions);
  const api = createApi("later");
  const current = descriptor(api);
  assert.deepEqual(transitions, [undefined]);
  workspace.trigger("tps:ai-gateway-api-available", current);
  assert.equal(client.getApi()?.sourceApi, api);
  workspace.trigger("tps:ai-gateway-api-unavailable", current);
  assert.equal(client.getApi(), undefined);
  assert.deepEqual(transitions, [undefined, api, undefined]);
});

test("stale withdrawal cannot clear a newer provider", () => {
  const workspace = new FakeWorkspace();
  const transitions = [];
  const { client } = startClient({ workspace }, transitions);
  const oldApi = createApi("old");
  const newApi = createApi("new");
  const oldDescriptor = descriptor(oldApi);
  const newDescriptor = descriptor(newApi);
  workspace.trigger("tps:ai-gateway-api-available", oldDescriptor);
  workspace.trigger("tps:ai-gateway-api-available", newDescriptor);
  workspace.trigger("tps:ai-gateway-api-unavailable", oldDescriptor);
  assert.equal(client.getApi()?.sourceApi, newApi);
  assert.deepEqual(transitions, [undefined, oldApi, newApi]);
});

test("a delayed request acceptance cannot overwrite a newer AVAILABLE descriptor", () => {
  const workspace = new FakeWorkspace();
  let delayedRequest;
  workspace.on("tps:ai-gateway-api-request", (request) => { delayedRequest = request; });
  const { client } = startClient({ workspace });
  const oldApi = createApi("old");
  const newApi = createApi("new");
  workspace.trigger("tps:ai-gateway-api-available", descriptor(newApi));
  delayedRequest.accept(descriptor(oldApi));
  assert.equal(client.getApi()?.sourceApi, newApi);
});

test("malformed and hostile descriptors fail closed", () => {
  const workspace = new FakeWorkspace();
  const { client } = startClient({ workspace });
  const hostile = new Proxy({}, { get() { throw new Error("hostile descriptor"); } });
  assert.doesNotThrow(() => workspace.trigger("tps:ai-gateway-api-available", hostile));
  workspace.trigger("tps:ai-gateway-api-available", { protocolVersion: 1, providerPluginId: "spoof", api: createApi("spoof") });
  assert.equal(client.getApi(), undefined);
});

test("throwing availability callbacks are isolated from client state", () => {
  const workspace = new FakeWorkspace();
  const client = new TPSAiGatewayClient({ workspace }, "consumer");
  client.start(() => undefined, () => { throw new Error("consumer callback"); });
  const api = createApi("valid");
  assert.doesNotThrow(() => workspace.trigger("tps:ai-gateway-api-available", descriptor(api)));
  assert.equal(client.getApi()?.sourceApi, api);
});

test("failed requests preserve a previously validated descriptor", () => {
  const workspace = new FakeWorkspace();
  const { client } = startClient({ workspace });
  const api = createApi("valid");
  workspace.trigger("tps:ai-gateway-api-available", descriptor(api));
  workspace.throwOnRequest = true;
  assert.equal(client.getApi()?.sourceApi, api);
});

test("start and dispose are idempotent and old listeners cannot repopulate a disposed client", () => {
  const workspace = new FakeWorkspace();
  const transitions = [];
  const { client } = startClient({ workspace }, transitions);
  client.start(() => { throw new Error("second start must be ignored"); });
  assert.equal(workspace.listenerCount("tps:ai-gateway-api-available"), 1);
  const requestsBeforeDispose = workspace.requestCount;
  client.dispose();
  client.dispose();
  workspace.trigger("tps:ai-gateway-api-available", descriptor(createApi("stale")));
  assert.equal(client.getApi(), undefined);
  assert.equal(workspace.requestCount, requestsBeforeDispose);
});

test("restart ignores callbacks from the prior lifecycle and accepts the new lifecycle", () => {
  const workspace = new FakeWorkspace();
  let delayedOldRequest;
  workspace.on("tps:ai-gateway-api-request", (request) => {
    if (!delayedOldRequest) delayedOldRequest = request;
  });
  const client = new TPSAiGatewayClient({ workspace }, "consumer");
  client.start(() => undefined);
  client.dispose();
  client.start(() => undefined);
  const currentApi = createApi("current");
  workspace.trigger("tps:ai-gateway-api-available", descriptor(currentApi));
  delayedOldRequest.accept(descriptor(createApi("old")));
  assert.equal(client.getApi()?.sourceApi, currentApi);
});

test("client never reads App monkeypatch or private plugin-registry surfaces", () => {
  const workspace = new FakeWorkspace();
  const app = new Proxy({ workspace }, {
    get(target, property, receiver) {
      if (property === "plugins" || property === "tpsAiGateway") {
        throw new Error(`unsupported surface read: ${String(property)}`);
      }
      return Reflect.get(target, property, receiver);
    },
  });
  assert.doesNotThrow(() => {
    const { client } = startClient(app);
    assert.equal(client.getApi(), undefined);
  });
});
