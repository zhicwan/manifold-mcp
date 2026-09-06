# Modeling

Apply the [root guide](../../AGENTS.md). This package owns modeling behavior,
not MCP/Copilot integration, browser state or a host's filesystem policy.
See [Architecture](../../docs/architecture.md) for the session/artifact boundary.

## Execution and data contracts

- Preserve Runner's instance-owned queue and disposable Worker lifecycle.
  Keep the execution budget end-to-end and terminate a completed Worker before
  returning its result. Do not describe the in-process defenses as an OS sandbox.
- Keep failed execution and rejected pre-commit hooks from replacing the current
  model. Do not assume that post-commit notification failures roll it back.
- Keep WASM ownership and cleanup explicit. Do not weaken prototype hardening,
  validation or resource limits to work around a new implementation issue.
- Match ambient types to the real upstream API, not a guessed matrix layout:
  API Mat3/Mat4 use 9/16 elements; feature metadata's 12-element transform is a
  different contract.
- [ambient-types.ts](src/sandbox/ambient-types.ts) is the declaration source.
  Regenerate consumers rather than editing copies.
- Preserve error location mapping in standalone bundles. Do not add assumptions
  that a source checkout, sibling WASM file or package directory exists at runtime.

## Software capture

Keep coordinate spaces explicit. Grid and line work must be bounded by the view,
not an unbounded loop over world coordinates. Fit both image dimensions, clip
work to the viewport and preserve geometric depth semantics. Annotation/UI
overlays have a different purpose from hidden solid edges.
Do not hide an invalid result behind an empty image or an outer timeout that
cannot interrupt synchronous work.

Relevant evidence: [session behavior](../../tests/modeling-session.test.ts),
[Workers](../../tests/runner-host.test.ts),
[API/runtime agreement](../../tests/ambient-vs-runtime.test.ts),
[source mapping](../../tests/runtime-source-location.test.ts) and
[rendering](../../tests/renderer.test.ts).
Use the [change guide](../../docs/change-guide.md) to select checks and regeneration.
