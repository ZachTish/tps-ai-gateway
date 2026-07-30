# TPS AI Gateway

## 0.2.3

- Controller queue scans now snapshot only Markdown descendants of `_assets/TPS AI Queue` through Obsidian's public folder APIs instead of enumerating every Markdown file in the vault every 30 seconds.
- Recursive nested-job support, public traversal order, serialized reads, two-pass coalescing, Controller authority checks, per-file failure isolation, provider fallback, notifications, settings, and public APIs are unchanged.
- Against the exact 0.2.2 release with 100,000 unrelated Markdown files and one queue job, 100 identical compiled-service scans reduced inspected entries from 10,000,100 to 100. Median synthetic scan time fell from 3.432 ms to 0.0029 ms and p95 from 3.793 ms to 0.0035 ms; provider and job-processing latency are outside this enumeration benchmark.
- This backward-compatible reliability/performance patch keeps the minimum supported Obsidian version at 1.12.0 and requires no settings migration.

## 0.2.2

- Controller queue scans now isolate an unreadable, undeletable, or otherwise failing queue file and continue processing every later file in the same serialized snapshot.
- The failing path is included in a compact diagnostic so one damaged job can be repaired without exposing its request body.
- Queue order, maximum read concurrency of one, the two-pass scan bound, provider fallback, notifications, settings, public APIs, and minimum Obsidian compatibility are unchanged. No automatic retry or alternate read path was added.

## 0.2.1

- Remote Controller queue scans now preserve file changes that arrive while a scan is active by coalescing them into one serialized trailing pass.
- Each active scan epoch is capped at two folder snapshots; later work returns to the existing debounce, and Controller authority is rechecked before the trailing pass.
- Provider ordering, supported provider fallback, queue files, notifications, settings, public APIs, and minimum Obsidian compatibility are unchanged.

## 0.2.0

- Settings now use three clean destinations for cloud providers, local Ollama, and diagnostics, rendering only the selected page.
- The new hub is keyboard-accessible and mobile-safe without changing provider order, credentials, models, logging, or fallback behavior.
- This backward-compatible minor release keeps the minimum supported Obsidian version at 1.12.0 and requires no settings migration.

## Development and deployment

Canonical source, tests, Git metadata, and dependencies live in `/Users/zachtisherman/TishOS Plugin Development/tps-ai-gateway`, outside both vaults. `npm run build` and watch builds deploy byte-changed runtime artifacts by default only to `/Users/zachtisherman/Library/Mobile Documents/iCloud~md~obsidian/Documents/Obsidian Plugin Test Vault/.obsidian/plugins/tps-ai-gateway`; `npm test` is therefore isolated even though it ends with a production-mode build. Promotion to `/Users/zachtisherman/TishOS v0.1/.obsidian/plugins/tps-ai-gateway` is an explicit guarded post-validation action. Neither target overwrites `data.json` or other runtime-owned state.

- 2026-07-16 isolation validation: all 8 declared tests and the required final `npm run build` passed with `[runtime-deploy] target=test ... unchanged`. Obsidian 1.12.7 loaded the gateway in the registered test vault without copied credentials or explicit provider requests. No live promotion occurred, and production runtime checksums remained unchanged.
- 2026-07-24 settings-release validation: all 16 gateway, persistence, queue, privacy, and routed-settings tests passed. The required final standalone build deployed only to `[runtime-deploy] target=test`. Obsidian 1.12.7 was reloaded with `Reload app without saving`; all three settings destinations, the shared nine-plugin `Choose what to configure` pattern, and the Health-to-Gateway ownership handoff were inspected in the registered test vault without changing a provider, linking a secret, or sending a request. The pre/post `data.json` SHA-256 remained `6cfa72987ad1b642a8368b6c342a0b22d39fcab83af988b13e77c9398baee42b`; production was not accessed or promoted.
- 2026-07-30 queue-scheduler validation: a frozen 0.2.0 regression showed that 100 overlapping scan requests were discarded while a scan was active. Version 0.2.1 instead observed a newly arrived queue file in one serialized trailing pass, bounded an active epoch to two snapshots, deferred a third trigger through the existing debounce, kept maximum read concurrency at one, and skipped the trailing pass after Controller authority was lost. All 19 tests and the required final build passed; the reloaded test-vault settings were inspected without changing credentials or sending a provider request. Runtime `data.json` remained byte-identical, and production was not accessed.
- 2026-07-30 queue-fault validation: the exact 0.2.1 path attempted only 38 of 100 ordered queue files and processed 37 when file 37 rejected its read. Version 0.2.2 attempted all 100, processed the other 99 in the same order, logged the failed path once, and kept maximum read concurrency at one. All 20 tests and the required final build passed; Obsidian 1.12.7 reloaded the test vault without changing credentials or sending a provider request. Runtime `data.json` remained byte-identical at SHA-256 `6cfa72987ad1b642a8368b6c342a0b22d39fcab83af988b13e77c9398baee42b`, and production was not accessed.
- 2026-07-30 targeted-queue validation: the exact 0.2.2 release passed all 20 tests and its contained build before modification. Version 0.2.3 passed 24 tests covering recursive non-lexical order, missing folders and path collisions, snapshot materialization, enumeration faults, coalescing, authority loss, and file-level isolation. The exact-version benchmark preserved queue read order and maximum concurrency of one while eliminating all whole-vault enumeration. The required final build deployed only to the test vault; Obsidian 1.12.7 was reloaded without changing credentials or sending a provider request. Runtime `data.json` remained byte-identical at SHA-256 `6cfa72987ad1b642a8368b6c342a0b22d39fcab83af988b13e77c9398baee42b`; production was not accessed.

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

On TPS Controller devices, structured requests execute directly through that provider chain. On user-role devices, the gateway writes a versioned Markdown-backed JSON job to `_assets/TPS AI Queue`, using a file type that ordinary Obsidian Sync always carries. The Controller claims pending jobs, reclaims processing jobs whose claim is older than ten minutes, executes and schema-validates the request locally, writes the result or compact redacted failure back to the same job, and sends a TPS Notifier message without including prompt or response content. Every scan synchronously snapshots only Markdown descendants of the queue folder through Obsidian's public recursive traversal; unrelated vault Markdown is never enumerated, and nested jobs retain traversal order. Queue-file changes received during an active scan coalesce into one serialized trailing pass; a later burst returns to the existing debounce, and every trailing pass rechecks Controller authority. A read, expiry-delete, or job-processing infrastructure failure is isolated to that queue file, logged with its path, and does not block later files in the snapshot. Snapshot-enumeration failures still end that pass and rely on the existing debounce or interval for a later attempt. Callers may suppress intermediate-job notifications and provide a bounded friendly workflow title; all other jobs notify once by default. The requesting device polls the synced job for up to twenty minutes and then returns the ordinary structured result to its caller. Completed and failed jobs remain available for sync recovery for 48 hours before the Controller removes them. Queue files contain the request messages and schema inside the user's synced vault; they contain no provider credentials.

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
- Targeted recursive queue enumeration, snapshot, missing-folder/path-collision, and enumeration-failure tests
- Serialized queue coalescing, scan-bound, authority-loss, and per-file failure-isolation tests
- Exact-release versus candidate sparse-vault queue-enumeration benchmark
- TypeScript production build

## Version notes

- 0.2.3: Replaced every Controller whole-vault Markdown queue scan with one supported recursive queue-folder snapshot, preserving nested jobs and all released queue/provider behavior while making scan work proportional to the queue subtree.
- 0.2.2: Isolated individual Controller queue-file failures so later jobs continue in order, with a path-scoped diagnostic and no retry, concurrency, or provider-fallback changes.
- 0.2.1: Preserved queue-file changes that arrive during an active Controller scan with one bounded serialized trailing pass, deferring later bursts and rechecking Controller authority without changing queue or provider behavior.
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
