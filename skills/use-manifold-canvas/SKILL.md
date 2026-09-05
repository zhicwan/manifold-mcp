---
name: use-manifold-canvas
description: Build 3D-printable models with the Copilot Extension canvas. Use when the user wants to validate, execute, or capture geometry inside the native Canvas workflow.
---

# use-manifold-canvas — Skill Guide

> **Skill name:** `use-manifold-canvas` — **requires Extension:** `manifold-extension`

You have access to the native Copilot Extension tools that validate snippets,
execute the current model, and capture a rendered view. The Extension uses the
same manifold-3d modeling sandbox as the MCP server, but it is a different
host workflow: there is no `get_annotations` tool here and no MCP-style
annotation round-trip.

## Tools

- **`manifold_validate_script`** — fast pre-flight (~1–2 s). Use this **first**
  for every non-trivial script. It validates a TypeScript snippet without
  changing the current Canvas model.
- **`manifold_execute_script`** — full run; on success the mesh is published to
  the open Manifold Canvas and the optional `description` is shown by the
  Canvas.
- **`manifold_capture_view`** — renders the last executed model as a PNG from a
  named camera preset (`iso`, `front`, `back`, `left`, `right`, `top`,
  `bottom`). The image is saved in the active Copilot session workspace.

The script tools accept exactly one source field: `code` (an inline TypeScript
snippet). `filePath` loading is not part of the Extension contract.
`manifold_execute_script` also takes an optional `description` shown by the
Canvas.

## The recommended loop

1. **Plan** a model in plain English with the user.
2. **Write** a TypeScript snippet. See the shared references under
   [`references/`](references/).
3. **`manifold_validate_script`** — read the YAML report. If `ok: false`, fix
   the issues and validate again.
4. Open the `manifold3d-viewer` Canvas with the host's Canvas tools, then call
   **`manifold_execute_script`** with a meaningful `description`. The user
   sees the model in the Canvas preview.
5. **`manifold_capture_view`** — visually verify your result after execution.
   Use one or more useful angles, then explicitly compare what you see against
   the user's intent before declaring success. In the final response, include
   at least one concrete visual check.
6. **Iterate** based on what the user sees and asks for. Each tweak is another
   validate → execute → capture cycle.

## Reference index

- [`references/getting-started.md`](references/getting-started.md) —
  sandbox globals, `result`, and the basic TypeScript-only workflow.
- [`references/script-conventions.md`](references/script-conventions.md) —
  hard rules for sandbox snippets (`result`, units, forbidden globals, timeout,
  code size).
- [`references/manifold-api.md`](references/manifold-api.md) —
  primitives, booleans, transforms, properties.
- [`references/cross-section-api.md`](references/cross-section-api.md) —
  2D shapes that you can `extrude`, `revolve`, or use in `levelSet`.
- [`references/memory-management.md`](references/memory-management.md) —
  why you usually do not need to call `delete()` here, and when you should.
- [`references/tips.md`](references/tips.md) — precision,
  units, rotation pitfalls, copied verbatim from upstream.
- [`references/validation-report.md`](references/validation-report.md) —
  the YAML schema and every error/warning code, with typical fixes.
- [`references/examples.md`](references/examples.md) —
  runnable TypeScript snippets you can adapt as a starting point.
- [`prompts/iterate-with-validate.md`](prompts/iterate-with-validate.md) —
  the main validate → execute → capture loop for the Extension.
- [`prompts/fix-and-attach.md`](prompts/fix-and-attach.md) —
  how to keep the host's Fix and Attach actions explicit.

## House rules for the LLM (you)

- **`ok: true` is necessary, not sufficient.** After every
  `manifold_validate_script`, cross-check the YAML `stats` against your intent
  before claiming success or calling `manifold_execute_script`.
- **No `filePath` guessing.** The Extension tools are inline-code only. If the
  user wants to work from a file, read the file in the workspace and pass its
  content as `code`.
- **`manifold_capture_view` is a verification step, not a bonus.** After
  `manifold_execute_script`, capture at least one relevant angle and inspect the
  PNG before declaring the model ready.
- **Canvas feedback uses explicit snapshots.** Apply the supplied batch or
  location context; do not call MCP `get_annotations` in this host.
