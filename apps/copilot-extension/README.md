# Manifold Copilot CLI Extension

This private workspace builds the production Copilot CLI Extension as exactly
one discovery artifact:

```text
apps/copilot-extension/dist/extension.mjs
```

The artifact embeds the production, flat Viewer asset tree, manifold JavaScript
and WASM, and the TypeScript standard-library declarations used by the modeling
worker. `@github/copilot-sdk/extension` is the only host-provided package import;
Node built-ins remain native. The same `.mjs` is both the extension entry point
and its `worker_threads` model worker.

## Build and verify

```bash
npm run build:extension
npm run test:extension
npm run verify:extension
```

`verify:extension` copies the artifact into an otherwise empty directory and
runs `node extension.mjs --self-test` under Node's filesystem permission model.
The self-test initializes embedded WASM, executes a cube and a failing snippet
with source-line mapping, serves and hashes
every embedded Viewer asset, checks two isolated rooms and action idempotency,
and closes the worker, rooms, and host. The verifier also asserts that `dist/`
contains only `extension.mjs`, inspects imports/chunks, and reports raw/gzip and
embedded resource sizes. Production `session.shutdown`, join-race, pending-send,
and signal behavior is covered by the mock-SDK integration tests rather than
claimed by this low-level self-test.

## Installation

The normal distribution is the self-contained `manifold-extension` plugin:

```sh
copilot plugin marketplace add zhicwan/manifold3d-mcp
copilot plugin install manifold-extension@manifold3d-mcp
```

It contains the single runtime and its Canvas skill. No MCP server or npm
installation is added by this plugin. For local development, build with
`npm run build:plugins` and load `plugins/manifold-extension` using the host's
`--plugin-dir` support.

SDK hosts must explicitly opt into the surfaces they support on session
creation: `requestExtensions` and `requestCanvasRenderer`. Loading installed
plugin configuration also requires `enableConfigDiscovery`; an SDK host can
instead supply trusted `pluginDirectories` explicitly. These options default off.

### Standalone discovery file for development

```bash
npm run extension:install
copilot
```

The install script copies the built file to
`$COPILOT_HOME/extensions/manifold3d/extension.mjs` (default:
`~/.copilot/extensions/manifold3d/extension.mjs`). Restart Copilot CLI after
rebuilding, then ask it to open the **Manifold 3D Viewer** Canvas. Canvas panel
rendering remains a manual host proof unless the host is actually exercised;
the Node self-test does not claim to render the host iframe.
Do not enable this user-scoped copy and the plugin copy together: they register
the same tools.

## Tools and captures

The Extension registers `manifold_validate_script`,
`manifold_execute_script`, and `manifold_capture_view`. Script tools require
inline `code`; local `filePath` loading is intentionally deferred. Captures are
written beneath the active Copilot session workspace at
`files/manifold3d-captures/` and returned as a path.

Each Viewer room exposes three host actions:

- `attach-annotation-batch` in `annotation-batch`
- `fix-annotation-batch` in `annotation-batch`
- `attach-location-selection` in `selection-gesture`

Batch actions require explicit `annotationIds` and input
`{ "batchId": "<safe-id>" }`. Both capture a bounded version 2 static snapshot
with mode `annotation-batch`, the model version, annotation revision, batch id,
selected geometry, and notes. `attach-annotation-batch` adds exactly one
`extension_context` composer pill and does not send a message.
`fix-annotation-batch` never adds a pill: it sends a clear revision request and
the complete serialized snapshot in the actual message `prompt`, with a readable
`displayPrompt` and `mode: "enqueue"`. It reports accepted, running, and terminal
status through the Viewer Host request. Success means the SDK accepted the
enqueue, not that the agent completed the model changes.

Retransmitting the same request id does not attach or enqueue twice. A failed
send reports a failed action so the Viewer can restore the batch for a manual
retry, without leaving a composer pill behind. There is no automatic retry or
exactly-once guarantee if a network acknowledgement is lost.

`attach-location-selection` requires exactly one point or region annotation
whose note is empty. Its single version 2 pill uses mode `location-selection`,
omits `batchId` and comment text, and records only the selected location.
Snapshots are validated against the room's committed model version and
annotation revision before dispatch. Saving or editing annotations alone never
adds pills, and the Extension does not rewrite transformed prompts or maintain
live attachment tokens.

Shutdown drains pending programmatic fix sends for a bounded interval. Explicit
disconnect has its own timeout, while parent `SIGTERM` performs local cleanup
without requesting disconnect from the dying SDK parent. Session shutdown is
observed through `JoinSessionConfig.onEvent`, registered before join can emit
early events. SDK timeline logging is best effort and cannot poison action
delivery.

## Experimental Canvas embedding exception

`Canvas` in `@github/copilot-sdk` 1.0.11 is experimental, and the SDK does not
expose the parent frame origin. This Extension therefore opts into
`ViewerHostOptions.allowAnyFrameAncestor`, which emits `frame-ancestors *`.
This reviewed exception is limited to the Extension composition. Access still
requires an unguessable room URL, the server binds only to loopback, HTTP Host
and WebSocket Host/Origin/credential checks remain strict, responses use
`Referrer-Policy: no-referrer`, and no wildcard (or other) CORS header is sent.
Normal `frameAncestors` entries must be exact HTTP(S) origins; wildcard
hostnames are rejected. The MCP/default ViewerHost policy remains
`frame-ancestors 'none'`.

Both application workspaces are private. The generated MCP and Extension
plugins are distributed separately from this repository, with bundled dependency
license notices retained in each runtime.
