# Annotations (user "marks")

Choose **Annotate** in the viewer, then add spatial comments directly on the
rendered model:

- **Click** drops a point pin and opens its comment editor.
- **Drag** highlights a region and opens its comment editor.
- **Done** commits the current batch for `get_annotations`; **Cancel** discards
  the current draft batch.

Each annotation has:

- a **partLabel** — automatically derived from which primitive the
  user clicked. Examples: `sphere#1`, `cube#2`, `extrude#1 (8/47 tris)
near +X side`. The number is per-kind (the first sphere is `sphere#1`,
  the second `sphere#2`, etc.). Region selections also include the
  proportion of the part the user covered and a 6-axis spatial hint
  (`near +X side` / `on top` / etc.).
- a **worldCoord** in millimetres (the picked point or the centroid of
  the selected region)
- a free-form **note** the user typed (e.g. "too thick", "round this",
  "should be 5mm")

## Reading annotations from your script

Use the `get_annotations` MCP tool — no arguments needed:

```jsonc
// tools/call request
{ "name": "get_annotations", "arguments": {} }
```

Response content is YAML. Its equivalent data structure is:

```json
{
  "modelVersion": "vlj9k2x1",
  "count": 2,
  "annotations": [
    {
      "id": "ann_lj9k_8a2qz",
      "modelVersion": "vlj9k2x1",
      "kind": "point",
      "partLabel": "point#1",
      "note": "too thick",
      "worldCoord": [12.4, 0, 5.2]
    },
    {
      "id": "ann_lj9k_p4xab",
      "modelVersion": "vlj9k2x1",
      "kind": "region",
      "partLabel": "region#1",
      "note": "round this edge",
      "worldCoord": [42.1, 0, 8.9],
      "triCount": 17
    }
  ]
}
```

If the user has no active annotations the body still has the same
shape (with `count: 0`) and a leading `# no active annotations` comment.

## When to call it

Call `get_annotations` whenever the user references their marks
implicitly or explicitly. Examples that should trigger a call:

- "apply my notes"
- "fix what I marked"
- "改一下我标记的"
- "incorporate my feedback"
- right before regenerating the model after the user has been
  reviewing the previous version

It is also fine to call it speculatively at the start of a complex
edit to see whether the user has left feedback. The call is cheap
(one in-process map lookup).

## Lifecycle

- Annotations are **automatically cleared** every time you push a new
  model with `execute_script`. There is no way for stale annotations
  to leak into a subsequent run.
- Annotations live in the viewer's memory only — they are not
  persisted across browser refresh.
- Draft annotations can be edited or deleted from their on-model flyouts.

## Recommended workflow when responding to marks

1. Call `get_annotations` to retrieve the user's feedback.
2. Reason about each annotation: which feature does it reference (use
   `worldCoord` and `partLabel` to localise) and what is the user
   asking for?
3. Edit the script to address the feedback. Keep the rest of the model
   stable unless the user said otherwise.
4. Call `execute_script` with the new code. The viewer will display
   the new mesh and clear the old annotations automatically.
5. Briefly summarise to the user which annotations you addressed and
   how. If you decided not to act on one (e.g. the change would break
   another constraint), say so explicitly.
