# TPS AI Gateway

## Development and deployment

Canonical source, tests, Git metadata, and dependency links live in this test vault under `Plugin Development`. Stable work uses `tps-ai-gateway` on `main`; optimization work uses the separate `tps-ai-gateway (Optimize)` worktree on `optimization`. Stable builds may deploy byte-changed runtime artifacts only to this test vault. Optimization builds are build-only and report `[runtime-deploy] target=none lane=optimization`, so they cannot replace the installed test or production plugin. Promotion to `/Users/zachtisherman/TishOS v0.1/.obsidian/plugins/tps-ai-gateway` remains an explicit guarded post-validation action, and deployment never overwrites `data.json` or other runtime-owned state.

- 2026-07-16 isolation validation: all 8 declared tests and the required final `npm run build` passed with `[runtime-deploy] target=test ... unchanged`. Obsidian 1.12.7 loaded the gateway in the registered test vault without copied credentials or explicit provider requests. No live promotion occurred, and production runtime checksums remained unchanged.
- 2026-07-19 optimization validation: all 9 declared tests passed, including terminal-only queue-retention coverage. The required separate `npm run build` reported `[runtime-deploy] target=none lane=optimization`; no vault runtime was deployed, so reload and UI verification were not applicable. No version, tag, release, or production promotion was created.
- 2026-07-19 phase-2 optimization validation: all 30 declared tests passed, including executable Notifier-client lifecycle, consumer-deadline, strict queue-schema, local atomic-claim, and completion-notification settlement tests. The required separate `npm run build` reported `[runtime-deploy] target=none lane=optimization`; no vault runtime was deployed, so reload and UI verification were not applicable. No version, tag, release, or production promotion was created.
- 2026-07-19 queue-hardening validation: all 35 declared tests, the complete `npm test` suite and embedded production-mode build, and the required separate `npm run build` passed. Both builds reported `[runtime-deploy] target=none lane=optimization`; no vault runtime was deployed, so reload and UI verification were not applicable. No version, tag, release, or production promotion was created.

## Install with BRAT

Add the private repository `ZachTish/tps-ai-gateway` to BRAT and select **Latest** tracking so BRAT follows the newest GitHub release. For private-repository access, give BRAT a fine-grained GitHub token scoped to this repository with **Contents: Read-only** permission. Never commit the token to this repository, an Obsidian vault, or any synced note.

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

On TPS Controller devices, structured requests execute directly through that provider chain. On user-role devices, the gateway writes a versioned Markdown-backed JSON job to `_assets/TPS AI Queue`, using a file type that ordinary Obsidian Sync always carries. The Controller scans that folder directly, isolates a malformed or failing file from the rest of the scan, and uses Obsidian's public `Vault.process()` API for local read-modify-write transitions. Claims carry a random claim ID and monotonic revision, and terminal/notification settlement proceeds only while the same claim or attempt still owns the latest local file. Only a structurally valid processing job with a bounded Controller ID, claim ID, canonical timestamp, and lease at least ten minutes old can be reclaimed. Missing or malformed ownership fails closed and requires manual inspection or a new request; the scanner does not guess or repair it. Queue files contain request messages and schema inside the user's synced vault; they contain no provider credentials.

Remote queue files are limited to 2 MiB before read and to 2,097,152 decoded JSON characters. Individual messages may contain at most 262,144 characters and all message content together at most 524,288 characters. Schema and result trees are iteratively bounded by aggregate string content, node count, and depth: schemas permit 131,072 string characters, 4,096 nodes, and depth 64; result data permits 524,288 string characters, 50,000 nodes, and depth 64. These limits preserve ordinary structured TPS requests while preventing a synced queue file from forcing unbounded parsing, traversal, or serialization. An oversized or malformed request is rejected before queue creation, an oversized provider result becomes a compact failed job, and an oversized synced file is ignored before `Vault.read()`.

Terminal queue files are retained rather than permanently deleted by the plugin. This deliberately removes the previous automatic 48-hour deletion race. Until a reviewed, non-destructive cleanup protocol exists, users may manually remove terminal queue files after confirming that no device still needs their result. Because the Controller scans each direct queue child, an uncleared terminal backlog will eventually increase scan time; an acknowledged result inbox plus recoverable archival/compaction is a high-priority follow-up.

Completion notification tracking is an optional, backward-compatible field on remote-job format version 1. Callers may suppress notification and may provide a bounded friendly workflow title; all other newly processed jobs make one completion-notification attempt by default. The Controller persists the terminal AI result and an `attempting` record together in one atomic local transition before any Notifier I/O, then compare-and-set settles only the matching attempt ID against the latest local file. A controlled lifecycle interruption detected before the send is settled as definite `not-attempted`; a crash, timeout, or interruption after the send boundary remains `unknown` because delivery cannot be proved. Delivery state otherwise distinguishes v2 provider-confirmed `accepted`, compatibility-only `legacy-accepted`, confirmed `rejected`, and definite `not-attempted`. The synchronized consumer bounds either notifier transport at 60 seconds, and no ambiguous occurrence falls through to another route. A Notifier failure never replaces or downgrades the AI result. On startup, a still-`attempting` record becomes `unknown`; a legacy terminal job without a record also becomes `unknown`. Neither is sent again automatically because the old flow may have stopped before or after external I/O.

The requesting call polls for twenty minutes. If that wait ends or Obsidian restarts, the original in-memory workflow cannot resume automatically; there is no persistent continuation or result-inbox API in this phase. When completion notification is enabled, a later notification therefore tells the user to run the originating action again. The completed queue file remains available for a future explicit result-recovery design.

These transitions serialize claim and settlement within one local Obsidian vault instance. Obsidian Sync is not a distributed compare-and-set service, so two Controller devices editing divergent synced copies can still both execute a job before conflict resolution. Provider execution also lacks a stable cross-device idempotency key. For that reason this phase is crash-aware and duplicate-resistant locally, not an exactly-once distributed queue. The existing private Controller-role lookup and `app.tpsAiGateway` compatibility exposure also remain temporary unsupported integration points; replacing them requires a separate public Controller capability/discovery contract.

Notifier v2 discovery uses supported workspace request/available/unavailable events and validates the public API contract. Exact API identity prevents a stale unavailable event from clearing a newer service. A single isolated `app.plugins.getPlugin()` adapter remains temporarily for mixed-version Notifier v1 devices; a v2 occurrence never falls through to v1 after an ambiguous or rejected result. The v1 promise can establish only `legacy-accepted`, not a structured provider receipt, and a v1 rejection is recorded as `unknown`.

Ollama defaults to Mac loopback and therefore is not a mobile provider. Mobile uses configured cloud fallbacks unless a separately secured Ollama endpoint is supplied. Do not expose a raw Ollama port to the internet; its local API does not authenticate requests.

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
- Non-destructive terminal retention and valid-stale-claim tests
- Notifier v2 event handshake, stale-service identity, v1 compatibility, no-same-occurrence fallback, and hostile-object fail-closed tests
- Raw-file, aggregate-message, schema-tree, and result-tree budget boundary tests
- Strict remote-job parsing, fail-closed claim validation, local atomic claim arbitration, stale-owner rejection, and durable-process completion tests
- Durable completion-notification migration, pre-send versus post-send interruption, exact-attempt settlement, suppression, and bounded outcome tests
- Terminal-plus-attempting-before-I/O and compare-and-set settlement integration-order guard
- TypeScript no-emit check plus embedded and separately invoked production-mode builds, both isolated with `target=none`

## Version notes

- 0.1.2: Bounded every provider attempt so fallback cannot hang indefinitely, moved Gemini authentication out of the URL, redacted credential-shaped provider failures before logging or display, reduced arbitrary request metadata to a field count in diagnostics, and aligned the manifest minimum with the Obsidian 1.12.0 SecretStorage contract.
- 0.1.1: Moved cloud API credentials from plugin data into device-local Obsidian SecretStorage, with an automatic legacy migration that preserves an already populated secret instead of overwriting it.
- 0.1.3: Added Controller-mediated remote structured execution for user devices through a durable, reclaimable, expiring vault-synced queue with TPS Notifier completion/failure messages.
- 0.1.0: Initial structured-provider gateway, guarded capability registry, and ordered fallback chain.

## Settings layout

Cloud provider credentials and models remain root-level core controls. Optional local Ollama configuration and privacy-safe diagnostics are separate collapsed groups. The settings page uses one collapse level and opens with both optional groups closed.

- 2026-07-13: Separated optional local inference and diagnostics from core cloud-provider configuration, added matching settings styles, and kept all optional sections collapsed by default. Validation: settings hierarchy audit, full test suite, production build/deploy, and Obsidian reload.
