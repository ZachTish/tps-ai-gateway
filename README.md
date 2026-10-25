# TPS AI Gateway

Explicit structured AI requests for TPS plugins. Obsidian 1.12.0+; desktop and mobile. No queue files, background workers, vault scans, or automatic provider requests.

## Connect a provider

Open **Settings → TPS AI Gateway**. Choose a provider, follow its connection steps, then select **Test connection**. The test sends only a synthetic JSON request to that exact provider and consumes its normal allowance. Opening settings never connects, scans for tools, reads credentials, saves settings, or sends requests. A new installation starts with no provider selected.

| Choice | Connection | Platforms / limits |
| --- | --- | --- |
| Gemini Code Assist · Eligible work account | Official Gemini CLI 0.65.0+; Connect opens Google sign-in in Terminal | macOS. Requires an eligible Code Assist work account. Personal Google AI Pro/Ultra subscriptions no longer work with this CLI. |
| Grok subscription | Current official Grok Build; Connect opens its login in Terminal | macOS. Requires Grok Build access on the account. Text only. |
| Apple Intelligence · Shortcuts | A user-owned shortcut using Apple's **Use Model** action | Supported Mac/iPhone/iPad with Apple Intelligence enabled. Foreground handoff; text only. |
| Local / open models · Ollama | Existing Ollama server and installed model | Localhost means the current device. Mobile requires a secured reachable server. |
| Other provider · Compatible API | Provider's API base URL, model ID, optional device-local secret | Chat Completions endpoints, including local servers. HTTPS required except localhost. JSON is requested in the prompt and validated on return. |
| Google Gemini / Gemma · API key | Google AI Studio secret and model | Desktop/mobile; this is separate from Google AI subscription sign-in. Existing image and Gemini grounding support remain. |
| OpenAI · API key | OpenAI API secret and model | Desktop/mobile. API billing is separate from consumer subscriptions. |

OpenCode is a client, not a universal subscription credential. Use its underlying provider's supported API endpoint for general note requests. Coding-only subscriptions are not presented as general-purpose API access. The compatible API URL is explicit: for example an xAI API account uses `https://api.x.ai/v1`; that does not connect a Grok consumer subscription.

Subscription tools are installed separately using their official instructions; this plugin does not install or upgrade them automatically. **Connect** opens the official tool, with its own isolated TPS profile. The user completes account sign-in; the plugin never reads or copies login tokens from another app. The model can remain blank to use the tool's default. Paths accept only an executable name or absolute path, not shell commands. These connections currently require macOS and do not forward phone requests through a Mac.

Google moved personal Google AI subscriptions from Gemini CLI to [Antigravity](https://antigravity.google/docs/cli/gcli-migration/). Google sign-in alone does not establish eligibility: the service can reject a personal account after OAuth succeeds. Antigravity is not integrated here; the existing Gemini API connection uses separate API billing. Do not represent Gemini CLI as a consumer subscription connection.

### Apple shortcut

Create a shortcut named **TPS AI** (or set its name in Gateway):

1. Add **Use Model**, selecting **On-Device** or **Private Cloud Compute**.
2. Set its prompt to **Shortcut Input**. Disable **Follow Up**.
3. Return the model response as text, without a display/confirmation step replacing the result.

The shortcut's model selection owns whether computation is local or uses Apple's cloud. Selecting this connection does not prove that Apple Intelligence is available or that the shortcut uses a particular model. Test it on each device. The user remains in control of the shortcut and Apple's permissions.

When prompted, open the Shortcuts link from Obsidian and permit the shortcut to return its output. On Mac, the output permission appears in Apple's separate shortcut runner, not necessarily in the main Shortcuts editor. A request waiting for either prompt can time out.

Gateway sends the explicit request through Apple's supported x-callback URL and accepts one bounded response for an unpredictable request token in the requesting vault. Native URL parameters use percent-encoded spaces. Obsidian consumes the routing `vault` parameter, so the callback checks the receiving app’s actual vault name. A whole JSON code fence from Use Model is accepted; extra prose and malformed JSON are rejected. Cancel, error, timeout, unload, invalid JSON and schema errors fail explicitly. A foreground handoff never starts a backup on failure, preventing duplicate requests. Keep Obsidian running; these are not durable jobs. Inputs above 12,000 characters and results above 64,000 characters are rejected. Physical iPhone acceptance remains unverified.

## Settings and ownership

One flat **AI connection** page, with a native provider selector and only the selected provider's fields. **Advanced** is the sole disclosure; it contains optional subscription executable/model overrides, backups, preserved legacy-chain editors and logging. Settings are now accessible without Controller. The existing `connectionSettings.render` API remains available for a Controller handoff and mounts the same editor, not a second settings store.

Provider order, model IDs, URLs, executable paths and secret references remain device-local in the existing `tps-ai-gateway-settings-v1` envelope. API credentials stay in Obsidian SecretStorage. All previous saved values, unknown fields, inert queue settings and disabled states are preserved; no automatic credential adoption or route migration occurs. Existing retired `apple` routes remain visibly unavailable until the user selects another provider. New Apple Shortcuts uses the distinct `apple-shortcuts` ID, so the retired file bridge cannot be accidentally reactivated.

The UI uses native controls, labelled selectors, focus restoration and plugin-scoped CSS. Mobile stacks fields and wraps controls. Route/disclosure/editor state is transient. Existing provider settings, enablement, backup order, logging and the **Validate provider chain** command remain. New actions are per-provider Connect, setup guide and exact-provider Test connection. No empty categories or nested disclosures.

## Runtime contract

- `completeStructured()` validates returned JSON against the caller's schema.
- `choose()` returns a caller-supplied stable option ID.
- Capabilities remain domain-owned: proposal and confirmed execution are separate, schema-checked operations.
- Explicit preferred providers and configured backups retain their order. Images and Google Search grounding still require the direct Google API adapter; the new subscription/Shortcuts connections are text-only.
- `features.appleIntelligence` stays false for the retired TishOS bridge; `features.appleShortcuts` reports availability of the handoff implementation on Apple platforms, not model readiness.
- Durable job IDs fail before provider execution. No polling, synced mailbox, fallback writer, startup inference or note mutation.

Subscription processes use argument arrays without a shell, a temporary working directory outside the vault, bounded output and a terminating timeout. Dedicated policy profiles disable built-in tools, extensions/hooks and project context for Gemini; Grok uses a known built-in allowlist followed by denial of that tool, denial of subagents and MCP operations, and a dedicated profile without user plugins. Account tools retain their own authentication and session data under `~/Library/Application Support/TPS AI Gateway/<provider>`; this is private local application state, never a vault record. Gemini policy uses the supported isolated user settings file (`.gemini/settings.json`), preserving unrelated CLI preferences and private login files. It does not override root-owned system policy files. Subprocesses are stopped when Gateway unloads. Provider errors do not expose raw CLI stderr, prompts or login data. The plugin itself has no access to CLI credentials.

Grok receives the structured request as a private temporary text file. Its `.json` prompt-file mode is reserved for ACP message blocks and must not be used for this plain prompt envelope. The file is removed when execution completes or fails; prompts are never command-line arguments.

## Development

The scoped checkout is `/Users/zachtisherman/Developer/TPS/Plugin Development/tps-ai-gateway-provider-setup-task`, based on immutable 1.0.0. Existing paused checkouts and their unrelated edits remain untouched. Follow the workspace source map and release checklist. Build scripts are repository-local and never deploy:

```sh
# From /Users/zachtisherman/Developer/TPS/Plugin Development
node prepare-dependencies.mjs tps-ai-gateway-provider-setup-task
# From this checkout
npm test
npm run build
# Explicit test deployment from the workspace, after validation:
node deploy-runtime.mjs --target test tps-ai-gateway-provider-setup-task
```

Tests cover old adapters/contracts and settings concurrency, the new provider editor, platform restrictions, exact-provider tests, subscription argument/environment boundaries, real synthetic subprocess timeout/cancellation/output limits, Apple callback ownership/concurrency/limits, and the compatible API transport. Network transports and authenticated subscription/Apple inference are mocked unless a release receipt explicitly states otherwise. Account sign-in, provider eligibility and physical-device acceptance must not be inferred from unit tests.

Official integration references: [Gemini sign-in](https://geminicli.com/docs/get-started/authentication/), [Grok Build authentication](https://github.com/xai-org/grok-build/blob/main/crates/codegen/xai-grok-pager/docs/user-guide/02-authentication.md), [Apple Use Model](https://support.apple.com/guide/shortcuts/use-apple-intelligence-in-shortcuts-tpg3vrvwmclv/ios), [Shortcuts callback contract](https://support.apple.com/guide/shortcuts/apdcd7f20a6f/ios). Historical validation remains in `release-notes/` and immutable GitHub releases.
