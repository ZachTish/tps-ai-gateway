# TPS AI Gateway

Structured AI requests and guarded, domain-owned capabilities for TPS plugins.

Current release: [0.7.0](https://github.com/ZachTish/tps-ai-gateway/releases/tag/0.7.0) · Obsidian 1.12.0+ · Desktop and mobile.

## Install with BRAT

Add `ZachTish/tps-ai-gateway` to BRAT. Use manual updates with `Latest`, or freeze an exact numeric tag for a controlled rollout. Each release supplies `main.js`, `manifest.json`, and `styles.css`; release notes record validation and artifact hashes. A published release is not evidence that any device has installed it.

## Configure this device

The settings hub contains **Cloud providers** (default), **Device AI**, and **Diagnostics**. Provider order, enablement, endpoints/models, secret references, and diagnostics are stored in vault-scoped device-local storage and labeled **This device**. First use imports legacy preferences once; a stored local choice wins afterward, including disabled toggles. Actual API keys stay in Obsidian SecretStorage.

Configure OpenAI or Google AI under Cloud providers. Device AI configures the TishOS Apple Intelligence handoff and optional Ollama. Enabling Apple Intelligence does not establish device/model eligibility or Apple Private Cloud Compute entitlement. Provider availability is determined at execution time.

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
