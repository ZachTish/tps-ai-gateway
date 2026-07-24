# TPS AI Gateway

## 0.2.0

- Settings now use three clean destinations for cloud providers, local Ollama, and diagnostics, rendering only the selected page.
- The new hub is keyboard-accessible and mobile-safe without changing provider order, credentials, models, logging, or fallback behavior.
- This backward-compatible minor release keeps the minimum supported Obsidian version at 1.12.0 and requires no settings migration.

## Development and deployment

Canonical source, tests, Git metadata, and dependencies live in `/Users/zachtisherman/TishOS Plugin Development/tps-ai-gateway`, outside both vaults. `npm run build` and watch builds deploy byte-changed runtime artifacts by default only to `/Users/zachtisherman/Library/Mobile Documents/iCloud~md~obsidian/Documents/Obsidian Plugin Test Vault/.obsidian/plugins/tps-ai-gateway`; `npm test` is therefore isolated even though it ends with a production-mode build. Promotion to `/Users/zachtisherman/TishOS v0.1/.obsidian/plugins/tps-ai-gateway` is an explicit guarded post-validation action. Neither target overwrites `data.json` or other runtime-owned state.

- 2026-07-16 isolation validation: all 8 declared tests and the required final `npm run build` passed with `[runtime-deploy] target=test ... unchanged`. Obsidian 1.12.7 loaded the gateway in the registered test vault without copied credentials or explicit provider requests. No live promotion occurred, and production runtime checksums remained unchanged.
- 2026-07-24 settings-release validation: all 16 gateway, persistence, queue, privacy, and routed-settings tests passed. The required final standalone build deployed only to `[runtime-deploy] target=test`. Obsidian 1.12.7 was reloaded with `Reload app without saving`; all three settings destinations, the shared nine-plugin `Choose what to configure` pattern, and the Health-to-Gateway ownership handoff were inspected in the registered test vault without changing a provider, linking a secret, or sending a request. The pre/post `data.json` SHA-256 remained `6cfa72987ad1b642a8368b6c342a0b22d39fcab83af988b13e77c9398baee42b`; production was not accessed or promoted.

## Install with BRAT

Add the public repository `ZachTish/tps-ai-gateway` to BRAT and select **Latest** so BRAT follows numbered releases without a private-repository token. Freeze a numeric version when a device should remain pinned.

TPS AI Gateway is the centralized model transport and guarded-decision layer for TPS plugins. It follows TPS Notifier's separation pattern: the gateway owns delivery mechanics and exposes a narrow API; domain plugins own domain rules and mutations.

TPS AI Gateway requires Obsidian 1.12.0 or newer because its cloud-credential contract uses device-local SecretStorage and the `SecretComponent` settings picker.

## Contract

- `completeStructured()` sends multi-turn messages through an ordered provider chain and validates the returned JSON against the caller's schema.
- `choose()` lets a model select exactly one caller-provided stable option ID. Labels are presentation; IDs are authority boundaries.
- `registerCapability()` lets a domain plugin expose one described, schema-constrained operation and supplies the only function allowed to execute it.
- `proposeCapability()` lets the model choose among an explicit capability allowlist and prepare schema-valid input.
- `executeCapability()` is separate from proposal. Confirmation is required by default, the input is revalidated, and the domain-owned handler performs the mutation.
- The gateway never writes arbitrary vault files and never invents capability IDs.

## Providers

Default order: local Ollama (`gemma3:12b`), OpenAI, then Gemini (`gemini-2.5-flash`). Missing, failed, or stalled providers fall through; each provider attempt has a 60-second ceiling so one transport cannot leave the whole request pending forever. Provider configuration lives only in this plugin. OpenAI and Gemini keys are selected through Obsidian SecretStorage and are never written to plugin `data.json`; upgrading from settings version 1 migrates any existing plaintext keys into the default device-local secret entries before purging the legacy fields. Gemini authentication uses the request header rather than a query string, and provider errors are redacted before they reach diagnostics or user notices. API keys, prompts, full responses, vault bodies, and caller-supplied metadata values or field names are not logged. Request-start diagnostics retain only the number of metadata fields alongside task, provider, message-count, and trace information.

On TPS Controller devices, structured requests execute directly through that provider chain. On user-role devices, the gateway writes a versioned Markdown-backed JSON job to `_assets/TPS AI Queue`, using a file type that ordinary Obsidian Sync always carries. The Controller claims pending jobs, reclaims processing jobs whose claim is older than ten minutes, executes and schema-validates the request locally, writes the result or compact redacted failure back to the same job, and sends a TPS Notifier message without including prompt or response content. Callers may suppress intermediate-job notifications and provide a bounded friendly workflow title; all other jobs notify once by default. The requesting device polls the synced job for up to twenty minutes and then returns the ordinary structured result to its caller. Completed and failed jobs remain available for sync recovery for 48 hours before the Controller removes them. Queue files contain the request messages and schema inside the user's synced vault; they contain no provider credentials.

Ollama defaults to Mac loopback and therefore is not a mobile provider. Mobile uses configured cloud fallbacks unless a separately secured Ollama endpoint is supplied. Do not expose a raw Ollama port to the internet; its local API does not authenticate requests.

Settings saves are serialized and merge only locally edited fields into the newest synchronized plugin data. Explicit provider subsets and intentionally empty text fields remain as saved, unknown fields are preserved, and an older gateway never downgrades or rewrites a higher settings schema version.

## Public API

The API is available as the enabled plugin's `api` and as `app.tpsAiGateway`:

- `completeStructured<T>(request)`
- `choose<T>(request)`
- `registerCapability(capability)`
- `listCapabilities()`
- `proposeCapability(request)`
- `executeCapability(proposal, context)`

Every request requires a stable `taskId`, messages, and a response schema. Results include provider, model, trace ID, and attempt count for concise diagnostics.

## Safety and extensibility

Capability handlers are registered at runtime and removed when their owner unloads. Mutation authority remains with the owner plugin. AI proposals do not execute automatically. Schema validation runs after provider output and again before capability execution.

## Validation

- Nested schema validation tests
- Provider ownership/fallback wiring tests
- Stalled-provider timeout/fallback and credential-redaction tests
- Caller-controlled metadata privacy regression
- Proposal-versus-execution guard tests
- Plaintext-key-to-SecretStorage migration and non-overwrite tests
- TypeScript production build

## Version notes

- 0.2.0: Reorganized settings into a shallow accessible destination hub with a horizontal mobile layout and no nested disclosures, preserving all provider and diagnostics settings.
- 0.1.4: Made settings persistence merge only local intent into the newest synchronized data, preserving unknown fields, deliberate empty values, quick reverts, and edits made while a save is in flight.
- 0.1.3: Added Controller-mediated remote structured execution for user devices through a durable, reclaimable, expiring vault-synced queue with TPS Notifier completion/failure messages.
- 0.1.2: Bounded every provider attempt so fallback cannot hang indefinitely, moved Gemini authentication out of the URL, redacted credential-shaped provider failures before logging or display, reduced arbitrary request metadata to a field count in diagnostics, and aligned the manifest minimum with the Obsidian 1.12.0 SecretStorage contract.
- 0.1.1: Moved cloud API credentials from plugin data into device-local Obsidian SecretStorage, with an automatic legacy migration that preserves an already populated secret instead of overwriting it.
- 0.1.0: Initial structured-provider gateway, guarded capability registry, and ordered fallback chain.

## Settings layout

Settings open on a shallow three-destination `Choose what to configure` hub:

- **Cloud providers** (default): OpenAI and Gemini device-local SecretStorage references and model names.
- **Local Ollama**: the local-first toggle, endpoint, and model.
- **Diagnostics**: privacy-safe logging.

Only the selected destination is rendered, there are no nested disclosures, and route selection is transient rather than persisted. No provider, credential, model, or diagnostics setting was renamed or migrated. Native `aria-pressed` route buttons, visible focus styling, page-heading focus restoration, and a horizontal mobile route strip keep the same controls usable in narrow settings views.

- 2026-07-13: Separated optional local inference and diagnostics from core cloud-provider configuration, added matching settings styles, and kept all optional sections collapsed by default. Validation: settings hierarchy audit, full test suite, production build/deploy, and Obsidian reload.
