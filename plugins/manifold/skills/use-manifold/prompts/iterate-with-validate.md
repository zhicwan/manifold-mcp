# Iterating with `validate_script` first

The single most useful habit when driving manifold3d-mcp is:

> **`validate_script` early, `execute_script` once you are confident.**

Why: `execute_script` repaints the user's preview every time. Validating in a
loop without re-rendering keeps the user's screen calm and gives you tighter
feedback (no human-in-the-loop, no perceived latency).

## Canonical loop

1. Read the user's request. Sketch the model in plain English ("a 60 × 30
   plate, 4 mm thick, with four 4 mm holes inset 8 mm from each corner").
2. Write a TypeScript snippet. Use
   [`../references/examples.md`](../references/examples.md)
   as a starting template. Do not import or export anything; use the ambient
   sandbox globals. Prefer inline `code`; use `filePath` only when the script
   already lives inside an authorized absolute root.
3. Call `validate_script`.
4. Look at the YAML report:
   - `errors:` non-empty → fix and validate again. Common ones:
     - `RESULT_NOT_ASSIGNED` — add `result = …`.
     - `FORBIDDEN_GLOBAL` — stay inside the sandbox globals.
     - `TS_DIAGNOSTIC` / `TS_EMIT_ERROR` — fix TypeScript API, tuple, or
       argument-shape issues before runtime will run.
     - `EMPTY_RESULT` — your boolean produced no overlap; print a debug
       `console.log` of the bounding boxes and re-validate.
     - `RESULT_TOO_LARGE` / `TIMEOUT` — drop circular segment counts.
   - `warnings:` `BBOX_TOO_SMALL` / `BBOX_TOO_LARGE` — likely a units
     mistake. Tell the user; ask whether they meant millimetres.
   - `stats:` sanity-check `triangles`, `volume`, `bbox.size` against the
     user's intent before spending preview time.
5. Once the report is clean, call `execute_script` with a meaningful
   `description`. The user sees the model in their browser.
6. Wait for the user to react. When they ask for changes, edit the script and
   start again at step 3.

## When to skip validate_script

- Trivial one-liner (`result = Manifold.cube([10,10,10]);`) where you have
  high confidence and the user is waiting for visual feedback.
- A _minor_ tweak (e.g. changing one number) on a script that already
  validated successfully in the same conversation.

In every other case, validate first.

## Reading stats during iteration

`validate_script` populates `stats.bbox.size`, `stats.volume`, and
`stats.triangles` even before any preview push. Use these to debug geometry
without wasting an `execute_script` round-trip:

- **`volume == 0` but `triangles > 0`** — your boolean produced a
  coplanar/zero-thickness result; check that solids actually overlap and that
  you used `subtract` (not `intersect`) where intended.
- **`bbox.size[2] == 1.0` when you expected 100** — a missing `*100`
  somewhere in your loop; coordinates are millimetres.
- **`bbox.size` exceeds `BBOX_TOO_LARGE` (~500 mm)** — your model is
  off by a factor of 10 or 100; check unit assumptions.
- **`triangles` close to 1e6** — refine() / warp() / smooth() can multiply
  triangle counts; cap with explicit subdivision parameters.

Reading these in `validate_script` first means you can adjust units and
booleans before showing the user any preview.

## Reading multiple findings

Errors and warnings are independent — fix the first error before believing
later ones. Typecheck errors block runtime entirely. Many "missing `result`"
reports are caused by a syntax error above the assignment, which the parser
flags first.

## Telling the user what is going on

When you do call `execute_script`, mention:

- The triangle count and bounding box (from `stats`).
- That they can rotate the view, toggle wireframe, and export as 3MF
  (preferred for printing) or STL.
- Any non-blocking warnings the report surfaced (e.g. `FEATURE_TOO_FINE`
  hint).
