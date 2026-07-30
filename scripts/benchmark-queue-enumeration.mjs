import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { build as esbuildBuild } from "esbuild";

const sourceRoot = resolve(process.argv[2] ?? fileURLToPath(new URL("..", import.meta.url)));
const unrelatedFileCount = Number(process.argv[3] ?? 100_000);
const sampleCount = Number(process.argv[4] ?? 100);
const warmupCount = 10;
const queueFolderPath = "_assets/TPS AI Queue";

if (!Number.isSafeInteger(unrelatedFileCount) || unrelatedFileCount < 1) {
  throw new Error("The unrelated-file count must be a positive integer.");
}
if (!Number.isSafeInteger(sampleCount) || sampleCount < 1) {
  throw new Error("The sample count must be a positive integer.");
}

globalThis.__tpsQueueBenchmark = {
  globalCalls: 0,
  globalEntries: 0,
  subtreeVisits: 0,
};

const bundle = await esbuildBuild({
  absWorkingDir: sourceRoot,
  entryPoints: [join(sourceRoot, "src/main.ts")],
  bundle: true,
  format: "esm",
  platform: "node",
  write: false,
  plugins: [{
    name: "obsidian-benchmark-stub",
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
                globalThis.__tpsQueueBenchmark.subtreeVisits += 1;
                callback(child);
                if (child instanceof TFolder) Vault.recurseChildren(child, callback);
              }
            }
          }
          export async function requestUrl() {
            throw new Error("Network access is not available in queue benchmarks.");
          }
        `,
      }));
    },
  }],
});

const moduleUrl = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}#${Date.now()}`;
const { default: GatewayPlugin } = await import(moduleUrl);
const manifest = JSON.parse(readFileSync(join(sourceRoot, "manifest.json"), "utf8"));

const makeFile = (path) => ({
  kind: "file",
  path,
  extension: path.includes(".") ? path.slice(path.lastIndexOf(".") + 1) : "",
});
const makeFolder = (path, children) => ({ kind: "folder", path, children });
const completeJob = (file) => JSON.stringify({
  version: 1,
  id: file.path.split("/").pop().replace(/\.md$/, ""),
  taskId: "benchmark.queue.enumeration",
  requesterDeviceId: "synthetic",
  createdAt: "2026-07-30T00:00:00.000Z",
  updatedAt: "2026-07-30T00:00:00.000Z",
  status: "complete",
  messages: [{ role: "user", content: "synthetic benchmark" }],
  schema: { type: "object" },
});

function makePlugin({ allMarkdownFiles, queueRoot, readPaths }) {
  let activeReads = 0;
  let maxActiveReads = 0;
  const plugin = Object.create(GatewayPlugin.prototype);
  plugin.remoteQueueScanInFlight = false;
  plugin.remoteQueueRescanRequested = false;
  plugin.isControllerDevice = () => true;
  plugin.app = {
    vault: {
      getFolderByPath: (path) => path === queueFolderPath ? queueRoot : null,
      getMarkdownFiles: () => {
        globalThis.__tpsQueueBenchmark.globalCalls += 1;
        globalThis.__tpsQueueBenchmark.globalEntries += allMarkdownFiles.length;
        return allMarkdownFiles;
      },
      read: async (file) => {
        readPaths.push(file.path);
        activeReads += 1;
        maxActiveReads = Math.max(maxActiveReads, activeReads);
        try {
          return completeJob(file);
        } finally {
          activeReads -= 1;
        }
      },
    },
  };
  return { plugin, getMaxActiveReads: () => maxActiveReads };
}

function resetCounters() {
  globalThis.__tpsQueueBenchmark.globalCalls = 0;
  globalThis.__tpsQueueBenchmark.globalEntries = 0;
  globalThis.__tpsQueueBenchmark.subtreeVisits = 0;
}

const directFile = makeFile(`${queueFolderPath}/direct.md`);
const nestedFile = makeFile(`${queueFolderPath}/nested/nested.md`);
const laterFile = makeFile(`${queueFolderPath}/later.md`);
const ignoredFile = makeFile(`${queueFolderPath}/nested/ignored.json`);
const parityRoot = makeFolder(queueFolderPath, [
  directFile,
  makeFolder(`${queueFolderPath}/nested`, [nestedFile, ignoredFile]),
  laterFile,
]);
const parityAllMarkdown = [
  makeFile("Notes/unrelated.md"),
  directFile,
  nestedFile,
  laterFile,
];
const parityReadPaths = [];
const parityFixture = makePlugin({
  allMarkdownFiles: parityAllMarkdown,
  queueRoot: parityRoot,
  readPaths: parityReadPaths,
});
resetCounters();
await parityFixture.plugin.scanRemoteQueue("benchmark-parity");
const parityCounters = { ...globalThis.__tpsQueueBenchmark };

const benchmarkFile = makeFile(`${queueFolderPath}/benchmark.md`);
const benchmarkRoot = makeFolder(queueFolderPath, [benchmarkFile]);
const benchmarkAllMarkdown = Array.from(
  { length: unrelatedFileCount },
  (_, index) => makeFile(`Notes/unrelated-${String(index).padStart(6, "0")}.md`),
);
benchmarkAllMarkdown.push(benchmarkFile);
const benchmarkReadPaths = [];
const performanceFixture = makePlugin({
  allMarkdownFiles: benchmarkAllMarkdown,
  queueRoot: benchmarkRoot,
  readPaths: benchmarkReadPaths,
});

for (let index = 0; index < warmupCount; index += 1) {
  await performanceFixture.plugin.scanRemoteQueue("benchmark-warmup");
}
resetCounters();
benchmarkReadPaths.length = 0;
const samples = [];
for (let index = 0; index < sampleCount; index += 1) {
  const startedAt = performance.now();
  await performanceFixture.plugin.scanRemoteQueue("benchmark-sample");
  samples.push(performance.now() - startedAt);
}
samples.sort((left, right) => left - right);
const percentile = (fraction) => samples[Math.min(samples.length - 1, Math.floor(samples.length * fraction))];

process.stdout.write(`${JSON.stringify({
  sourceRoot,
  version: manifest.version,
  strategy: globalThis.__tpsQueueBenchmark.globalCalls > 0 ? "whole-vault-markdown" : "queue-subtree",
  parity: {
    readPaths: parityReadPaths,
    maxActiveReads: parityFixture.getMaxActiveReads(),
    ...parityCounters,
  },
  performance: {
    unrelatedFileCount,
    queueFileCount: 1,
    warmupCount,
    sampleCount,
    readCount: benchmarkReadPaths.length,
    maxActiveReads: performanceFixture.getMaxActiveReads(),
    globalCalls: globalThis.__tpsQueueBenchmark.globalCalls,
    globalEntries: globalThis.__tpsQueueBenchmark.globalEntries,
    subtreeVisits: globalThis.__tpsQueueBenchmark.subtreeVisits,
    medianMs: percentile(0.5),
    p95Ms: percentile(0.95),
  },
}, null, 2)}\n`);
