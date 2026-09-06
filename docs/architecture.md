# Architecture

Manifold 3D has reusable modeling and viewing capabilities, with separate host
compositions and installable plugin outputs. The goal is clear ownership and
small interfaces, not a universal harness framework.

Use [AGENTS.md](../AGENTS.md) for editing guidance,
[the change guide](change-guide.md) for choosing evidence, and
[CONTRIBUTING.md](../CONTRIBUTING.md) for commands and release procedures.
Source types and implementations remain authoritative for API details.

## Ownership and dependencies

| Location                 | Owns                                                                                                 | Does not own                                           |
| ------------------------ | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `apps/manifold3d-mcp`    | MCP input/results, stdio, file-source policy, browser launch, single-room composition                | Geometry execution or browser UI implementation        |
| `apps/copilot-extension` | Copilot SDK, Canvas rooms, message delivery, Extension entry                                         | MCP transport or a separate modeling implementation    |
| `packages/protocol`      | Versioned wire data, codecs and boundary validation                                                  | Node, React, Three.js or host SDK services             |
| `packages/modeling`      | Compilation, disposable Workers, geometry validation, artifacts, model sessions and software capture | MCP/Copilot APIs, browser state or transport lifecycle |
| `packages/viewer`        | Scene presentation, interaction, annotations, canonical exports and optional XR                      | Node services or direct host SDK calls                 |
| `packages/viewer-host`   | HTTP/WS, asset providers, authenticated rooms and action dispatch                                    | Modeling execution or browser implementation           |
| `skills`                 | Authored modeling references and host-specific skill entry points                                    | Repository-maintenance instructions                    |
| `plugins`                | Generated, self-contained installation directories                                                   | Independently maintained source                        |

Applications compose inward. Modeling, Viewer and Viewer Host share protocol,
not each other's implementations. Cross-package imports use package exports;
production source-path aliases must not create a different dependency graph for TypeScript
than for Node or the bundler.
Focused tests can reference internals without making them public package exports.

The [import rules](../eslint.config.mjs) and
[boundary regressions](../tests/package-boundaries.test.ts) support this direction.
Adding a shared abstraction requires a real responsibility and consumer;
similar-looking adapter code alone is not a reason to create another layer.

## Modeling and publication

```text
Host input
  -> ModelingSession / ModelingEngine
  -> Runner -> disposable Worker
  -> static checks -> TypeScript -> Manifold WASM -> geometry validation
  -> ModelArtifact
  -> app publication through toViewerModelFrame
  -> Viewer Host room -> browser Viewer
```

This is a data-flow map, not a distributed transaction guarantee.
[ModelingSession](../packages/modeling/src/modeling.ts) owns the current committed
artifact, its revision and operation ordering. Validation does not commit a model.
Successful execution must finish the pre-commit hook before replacing the current
model; failed execution or a rejected pre-commit hook preserves the previous one.
Post-commit subscriber failures do not undo an already committed model.

The adapters currently publish through that pre-commit hook. Keep this ordering
explicit when changing publication. Do not infer that unrelated SDK or UI side
effects can be rolled back with model state. Browser launch is a post-publication
presentation action, not a condition for committing valid geometry.

The artifact retains modeling data. The existing
[projection](../packages/modeling/src/runner/model-artifact.ts) supplies the Viewer
contract without making transports interpret arbitrary engine internals.
Session revisions, room model versions, client annotation revisions and batch
identifiers have different owners; do not treat them as interchangeable tokens.

See [session behavior](../tests/modeling-session.test.ts) and
[preview lifecycle](../tests/preview-lifecycle.test.ts).

## Geometry is not presentation state

Canonical model coordinates and Viewer/XR placement are separate. Moving or
scaling a model for immersive viewing must not change its printable geometry.
Exports use a captured payload, not the live scene mesh. Likewise, CSS dimensions
and drawing-buffer pixels are distinct units.

The flat Viewer must not import XR implementation. The default browser entry
opts into the [XR subpath](../packages/viewer/src/xr/index.tsx) through the existing
composition slots. XR owns immersive behavior, not the entire Viewer.

Each active Viewer generation owns its scene, subscriptions and interaction APIs.
An asynchronous completion must not restore state or clear a request belonging
to a replacement generation. Disposal is not an ordinary user-operation failure.

Software capture renders a model artifact using a requested view; it is not a
screenshot of the host application. Bound rasterization by the viewport and
geometry complexity, with explicit framing, clipping and depth semantics.

Relevant evidence includes [STL export](../tests/stl-export.test.ts),
[component ownership](../tests/viewer-component-ownership.test.ts),
[capture rendering](../tests/renderer.test.ts) and the existing flat-build check.

## Annotation delivery

The Viewer owns editable drafts and on-model markers. The host application owns
delivery outside the Viewer. Saving or editing a draft does not itself create
chat context.

| Action                       | External effect                                                             |
| ---------------------------- | --------------------------------------------------------------------------- |
| Extension Fix                | Send the complete bounded snapshot in an enqueued message; no composer pill |
| Extension Attach             | Append a static batch pill; do not send a message                           |
| Extension location selection | Append a location pill without a comment                                    |
| MCP Done / Cancel            | Commit or discard the local draft batch for the MCP annotation workflow     |

Fix success means the SDK accepted enqueueing, not that an agent finished the
requested model edit. A static attachment is not a live synchronized object.
Request retransmission and a user's new operation are also different cases.
Do not turn these into a speculative cross-system transaction or automatic
compensation service.

The [Extension composition](../apps/copilot-extension/src/composition.ts) and
[integration cases](../apps/copilot-extension/test/extension.integration.test.ts)
define the current delivery contract. Detailed SDK behavior belongs in the
[Extension README](../apps/copilot-extension/README.md).

## Resource and failure boundaries

Runner owns worker lifetime, including termination before returning a completed
request. Worker hardening is defense-in-depth, not OS isolation. Viewer Host owns
its connections and rooms; each app owns its transport and external side effects.
Keep cleanup with the resource owner rather than adding timeouts at every caller.

Boundary validation, origin/credential restrictions and execution budgets serve
real contracts. Removing them is not architectural simplification. Conversely,
an internal invariant failure must not become an empty result or a default model.
Use the established error/report/status form and preserve its meaning.

Cleanup may need to continue after one failure and report aggregated errors.
Logging failure must not poison successful delivery. Missing provenance can be
represented explicitly as unknown; it is not permission to accept malformed
geometry or wire data. Judge recovery by its semantics, not the presence of
`catch`, `fallback` or `undefined` in the implementation.

See [Worker behavior](../tests/runner-host.test.ts) and
[room/connection lifecycle](../tests/viewer-host-rooms.test.ts).

## Source and distribution

`build:plugins` builds both applications and then runs the
[assembler](../scripts/build-plugins.mjs). Each plugin contains its runtime,
metadata and complete skill references. Shared source is maintained once;
physical duplication in independently installable outputs is intentional.

The root package version is the product version. Generated output is never an
input to its own metadata generation. The assembler's check mode compares staged
output without replacing committed plugins; the npm command still performs its
build steps. It is not a side-effect-free command.

MCP requires Node and its bundled resources. The Extension additionally relies on
the SDK supplied by its host. Neither artifact should discover missing
dependencies by searching the checkout or downloading them at runtime.
See [build guidance](../scripts/AGENTS.md) and
[CONTRIBUTING.md](../CONTRIBUTING.md) for the source/output and release workflow.

## Current limits, not hidden promises

- Different hosts start MCP in different working directories. Executable location
  is not workspace authorization; follow the existing file-source contract.
- Live models and Viewer draft/marker state do not have provider-restart
  persistence. Already delivered chat snapshots belong to the host instead.
- Independent iframe instances do not imply arbitrary same-document multi-view
  embedding is supported.
- Copilot Canvas and message integrations are host-specific, not portable MCP
  capabilities.

A concrete requirement can change these boundaries. Make that change explicit
in ownership, behavior, documentation and evidence instead of simulating it with
path guesses, compatibility aliases or success-shaped fallbacks.
