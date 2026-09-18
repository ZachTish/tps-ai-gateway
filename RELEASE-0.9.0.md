# TPS AI Gateway 0.9.0

Adds **Request files folder · This device → Apply folder**. Queued requests, including Describe food, can use `_system/TPS AI Queue` or another vault-relative folder. Configure the same location on every participating AI device and keep it synced.

Existing jobs finish in their original folders and retain normal cleanup. New jobs use the selected folder. Durable retries find earlier results; unsafe paths, file collisions and duplicate durable identities are rejected. Failed folder saves preserve unrelated provider edits. Credentials and existing provider selections remain local and unchanged.

Custom folders with **Apple Intelligence require TishOS Companion 0.16.9 (140) or later**. Update the companion first. The legacy default folder and job-only URL remain compatible with older apps. Companion distribution is a separate TestFlight release; this GitHub release does not install it.

Validation: all 46 tests passed; TypeScript, a mandatory separate final build and test deployment/reload passed. Actual settings UI rejected traversal, applied a synthetic Inbox path, and created a completed test request at that path. Keyboard access was checked, original settings hashes restored, and fixtures archived. No inference or production installation occurred. Minimum Obsidian: 1.12.0.

Tested in **Obsidian Plugin Test Vault** and ready for the user’s BRAT pull. This additive feature uses a minor version. Production was not accessed.

## SHA-256

```text
496d5c6e6cfd278386e89e33de6f822bbff05c0bbb53d6c84c6605c9151d4aa5  main.js
2ab9269c0fbe7f08d8df05d2cdb4a67aa35330b46edb10ffb593152f84b23676  manifest.json
105f14e8684800d86ae0401b69954d4494a5be3d7bec1c1d790a83e37b245786  styles.css
```
