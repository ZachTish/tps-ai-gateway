import type { AiGatewaySettings, AiMessage } from "./types";

export type SubscriptionProvider = "gemini-cli" | "grok-cli";
export const CLI_TIMEOUT_MS = 55_000;
export const CLI_MAX_OUTPUT_BYTES = 1024 * 1024;

export function structuredPrompt(messages: AiMessage[], schema: Record<string, unknown>): string {
  return JSON.stringify({ instruction: "Answer the supplied conversation. Return only JSON matching the schema, with no Markdown. Do not use tools or read files.", messages, schema });
}

// The CLI owns its login. Never read, copy, or repurpose another application's tokens.
// Dedicated profiles also keep user extensions, MCP servers and project instructions out of inference.
export function cliEnvironment(provider: SubscriptionProvider, profile: string, base: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ["HOME", "USERPROFILE", "PATH", "TMPDIR", "TEMP", "LANG", "SystemRoot"]) if (base[key]) env[key] = base[key]!;
  env[provider === "gemini-cli" ? "GEMINI_CLI_HOME" : "GROK_HOME"] = profile;
  if (provider === "gemini-cli") {
    env.GEMINI_CLI_SURFACE = "tps-ai-gateway";
    env.GEMINI_TELEMETRY_ENABLED = "false";
  } else {
    env.GROK_DISABLE_API_KEY_AUTH = "true";
    env.GROK_DISABLE_AUTOUPDATER = "true";
    env.GROK_CLAUDE_HOOKS_ENABLED = "false";
    env.GROK_CLAUDE_MCPS_ENABLED = "false";
    env.GROK_CLAUDE_AGENTS_ENABLED = "false";
    env.GROK_CLAUDE_RULES_ENABLED = "false";
    env.GROK_CLAUDE_SKILLS_ENABLED = "false";
    env.GROK_CAMPAIGNS = "0";
  }
  return env;
}

export function cliArguments(provider: SubscriptionProvider, model: string, promptFile: string): string[] {
  const args = provider === "gemini-cli"
    ? ["--prompt", "Follow the JSON request on stdin.", "--output-format", "json", "--extensions", "none"]
    : ["--prompt-file", promptFile, "--output-format", "json", "--tools", "read_file", "--disallowed-tools", "read_file,Agent", "--max-turns", "1", "--no-auto-update", "--deny", "MCPTool", "--deny", "Bash", "--deny", "Read", "--deny", "Write", "--deny", "Edit", "--deny", "Grep", "--deny", "WebFetch"];
  if (model.trim()) args.push("--model", model.trim());
  return args;
}

export function parseCliResponse(provider: SubscriptionProvider, output: string): string {
  let data: any;
  try { data = JSON.parse(output); } catch { throw new Error("The subscription tool did not return JSON. Update it and sign in from AI settings."); }
  if (data?.error || data?.type === "error") throw new Error("The subscription tool rejected the request. Check its sign-in and subscription allowance.");
  const text = provider === "gemini-cli" ? data?.response : data?.text;
  if (typeof text !== "string" || !text.trim()) throw new Error("The subscription tool returned no answer.");
  return text.trim();
}

export const GEMINI_PROFILE_SETTINGS = {
  security: { auth: { selectedType: "oauth-personal", enforcedType: "oauth-personal" } },
  tools: { core: [], discoveryCommand: "", callCommand: "" },
  mcp: { allowed: ["tps-no-mcp-servers"] }, mcpServers: {},
  hooks: {}, hooksConfig: { enabled: false },
  general: { enableAutoUpdate: false },
  context: { fileName: "TPS_NO_CONTEXT.md", includeDirectories: [], loadMemoryFromIncludeDirectories: false },
  experimental: { enableAgents: false, jitContext: false },
  telemetry: { enabled: false },
};

export const GROK_PROFILE_SETTINGS = `
[auth]
disable_api_key_auth = true
[cli]
auto_update = false
use_leader = false
session_registry = false
[features]
codebase_indexing = false
auto_wake = false
backend_tools = false
file_acceleration = false
session_recap = false
session_search = false
telemetry = false
[compat.claude]
agents = false
hooks = false
mcps = false
rules = false
skills = false
[compat.codex]
hooks = false
skills = false
[relay]
enabled = false
[telemetry]
trace_upload = false
`;

function node(): { fs: typeof import("fs/promises"); path: typeof import("path"); os: typeof import("os"); spawn: typeof import("child_process").spawn } {
  return { fs: require("fs/promises"), path: require("path"), os: require("os"), spawn: require("child_process").spawn };
}

async function profileFor(provider: SubscriptionProvider): Promise<string> {
  const { fs, path, os } = node();
  const root = path.join(os.homedir(), "Library", "Application Support", "TPS AI Gateway", provider);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  // Gemini rejects user-owned system settings. Its isolated user profile is the
  // supported location; leave enterprise system settings and CLI login files alone.
  if (provider === "gemini-cli") await writeGeminiProfileSettings(root);
  else await fs.writeFile(path.join(root, "config.toml"), GROK_PROFILE_SETTINGS, { mode: 0o600 });
  return root;
}

export async function writeGeminiProfileSettings(root: string): Promise<void> {
  const { fs, path } = node();
  const directory = path.join(root, ".gemini");
  const file = path.join(directory, "settings.json");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await fs.readFile(file, "utf8"));
    if (!existing || Array.isArray(existing) || typeof existing !== "object") throw new Error("Invalid settings");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("The dedicated Gemini settings could not be read. Check the profile before connecting.");
  }
  const merge = (current: any, policy: any): any => {
    if (!policy || typeof policy !== "object" || Array.isArray(policy)) return policy;
    const result = { ...(current && typeof current === "object" && !Array.isArray(current) ? current : {}) };
    for (const [key, value] of Object.entries(policy)) result[key] = merge(result[key], value);
    return result;
  };
  const settings = merge(existing, GEMINI_PROFILE_SETTINGS);
  if (JSON.stringify(existing) !== JSON.stringify(settings)) await fs.writeFile(file, JSON.stringify(settings, null, 2) + "\n", { mode: 0o600 });
}

let cancellationGeneration = 0;
const activeRequests = new Set<() => void>();
export function cancelSubscriptionRequests(): void { cancellationGeneration++; for (const cancel of [...activeRequests]) cancel(); }

export function runProcess(executable: string, args: string[], options: { cwd: string; env: Record<string, string>; input?: string; timeoutMs?: number }): Promise<string> {
  const { spawn } = node();
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env, shell: false, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let bytes = 0, done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true; clearTimeout(timer); activeRequests.delete(cancel);
      if (error) {
        try { if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL"); else child.kill("SIGKILL"); } catch { /* already exited */ }
        reject(error);
      } else resolve(Buffer.concat(chunks).toString("utf8"));
    };
    const cancel = () => finish(new Error("AI Gateway closed while a subscription request was running."));
    activeRequests.add(cancel);
    const timer = setTimeout(() => finish(new Error("The subscription tool timed out. Check sign-in in AI settings.")), options.timeoutMs ?? CLI_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > CLI_MAX_OUTPUT_BYTES) finish(new Error("The subscription response exceeded the size limit."));
      else chunks.push(chunk);
    });
    // Drain stderr without retaining prompts, credentials or provider payloads.
    child.stderr.on("data", () => {});
    child.once("error", () => finish(new Error("The subscription tool could not start. Install it and check its path in AI settings.")));
    child.once("close", code => finish(code === 0 ? undefined : new Error("The subscription tool failed. Check sign-in, version and allowance in AI settings.")));
    child.stdin.on("error", () => {});
    child.stdin.end(options.input || "");
  });
}

async function executableFor(value: string, provider: SubscriptionProvider): Promise<string> {
  const { path, fs } = node();
  const command = value.trim() || (provider === "gemini-cli" ? "gemini" : "grok");
  const locations = path.isAbsolute(command) ? [command] : ["/opt/homebrew/bin", "/usr/local/bin", ...String(process.env.PATH || "").split(path.delimiter)].filter(path.isAbsolute).map(dir => path.join(dir, command));
  if (!path.isAbsolute(command) && /[/\\\s]/.test(command)) throw new Error("Use the tool name or its full executable path, without arguments.");
  for (const file of locations) {
    try { await fs.access(file, 1); if ((await fs.stat(file)).isFile()) return file; } catch { /* next explicit path */ }
  }
  throw new Error(`Install ${provider === "gemini-cli" ? "Gemini CLI 0.65.0 or newer" : "Grok Build"}, then use Connect in AI settings.`);
}

async function prepare(provider: SubscriptionProvider, settings: AiGatewaySettings, assertActive: () => void) {
  if (typeof process === "undefined" || process.platform !== "darwin") throw new Error("Subscription tools currently require macOS. Use an API connection or Apple Shortcuts on iPhone.");
  const executable = await executableFor(provider === "gemini-cli" ? settings.geminiCliPath : settings.grokCliPath, provider);
  assertActive();
  const profile = await profileFor(provider);
  assertActive();
  const env = cliEnvironment(provider, profile, process.env);
  env.PATH = `/opt/homebrew/bin:/usr/local/bin:${env.PATH || "/usr/bin:/bin"}`;
  if (provider === "gemini-cli") {
    const version = (await runProcess(executable, ["--version"], { cwd: profile, env, timeoutMs: 10_000 })).trim();
    const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!match || (+match[1] === 0 && +match[2] < 65)) throw new Error("Update Gemini CLI to 0.65.0 or newer for an isolated subscription connection.");
  }
  return { executable, profile, env };
}

export async function callSubscription(provider: SubscriptionProvider, settings: AiGatewaySettings, messages: AiMessage[], schema: Record<string, unknown>) {
  const generation = cancellationGeneration;
  const assertActive = () => { if (generation !== cancellationGeneration) throw new Error("AI Gateway closed before the subscription request started."); };
  const prepared = await prepare(provider, settings, assertActive);
  assertActive();
  const { fs, path, os } = node();
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "tps-ai-request-"));
  try {
    const prompt = structuredPrompt(messages, schema);
    const promptFile = path.join(cwd, "request.json");
    if (provider === "grok-cli") await fs.writeFile(promptFile, prompt, { mode: 0o600 });
    assertActive();
    const model = provider === "gemini-cli" ? settings.geminiCliModel : settings.grokCliModel;
    const output = await runProcess(prepared.executable, cliArguments(provider, model, promptFile), { cwd, env: prepared.env, input: provider === "gemini-cli" ? prompt : undefined });
    return { text: parseCliResponse(provider, output), model: model || "subscription default" };
  } finally { await fs.rm(cwd, { recursive: true, force: true }); }
}

const quote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
export async function openSubscriptionLogin(provider: SubscriptionProvider, settings: AiGatewaySettings): Promise<void> {
  const generation = cancellationGeneration;
  const assertActive = () => { if (generation !== cancellationGeneration) throw new Error("AI Gateway closed before sign-in opened."); };
  const { executable, profile, env } = await prepare(provider, settings, assertActive);
  if (generation !== cancellationGeneration) throw new Error("AI Gateway closed before sign-in opened.");
  const { fs, path } = node();
  const script = path.join(profile, "Connect.command");
  const assignments = Object.entries(env).map(([key, value]) => `${key}=${quote(value)}`).join(" ");
  const args = provider === "gemini-cli" ? ["--extensions", "none"] : ["login"];
  await fs.writeFile(script, `#!/bin/sh\ncd ${quote(profile)} || exit 1\nexec /usr/bin/env -i ${assignments} ${quote(executable)} ${args.map(quote).join(" ")}\n`, { mode: 0o700 });
  if (generation !== cancellationGeneration) throw new Error("AI Gateway closed before sign-in opened.");
  await runProcess("/usr/bin/open", ["-a", "Terminal", script], { cwd: profile, env, timeoutMs: 5000 });
}
