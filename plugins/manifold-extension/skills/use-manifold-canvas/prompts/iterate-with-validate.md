# Iterating with `manifold_validate_script` first

The single most useful habit when driving the Canvas Extension is:

> **`manifold_validate_script` early, `manifold_execute_script` once you are
> confident.**

Why: `manifold_execute_script` repaints the Canvas preview every time.
Validating in a loop without re-rendering keeps the user's screen calm and
gives you tighter feedback.

## Canonical loop

1. Read the user's request. Sketch the model in plain English.
2. Write a TypeScript snippet. Use
   [`../references/examples.md`](../references/examples.md)
   as a starting template. Do not import or export anything; use the ambient
   sandbox globals.
3. Call `manifold_validate_script`.
4. Look at the YAML report:
   - `errors:` non-empty → fix and validate again.
   - `warnings:` `BBOX_TOO_SMALL` / `BBOX_TOO_LARGE` → likely a units mistake.
   - `stats:` sanity-check `triangles`, `volume`, `bbox.size` against the
     user's intent before spending preview time.
5. Once the report is clean, call `manifold_execute_script` with a meaningful
   `description`. The user sees the model in the Canvas preview.
6. Call `manifold_capture_view` and inspect the PNG before telling the user the
   model is ready.

## When to skip validate_script

- Trivial one-liner (`result = Manifold.cube([10,10,10]);`) where you have
  high confidence and the user is waiting for visual feedback.
- A _minor_ tweak on a script that already validated successfully in the same
  conversation.

In every other case, validate first.

## Reading stats during iteration

`manifold_validate_script` populates `stats.bbox.size`, `stats.volume`, and
`stats.triangles` even before any preview push. Use these to debug geometry
without wasting a `manifold_execute_script` round-trip.

## Telling the user what is going on

When you do call `manifold_execute_script`, mention:

- The triangle count and bounding box (from `stats`).
- That they can rotate the view, toggle wireframe, and export as 3MF
  (preferred for printing) or STL.
- Any non-blocking warnings the report surfaced.
