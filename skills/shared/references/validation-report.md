# Validation Report Schema

Both `validate_script` and `execute_script` return a single text content item
containing a YAML document with this shape:

```yaml
ok: true # false if any errors[] entry exists
stage: ok # last stage reached: syntax | static | typecheck | runtime | geometry | print | ok
durationMs: 87 # wall clock for the whole run

errors: [] # blocking findings; presence ⇒ ok: false
warnings: [] # advisory; ok stays true
hints: # purely informational
  - Manifold has no intrinsic units; this server interprets coordinates as millimetres.

stats: # populated when finite geometry stats are available
  triangles: 12
  vertices: 8
  volume: 8000
  surfaceArea: 2400
  genus: 0
  bbox:
    min: [-10, -10, -10]
    max: [10, 10, 10]
    size: [20, 20, 20]

previewUrl: http://127.0.0.1:3737/ # only on successful execute_script
```

Every entry in `errors[]` and `warnings[]` looks like:

```yaml
- stage: static
  code: FORBIDDEN_GLOBAL
  message: Forbidden global 'require' is not available in the sandbox.
  line: 1
  col: 12
  snippet: const fs = require('fs');
```

`line`, `col`, and `snippet` are present whenever the source location is
known. Read them: they tell you which character in the script tripped the
check.

Typecheck findings may also include `tsCode`, the numeric TypeScript diagnostic
code (for example `2345` for an argument type mismatch). Runtime is skipped
whenever the typecheck stage reports an error.

## Error & warning code reference

### Stage `syntax`

| Code           | Meaning                         | Typical fix                                                                       |
| -------------- | ------------------------------- | --------------------------------------------------------------------------------- |
| `SYNTAX_ERROR` | Acorn could not parse the code. | Check the line/col, fix the typo. The `message` is the parser's exact diagnostic. |

### Stage `static`

| Code                               | Meaning                                                                                                                      | Typical fix                                                                                                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INVALID_ARGUMENT`                 | Tool arguments are malformed, such as passing both `code` and `filePath`, passing neither, or passing a relative `filePath`. | Pass exactly one script source: inline `code` or an absolute local `filePath`.                                                                                                |
| `CODE_TOO_LARGE`                   | Source > 64 KB.                                                                                                              | Refactor — extract repeated geometry into a loop.                                                                                                                             |
| `FILE_READ_ERROR`                  | The MCP server could not read `filePath`, or the path is not a file.                                                         | Check that the absolute path exists on the MCP server host.                                                                                                                   |
| `FORBIDDEN_GLOBAL`                 | You referenced `require` / `import` / `export` / `process` / `fs` / etc.                                                     | Stay inside the pre-bound globals (`Manifold`, `CrossSection`, `Mesh`, `console`, `Math`, …).                                                                                 |
| `RESULT_NOT_ASSIGNED`              | The snippet never assigns to `result`.                                                                                       | Add `result = …` somewhere at the top level.                                                                                                                                  |
| `UNKNOWN_API` _(warning)_          | `Manifold.foo` / `CrossSection.foo` is not in the static whitelist.                                                          | Check spelling — the message includes suggestions or an idiom for common wrong guesses such as `Manifold.box`, `CrossSection.ofPolygon`, and `CrossSection.roundedRectangle`. |
| `INVALID_CONSTRUCTION` _(warning)_ | Static lint spotted a call pattern likely to create invalid geometry, such as object-style `Manifold.cylinder({ ... })`.     | Use positional API signatures from `manifold-api.md`. Runtime may still continue and fail later.                                                                              |
| `RADIANS_DETECTED` _(warning)_     | A `rotate(...)` call appears to use `Math.PI` or a small non-integer radian value.                                           | Manifold rotations are degrees; use `90`, `45`, `-30`, etc.                                                                                                                   |

### Stage `typecheck`

TypeScript diagnostics block runtime execution: fix these before interpreting
any later geometry result. The snippet is compiled with ambient globals for
`Manifold`, `CrossSection`, `Mesh`, `console`, and `result`; imports and
exports are still forbidden by the static stage.

| Code            | Meaning                                                                 | Typical fix                                                                                       |
| --------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `TS_DIAGNOSTIC` | The TypeScript compiler rejected the snippet. `tsCode` has the TS code. | Read `message`, `line`, `col`, and `tsCode`; fix method names, argument shapes, tuple types, etc. |
| `TS_EMIT_ERROR` | TypeScript failed to emit JavaScript after diagnostics.                 | Fix the preceding diagnostics first; if none are shown, simplify the snippet and validate again.  |

Common TypeScript diagnostics in manifold3d-mcp snippets:

| `tsCode`        | Usually means                                                                  | Fast fix                                                                                                      |
| --------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `2339`          | Unknown static/instance API.                                                   | Check the static warnings for a replacement such as `Manifold.cube` or the rounded-rectangle recipe.          |
| `2554`          | Wrong argument count or options-object call.                                   | Use positional signatures; e.g. `Manifold.cylinder(height, radiusLow, radiusHigh, segments, center)`.         |
| `2740`          | `CrossSection` used where `Manifold` is required, commonly `result = profile`. | Use `profile.extrude(height)`, `Manifold.extrude(profile, height)`, or `Manifold.revolve(profile, segments)`. |
| `2322` / `2769` | Tuple/vector mismatch, union with `undefined`, or incompatible assignment.     | Add tuple annotations and guard array/map lookups before passing values to Manifold or assigning `result`.    |

### Stage `runtime`

| Code            | Meaning                                         | Typical fix                                                                                              |
| --------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `TIMEOUT`       | Worker exceeded 5 s.                            | Reduce `circularSegments`, simplify a `levelSet`, or remove an O(n²) loop.                               |
| `OUT_OF_MEMORY` | Worker exceeded the 512 MB hard heap limit.     | Cut intermediate geometry; call `delete()` on Manifolds you no longer need (see `memory-management.md`). |
| `WORKER_CRASH`  | Worker exited unexpectedly.                     | Treat as a runtime error; check the `message` for context.                                               |
| `RUNTIME_ERROR` | Your code threw, or geometry inspection failed. | Read the `message` and `snippet` (top of stack).                                                         |

### Stage `geometry`

These map 1:1 from the manifold-3d `ErrorStatus` enum, plus a few sandbox-only
checks.

| Code                                                                                                                                                                                                                         | Meaning                                                         | Typical fix                                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RESULT_NOT_MANIFOLD`                                                                                                                                                                                                        | `result` was assigned but is not a Manifold instance.           | Make sure the last assignment is a Manifold (e.g. via a boolean op), not e.g. a CrossSection or a number.                                            |
| `EMPTY_RESULT`                                                                                                                                                                                                               | `result.isEmpty()` is true.                                     | Check boolean overlap, subtract/intersect order, self-subtraction, fully removed parts, and warp callbacks that can create NaN/Infinity.             |
| `NON_FINITE_VERTEX`                                                                                                                                                                                                          | A NaN/Infinity slipped into vertex data.                        | Check `Math.atan2` / division by zero in any `warp` callback.                                                                                        |
| `NOT_MANIFOLD`                                                                                                                                                                                                               | Mesh has gaps, T-junctions, or self-intersections.              | Avoid marginal geometry (see `tips.md` precision section).                                                                                           |
| `VERTEX_OUT_OF_BOUNDS`, `PROPERTIES_WRONG_LENGTH`, `MISSING_POSITION_PROPERTIES`, `MERGE_VECTORS_DIFFERENT_LENGTHS`, `MERGE_INDEX_OUT_OF_BOUNDS`, `TRANSFORM_WRONG_LENGTH`, `RUN_INDEX_WRONG_LENGTH`, `FACE_ID_WRONG_LENGTH` | You hand-built a `Mesh` and the field lengths are inconsistent. | Cross-check `numProp`, `vertProperties.length`, `triVerts.length`, run vectors.                                                                      |
| `INVALID_CONSTRUCTION`                                                                                                                                                                                                       | The constructor rejected its input (e.g. degenerate primitive). | Check positive radii/heights/thicknesses, inner dimensions < outer dimensions, positional constructor args, polygon winding, and self-intersections. |
| `RESULT_TOO_LARGE`                                                                                                                                                                                                           | Manifold rejected an operation as exceeding internal bounds.    | Reduce subdivision / segment counts.                                                                                                                 |
| `INVALID_TANGENTS`                                                                                                                                                                                                           | Tangent data passed to `smooth` was inconsistent.               | Pass simpler smoothing parameters or omit them.                                                                                                      |
| `CANCELLED`                                                                                                                                                                                                                  | Computation was cancelled by an `ExecutionContext`.             | Almost never happens here; treat as a transient error.                                                                                               |
| `ZERO_VOLUME` _(warning)_                                                                                                                                                                                                    | `volume() <= 0`.                                                | Likely a planar or self-cancelling shape.                                                                                                            |
| `TRIANGLE_BUDGET` _(warning)_                                                                                                                                                                                                | `> 500 000` triangles.                                          | Drop circular segments.                                                                                                                              |
| `BBOX_TOO_SMALL` _(warning)_                                                                                                                                                                                                 | Smallest dimension < 0.1 mm.                                    | Scale up or change units.                                                                                                                            |
| `BBOX_TOO_LARGE` _(warning)_                                                                                                                                                                                                 | Largest dimension > 500 mm.                                     | Scale down or split the model.                                                                                                                       |

### Stage `print`

| Code                        | Meaning                                         | Typical fix                                                        |
| --------------------------- | ----------------------------------------------- | ------------------------------------------------------------------ |
| `FEATURE_TOO_FINE` _(hint)_ | Estimated feature size < typical 0.4 mm nozzle. | Thicken thin walls or print at higher resolution / smaller nozzle. |

## Troubleshooting generic geometry failures

If a complex snippet returns `INVALID_CONSTRUCTION` without an obvious source
line, validate subassemblies independently. Assign only the shell to `result`,
then only cutters, then decorative profiles, then final booleans. This quickly
separates bad primitive parameters from a bad `CrossSection` profile.

Common checks:

1. All radii, heights, wall thicknesses, and scale factors are positive.
2. Inner dimensions are smaller than outer dimensions after subtracting wall
   thickness.
3. Factory calls use positional arguments, not option objects.
4. `CrossSection.ofPolygons` outer rings are counter-clockwise for the default
   `'Positive'` fill rule; holes are clockwise.
5. Boolean operands actually overlap when using `intersect`, and cutters pass
   fully through the part when using `subtract`.
6. `rotate(...)` receives degrees, not radians.

When geometry cannot be inspected, `stats` may be omitted and the report will
include a hint explaining that finite bounds were unavailable.
