import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const outdir = await mkdtemp(join(tmpdir(), "tps-ai-gateway-contract-"));
const outfile = join(outdir, "contract.mjs");
await build({
  entryPoints: [fileURLToPath(new URL("../src/tps-ai-gateway-contract.ts", import.meta.url))],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "silent",
});
const contract = await import(pathToFileURL(outfile).href);

test.after(async () => {
  await rm(outdir, { recursive: true, force: true });
});

function createApi(overrides = {}) {
  let unregisterCalls = 0;
  const api = {
    apiVersion: 1,
    capabilities: {
      structuredCompletion: true,
      guardedDecisionSelection: true,
      guardedCapabilityExecution: true,
    },
    completeStructured(request) {
      assert.equal(this, api);
      return Promise.resolve({ data: request, provider: "ollama", model: "test", traceId: "trace", attempts: 1 });
    },
    choose(request) {
      assert.equal(this, api);
      return Promise.resolve({ data: { optionId: request.options[0].id, reason: "test" }, option: request.options[0], provider: "ollama", model: "test", traceId: "trace", attempts: 1 });
    },
    registerCapability() {
      assert.equal(this, api);
      return () => { unregisterCalls += 1; };
    },
    listCapabilities() {
      assert.equal(this, api);
      return [];
    },
    proposeCapability(request) {
      assert.equal(this, api);
      return Promise.resolve({ capabilityId: request.capabilityIds[0], input: {}, reason: "test", traceId: "trace" });
    },
    executeCapability(proposal) {
      assert.equal(this, api);
      return Promise.resolve(proposal);
    },
    ...overrides,
  };
  return { api, getUnregisterCalls: () => unregisterCalls };
}

const descriptor = (api) => ({
  protocolVersion: 1,
  providerPluginId: "tps-ai-gateway",
  api,
});

test("parses a valid descriptor into frozen receiver-bound snapshots", async () => {
  const { api, getUnregisterCalls } = createApi();
  const sourceDescriptor = descriptor(api);
  const parsed = contract.parseTPSAiGatewayServiceDescriptor(sourceDescriptor);
  assert.ok(parsed);
  assert.equal(parsed.sourceDescriptor, sourceDescriptor);
  assert.equal(parsed.api.sourceApi, api);
  assert.equal(Object.isFrozen(parsed), true);
  assert.equal(Object.isFrozen(parsed.api), true);
  assert.equal(Object.isFrozen(parsed.api.capabilities), true);
  assert.deepEqual((await parsed.api.completeStructured({ taskId: "one", messages: [], schema: {} })).data, {
    taskId: "one",
    messages: [],
    schema: {},
  });
  await parsed.api.choose({ taskId: "choose", messages: [], options: [{ id: "one", label: "One" }] });
  await parsed.api.proposeCapability({ taskId: "propose", messages: [], capabilityIds: ["cap"] });
  await parsed.api.executeCapability({ capabilityId: "cap", input: {}, reason: "test", traceId: "trace" }, { sourcePluginId: "consumer", confirmed: true });
  parsed.api.listCapabilities();
  const unregister = parsed.api.registerCapability({ id: "cap", ownerPluginId: "consumer", description: "test", inputSchema: {}, execute: async () => undefined });
  unregister();
  unregister();
  assert.equal(getUnregisterCalls(), 1);
});

test("snapshots each callable once and ignores later source mutation", async () => {
  const reads = new Map();
  const { api: base } = createApi();
  base.listCapabilities = function () { return []; };
  const api = new Proxy(base, {
    get(target, property, receiver) {
      reads.set(property, (reads.get(property) || 0) + 1);
      return Reflect.get(target, property, receiver);
    },
  });
  const parsed = contract.parseTPSAiGatewayApiSnapshot(api);
  assert.ok(parsed);
  for (const property of ["apiVersion", "capabilities", "completeStructured", "choose", "registerCapability", "listCapabilities", "proposeCapability", "executeCapability"]) {
    assert.equal(reads.get(property), 1, `${property} should be read exactly once`);
  }
  base.listCapabilities = () => { throw new Error("mutated method should not run"); };
  assert.deepEqual(parsed.listCapabilities(), []);
});

test("rejects malformed, spoofed, incomplete, and hostile descriptors without throwing", () => {
  const { api } = createApi();
  const malformed = [
    null,
    [],
    {},
    { ...descriptor(api), protocolVersion: 2 },
    { ...descriptor(api), providerPluginId: "spoof" },
    descriptor({ ...api, apiVersion: 2 }),
    descriptor({ ...api, capabilities: { ...api.capabilities, structuredCompletion: false } }),
    descriptor({ ...api, executeCapability: undefined }),
  ];
  for (const value of malformed) {
    assert.equal(contract.parseTPSAiGatewayServiceDescriptor(value), undefined);
  }
  for (const hostile of [
    new Proxy({}, { get() { throw new Error("descriptor getter"); } }),
    descriptor(new Proxy({}, { get() { throw new Error("api getter"); } })),
    descriptor({ ...api, capabilities: new Proxy({}, { get() { throw new Error("capabilities getter"); } }) }),
  ]) {
    assert.doesNotThrow(() => contract.parseTPSAiGatewayServiceDescriptor(hostile));
    assert.equal(contract.parseTPSAiGatewayServiceDescriptor(hostile), undefined);
  }
});

test("rejects invalid unregister callbacks at invocation time", () => {
  const { api } = createApi({ registerCapability: () => undefined });
  const parsed = contract.parseTPSAiGatewayApiSnapshot(api);
  assert.ok(parsed);
  assert.throws(
    () => parsed.registerCapability({ id: "cap", ownerPluginId: "consumer", description: "test", inputSchema: {}, execute: async () => undefined }),
    /invalid capability unregister callback/,
  );
});

test("parses service requests with exact receiver identity and bounded consumer IDs", () => {
  let receiver;
  let accepted;
  const request = {
    protocolVersion: 1,
    consumerPluginId: "tps-health",
    accept(value) {
      receiver = this;
      accepted = value;
    },
  };
  const parsed = contract.parseTPSAiGatewayServiceRequest(request);
  assert.ok(parsed);
  assert.equal(Object.isFrozen(parsed), true);
  parsed.accept("descriptor");
  assert.equal(receiver, request);
  assert.equal(accepted, "descriptor");
  for (const consumerPluginId of ["", " tps-health", "tps-health ", "x".repeat(129)]) {
    assert.equal(contract.parseTPSAiGatewayServiceRequest({ ...request, consumerPluginId }), undefined);
  }
  assert.equal(contract.parseTPSAiGatewayServiceRequest({ ...request, protocolVersion: 2 }), undefined);
  assert.equal(contract.parseTPSAiGatewayServiceRequest({ ...request, accept: true }), undefined);
  assert.equal(contract.parseTPSAiGatewayServiceRequest(new Proxy({}, { get() { throw new Error("hostile request"); } })), undefined);
});
