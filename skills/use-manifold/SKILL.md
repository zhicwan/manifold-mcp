---
name: use-manifold
description: Build 3D-printable models with the manifold-3d MCP server. Use when the user wants to design, modify, or export geometry (STL/3MF) — anything from a parametric phone stand to a parametric gear. Always validate scripts before showing output.
---

# use-manifold — Skill Guide

> **Skill name:** `use-manifold` — **requires MCP server:** `manifold3d-mcp`

You have access to the Model Context Protocol server (`manifold3d-mcp`) that
runs TypeScript snippets against the [manifold-3d](https://github.com/elalish/manifold)
WASM library, returns a YAML diagnostic report, and pushes the resulting mesh
to a live three.js preview page in the user's browser. The user can export STL
or 3MF directly from that page for 3D printing.

## Tools

- **`validate_script`** — fast pre-flight (~1–2 s). Use this **first** for
  every non-trivial script. It runs the same pipeline as `execute_script` but
  does not refresh the user's preview.
- **`execute_script`** — full run; on success the mesh is pushed to the preview
  page and the YAML report includes a `previewUrl`.
- **`get_annotations`** — cheap, zero-arg, no preview side effects; reads the
  user's active marks on the current model and returns them as a YAML document.
  See [`references/annotations.md`](references/annotations.md).
- **`capture_view`** — renders the last executed model as a PNG from a named
  camera preset (`iso`, `front`, `back`, `left`, `right`, `top`, `bottom`).
  Returns YAML metadata with a `filePath` to the PNG, dimensions, bbox and view.
  Open that file with the host's image-viewing tool to inspect it.
  Optional params: `view` (default `iso`), `width`/`height` (128–2048, default
  1024), `includeAnnotations` (overlay user marks on the capture).

Both tools take exactly one script source: `code` (an inline TypeScript snippet)
or `filePath` (an absolute path to a local `.ts`/`.js` snippet file read by the
MCP server). Relative paths are not supported. Prefer inline `code` for
installed plugins; `filePath` is only available for absolute paths inside the
server's already-authorized script roots. `execute_script` also takes an
optional `description` shown as the preview title.

## The recommended loop

1. **Plan** a model in plain English with the user.
2. **Write** a TypeScript snippet. See the shared references under
   [`references/`](references/).
3. **`validate_script`** — read the YAML report. If `ok: false`, fix the
   issues (see [`references/validation-report.md`](references/validation-report.md))
   and validate again. Iterate quickly here — no preview thrash for the user.
4. **`execute_script`** with a meaningful `description`. The user sees the
   model in their browser.
5. **`capture_view`** — visually verify your result after `execute_script`.
   Call `capture_view` from one or more useful angles, then explicitly compare
   what you see against the user's intent before declaring success. In the
   final response, include at least one concrete visual check, e.g. "top view
   shows the through-hole is open" or "iso view shows the sphere is smooth and
   round with no flat facets visible." Stats alone are not enough.
6. **Iterate** based on what the user sees and asks for. Each tweak is another
   `validate_script` → `execute_script` → `capture_view` cycle.

## Reference index

- [`references/getting-started.md`](references/getting-started.md) —
  what `Manifold` / `CrossSection` / `Mesh` are and how they are pre-bound in
  the sandbox.
- [`references/script-conventions.md`](references/script-conventions.md) —
  hard rules for sandbox TypeScript snippets (`result`, units, forbidden
  globals, timeout, code size).
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
- [`references/annotations.md`](references/annotations.md) — how to read user
  annotations ("marks") with the `get_annotations` MCP tool.
- Sandbox declarations are generated separately at build time into
  `references/manifold-sandbox.d.ts` and mirrored into the assembled
  plugin from this shared reference tree.

## House rules for the LLM (you)

- **`ok: true` is necessary, not sufficient.** After every `validate_script`,
  cross-check the YAML `stats` against your intent before claiming success or
  calling `execute_script`:
  - `bbox.size` — compare the rendered bounding box against the user's
    requested controlling dimensions, not only against constants you chose in
    code. For fit requests phrased as "for a <object> W mm wide/thick" (phone
    stands, cases, holders, cradles), treat the named object width/thickness as
    the controlling fit envelope: the contact slot/opening/support span should
    be within +0–10% of it including clearance, and no unrelated base/lip/
    shoulder may become the model's dominant bbox dimension along that same axis
    unless the user explicitly asks for extra stability or margins. If an
    outside bbox dimension exceeds a named fit dimension by more than 10%,
    revise the geometry so the excess is in a non-controlling axis, or ask
    before proceeding; do not rely on a final-response explanation alone.
  - `genus` — `0` for a single closed solid, `1` per through-hole, `-1` if
    your union produced two disjoint components (typically because two parts
    share only a face — see "Clean booleans" in
    [`references/script-conventions.md`](references/script-conventions.md)).
  - `volume` — sanity-check against a back-of-envelope estimate; off by 10× is
    usually a unit mistake.
- **`capture_view` is a verification step, not a bonus.** After `execute_script`,
  call `capture_view` from at least one relevant angle (e.g. `front` for a flat
  face, `iso` for overall shape) and inspect the PNG.
- **`get_annotations` is MCP-only.** Canvas feedback flows through the host UI,
  not this skill.
