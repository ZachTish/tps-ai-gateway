# TPS AI Gateway

Structured AI requests and guarded, domain-owned capabilities for TPS plugins.

Current release: [0.8.0](https://github.com/ZachTish/tps-ai-gateway/releases/tag/0.8.0) · Obsidian 1.12.0+ · Desktop and mobile.

## Install with BRAT

Add `ZachTish/tps-ai-gateway` to BRAT. Use manual updates with `Latest`, or freeze an exact numeric tag for a controlled rollout. Each release supplies `main.js`, `manifest.json`, and `styles.css`; release notes record validation and artifact hashes. A published release is not evidence that any device has installed it.

## Configure this device

One **AI configuration** page contains **Primary AI** with three choices: **Cloud** (Google AI or OpenAI), **On device** (Ollama), and **TPS routed** (TishOS Apple Intelligence). **Backup AI** sits directly below, with None or a specific provider. Only the primary and selected backup editors appear. An existing longer backup chain is preserved until explicitly replaced; its selector lets you edit each existing backup in place. Switching the primary replaces the first provider and removes duplicates from the remaining backups. Disabled Ollama and Apple routes retain editable controls and their existing enablement toggles.

Provider order, enablement, endpoints/models, secret references, and diagnostics remain in the same vault-scoped device-local storage. Actual API keys stay in Obsidian SecretStorage. Opening the page never saves settings or sends a request. There are no new persisted keys, defaults, or migrations. Backup editor selection and focus are transient.

Ordinary requests try providers in order, including Apple as a backup after cloud. Ollama can run directly on user-role devices as well as Controllers. Missing credentials, disabled providers, or unavailable Apple platforms are skipped. Provider-specific requests can prefer another provider; images and grounding use Google AI. A pending Apple handoff does not start a duplicate backup. Existing durable queue contracts are retained: Apple-first durable jobs remain exclusively with TishOS; cloud queue workers do not launch Apple backups, and durable Ollama work still needs an eligible Controller worker. Text without a usable local provider retains the existing synced queue fallback. Thus None removes configured provider backups; it does not disable durable queue recovery or caller-specified providers.

TishOS Apple Intelligence is available through the existing iPhone/iPad handoff. It may use Apple Private Cloud Compute when eligible, then the on-device model; TPS routed is not a promise of strictly on-device inference. Ollama loopback requires a running server on the same device; mobile needs a reachable secured endpoint.

**Diagnostics** is the single intentional disclosure at the bottom. The previous Cloud providers, Device AI, and Diagnostics destinations are removed. Native mode buttons expose `aria-pressed`, conditional rerenders restore focus, and all CSS is plugin-scoped. On narrow screens settings stack, mode choices form a compact scrollable strip, fields fill the width, and navigation is not sticky. Extend this page for related configuration rather than reintroducing separate provider pages.

Preserved control inventory: OpenAI secret/model, Google AI secret/model, Apple enablement, Ollama enablement/URL/model, and logging. The Validate provider chain command and all public API actions remain available. Added controls are primary mode/cloud provider, optional backup, and the transient editor selector for legacy backup chains.

## 0.8.0 validation and release

This backward-compatible minor release adds explicit primary/backup controls and consolidates configuration. Minimum Obsidian remains 1.12.0. Regression coverage includes every mode, conditional controls, disabled-provider editing, legacy chains, empty routes, focus and selection state, disclosure depth, mobile CSS, provider order, pending-handoff safety, and direct Ollama on a user device. The full suite contains 42 checks; the production build includes TypeScript validation. On 2026-09-17, the full 42-check suite passed and the separate final production build deployed only to `[runtime-deploy] target=test`. The plugin was reloaded with `obsidian plugin:reload id=tps-ai-gateway` in the verified Obsidian Plugin Test Vault. Desktop and a 600 px settings window were inspected: all three modes, Google/OpenAI credentials and models, Ollama controls, Apple controls, None/provider backups, legacy backup editors, focus restoration, and the single Diagnostics disclosure. Mode changes were exercised against an in-memory settings-tab fixture with a no-op save method, so real provider settings were never changed. The narrow layout had no horizontal overflow. Device-local settings and runtime `data.json` SHA-256 hashes matched their pre-QA values. No inference command, credential picker, or external automation was invoked. Artifact hashes are in the release notes; production was not accessed.

The release was isolated on `feature/unified-ai-settings` in the contained `tps-ai-gateway Unified Settings (Worktree)` checkout from current `origin/main`, preserving the older canonical checkout’s unrelated README and ignore-file edits.

## Request and capability contracts

- `completeStructured()` validates returned data against the caller's schema.
- `choose()` returns one caller-supplied stable option ID.
- `registerCapability()` registers a schema and domain-owned handler.
- `proposeCapability()` prepares a proposal from an explicit allowlist; `executeCapability()` remains a separate, guarded step.

The gateway does not invent capability IDs or write arbitrary vault files. Provider fallback and durable queue behavior retain their existing bounds. Queue-backed text requests can be carried by vault synchronization; device-local credentials are not carried with them. Image and grounding support depend on the requested provider and model.

Missing or failed providers are handled without logging secrets, prompts, full responses, or note bodies. No provider test runs merely because settings are opened. See [the detailed reference](REFERENCE.md) for request types, queue lifecycle, provider constraints, migration history, and validation.

## Development and repository policy

`main` is the stable source line. Numeric tags identify immutable released artifacts. `optimization` is an unreleased work-in-progress lane; do not install it through BRAT or merge it into stable without separate validation.

The supported build lives inside `Obsidian Plugin Test Vault/Plugin Development`, with `tps-ai-gateway` as the mapped stable source. These repositories depend on adjacent shared tooling including `deploy-runtime.mjs`; a standalone clone is not currently self-contained.

From the contained workspace, prepare dependencies using the shared helper, then run tests and a separate final build:

```sh
# From Plugin Development:
node ./prepare-dependencies.mjs "tps-ai-gateway"
cd "tps-ai-gateway"
npm test
npm run build
```

Dependencies stay in the vault's `.plugin-dev-cache.nosync` through a relative `node_modules` symlink. Use a clean, current checkout; preserve unrelated changes and never build an old dirty worktree into the test runtime. Stable builds deploy only shipped artifacts to the test vault. Optimization builds are build-only. Runtime `data.json`, secrets, caches, and session state never belong in Git.

Documentation-only maintenance does not create a new plugin version. Published release tags and assets are preserved. Do not rely on legacy version/release scripts without reviewing their current behavior. Production updates remain the user's BRAT handoff.

For prior feature details and release-specific evidence, see [REFERENCE.md](REFERENCE.md) and [GitHub releases](https://github.com/ZachTish/tps-ai-gateway/releases). The September 16 cleanup changes documentation and repository metadata, not shipped behavior.
