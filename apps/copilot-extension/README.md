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
The self-test initializes embedded WASM, executes a cube, serves and hashes
every embedded Viewer asset, checks two isolated rooms and action idempotency,
and closes the worker, rooms, and host. The verifier also asserts that `dist/`
contains only `extension.mjs`, inspects imports/chunks, and reports raw/gzip and
embedded resource sizes. Production `session.shutdown`, join-race, pending-send,
and signal behavior is covered by the mock-SDK integration tests rather than
claimed by this low-level self-test.

## Local installation

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
`{ "batchId": "<safe-id>" }`. They push exactly one `extension_context` pill
containing a bounded version 2 static snapshot with mode `annotation-batch`,
the model version, annotation revision, batch id, selected geometry, and notes.
`fix-annotation-batch` pushes that pill before enqueueing
`Revise the current manifold-3d model using the attached annotation batch.` and
reports accepted, running, and terminal status through the Viewer Host request.
Retransmitting the same request id does not push or enqueue twice.

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

This workspace is private and is not included by the public
`@zhicwan/manifold3d-mcp` package's `files` allow-list or pack staging script.
