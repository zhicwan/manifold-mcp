# Viewer

Apply the [root guide](../../AGENTS.md). This package owns browser presentation
and interaction; host effects go through the existing protocol/action boundary.
Do not import Node, modeling internals or vendor SDKs into the browser Viewer.

## Geometry and display

- Canonical payload geometry is not the live scene. Export from captured model
  data so XR scale/placement and asynchronous UI changes cannot alter the output.
- Keep model, world, projection and screen coordinates distinct. CSS dimensions
  and drawing-buffer pixels must be compared in the same units.
- Preserve on-demand rendering instead of masking repeated resize/render work
  with throttling.
- Flat modules must not import XR implementation. Opt into the XR subpath through
  the established entry/slots and keep its scene access narrow.

## Interaction and lifetime

- Use the current runtime/store identity as the owner of asynchronous work.
  Late completions must not restore a disposed batch or clear another request.
  Do not add a second generation registry to compensate for unclear ownership.
- Preserve current-runtime failure recovery, success/freeze and cancellation.
  Disposal or replacement is not an ordinary failed user action.
- Keep draft edits distinct from host submission. Do not push intermediate state
  into chat or make the Viewer call a host SDK directly.
- Release subscriptions, scene contributions and renderer resources through the
  existing lifecycle. Do not assume iframe isolation proves same-document
  multi-view embedding works.

See [Architecture](../../docs/architecture.md) and
[the change guide](../../docs/change-guide.md).
Relevant cases include [component ownership](../../tests/viewer-component-ownership.test.ts),
[canvas ownership](../../tests/viewer-canvas-ownership.test.ts),
[STL export](../../tests/stl-export.test.ts) and
[XR composition](../../tests/viewer-xr-composition.test.ts).
When the composition boundary changes, retain the existing flat-build proof.
