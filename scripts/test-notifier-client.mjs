import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const outdir = await mkdtemp(join(tmpdir(), "tps-ai-notifier-client-"));
const outfile = join(outdir, "notifier-client.mjs");
await build({
  entryPoints: [fileURLToPath(new URL("../src/tps-notifier-client.ts", import.meta.url))],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  logLevel: "silent",
});
const { TPSNotifierClient } = await import(pathToFileURL(outfile).href);

test.after(async () => {
  await rm(outdir, { recursive: true, force: true });
});

class FakeWorkspace {
  listeners = new Map();

  on(name, callback) {
    const listeners = this.listeners.get(name) || [];
    listeners.push(callback);
    this.listeners.set(name, listeners);
    return { name, callback };
  }

  trigger(name, ...args) {
    for (const callback of this.listeners.get(name) || []) callback(...args);
  }
}

const createApi = (send) => ({
  apiVersion: 2,
  capabilities: {
    structuredReceipts: true,
    redactedDiagnostics: true,
    stableSequenceIds: false,
  },
  send,
  validate: () => ({
    valid: true,
    serverHost: "ntfy.example",
    secure: true,
    priority: 3,
    hasClick: false,
    bodyBytes: 4,
  }),
});

const descriptor = (api) => ({
  protocolVersion: 1,
  providerPluginId: "tps-messager",
  api,
});

const startClient = (app, options) => {
  const client = new TPSNotifierClient(app, "tps-ai-gateway", options);
  client.start(() => undefined);
  return client;
};

test("request handshake resolves a provider already loaded before the consumer", async () => {
  const workspace = new FakeWorkspace();
  const api = createApi(async () => ({ outcome: "accepted", httpStatus: 200, providerMessageId: "message-1" }));
  workspace.on("tps:notifier-api-request", (request) => request.accept(descriptor(api)));
  const client = startClient({ workspace });
  const result = await client.send({ title: "Complete", body: "Done" });
  assert.deepEqual(result, {
    state: "accepted",
    transport: "notifier-v2",
    evidence: "structured-receipt",
    attempted: true,
    httpStatus: 200,
    providerMessageId: "message-1",
  });
});

test("stale unavailable events cannot clear a newer API object", async () => {
  const workspace = new FakeWorkspace();
  const calls = [];
  const oldApi = createApi(async () => { calls.push("old"); return { outcome: "accepted", httpStatus: 200, providerMessageId: "old" }; });
  const newApi = createApi(async () => { calls.push("new"); return { outcome: "accepted", httpStatus: 200, providerMessageId: "new" }; });
  const client = startClient({ workspace });
  const oldDescriptor = descriptor(oldApi);
  workspace.trigger("tps:notifier-api-available", oldDescriptor);
  workspace.trigger("tps:notifier-api-available", descriptor(newApi));
  workspace.trigger("tps:notifier-api-unavailable", oldDescriptor);
  assert.equal((await client.send({ body: "one" })).providerMessageId, "new");
  assert.deepEqual(calls, ["new"]);
});

test("stale-v2 not-ready clears the cache without falling back in the same occurrence", async () => {
  const workspace = new FakeWorkspace();
  let legacyCalls = 0;
  const legacy = {
    sendNotification: async () => { legacyCalls += 1; },
  };
  const app = {
    workspace,
    plugins: { getPlugin: () => ({ api: legacy }) },
  };
  const api = createApi(async () => {
    throw {
      code: "not-ready",
      attempted: false,
      deliveryState: "not-attempted",
      duplicateSafeToRetry: true,
    };
  });
  const client = startClient(app);
  workspace.trigger("tps:notifier-api-available", descriptor(api));
  const first = await client.send({ body: "one" });
  assert.equal(first.state, "not-attempted");
  assert.equal(first.transport, "notifier-v2");
  assert.equal(legacyCalls, 0);
  const second = await client.send({ body: "two" });
  assert.equal(second.state, "legacy-accepted");
  assert.equal(legacyCalls, 1);
});

test("v2 failures map structurally and never invoke the legacy adapter", async () => {
  const cases = [
    {
      error: { code: "delivery-rejected", attempted: true, deliveryState: "rejected", duplicateSafeToRetry: true, httpStatus: 401 },
      state: "rejected",
      attempted: true,
    },
    {
      error: { code: "delivery-unconfirmed", attempted: true, deliveryState: "unconfirmed", duplicateSafeToRetry: false, httpStatus: 500 },
      state: "unknown",
      attempted: true,
    },
    {
      error: new Error("unstructured v2 failure"),
      state: "unknown",
      attempted: "unknown",
    },
  ];
  for (const entry of cases) {
    const workspace = new FakeWorkspace();
    let legacyCalls = 0;
    const app = {
      workspace,
      plugins: { getPlugin: () => ({ api: { sendNotification: async () => { legacyCalls += 1; } } }) },
    };
    const client = startClient(app);
    workspace.trigger("tps:notifier-api-available", descriptor(createApi(async () => { throw entry.error; })));
    const result = await client.send({ body: "one" });
    assert.equal(result.state, entry.state);
    assert.equal(result.attempted, entry.attempted);
    assert.equal(legacyCalls, 0);
  }
});

test("malformed v2 receipts preserve attempt ambiguity without legacy fallback", async () => {
  const workspace = new FakeWorkspace();
  let legacyCalls = 0;
  const app = {
    workspace,
    plugins: { getPlugin: () => ({ api: { sendNotification: async () => { legacyCalls += 1; } } }) },
  };
  const client = startClient(app);
  workspace.trigger("tps:notifier-api-available", descriptor(createApi(async () => ({ outcome: "accepted", httpStatus: 200 }))));
  assert.deepEqual(await client.send({ body: "one" }), {
    state: "unknown",
    transport: "notifier-v2",
    evidence: "malformed-v2-result",
    attempted: "unknown",
  });
  assert.equal(legacyCalls, 0);
});

test("legacy rejection is unknown and never falls through to a second method", async () => {
  const workspace = new FakeWorkspace();
  let messageCalls = 0;
  const app = {
    workspace,
    plugins: {
      getPlugin: () => ({
        api: {
          sendNotification: async () => { throw new Error("raw private provider response"); },
          sendMessage: async () => { messageCalls += 1; },
        },
      }),
    },
  };
  const client = startClient(app);
  assert.deepEqual(await client.send({ body: "one" }), {
    state: "unknown",
    transport: "notifier-v1",
    evidence: "legacy-rejection",
    attempted: "unknown",
  });
  assert.equal(messageCalls, 0);
});

test("missing service and disposed clients fail before an attempt", async () => {
  const workspace = new FakeWorkspace();
  const client = startClient({ workspace });
  assert.equal((await client.send({ body: "one" })).state, "not-attempted");
  client.dispose();
  const disposed = await client.send({ body: "two" });
  assert.equal(disposed.state, "not-attempted");
  assert.equal(disposed.evidence, "interrupted");
  assert.equal(disposed.attempted, false);
});

test("hostile descriptors and legacy registries fail closed", async () => {
  const workspace = new FakeWorkspace();
  const client = startClient({
    workspace,
    plugins: new Proxy({}, {
      get() {
        throw new Error("hostile registry getter");
      },
    }),
  });
  const hostileDescriptor = new Proxy({}, {
    get() {
      throw new Error("hostile descriptor getter");
    },
  });
  assert.doesNotThrow(() => workspace.trigger("tps:notifier-api-available", hostileDescriptor));
  assert.deepEqual(await client.send({ body: "one" }), {
    state: "not-attempted",
    transport: "unavailable",
    evidence: "service-unavailable",
    attempted: false,
  });
});

test("a never-settling provider is bounded and classified unknown without fallback", async () => {
  const workspace = new FakeWorkspace();
  let legacyCalls = 0;
  const app = {
    workspace,
    plugins: { getPlugin: () => ({ api: { sendNotification: async () => { legacyCalls += 1; } } }) },
  };
  const client = startClient(app, { providerDeadlineMs: 5 });
  workspace.trigger("tps:notifier-api-available", descriptor(createApi(() => new Promise(() => undefined))));
  assert.deepEqual(await client.send({ body: "one" }), {
    state: "unknown",
    transport: "notifier-v2",
    evidence: "consumer-timeout",
    attempted: "unknown",
  });
  assert.equal(legacyCalls, 0);
});
