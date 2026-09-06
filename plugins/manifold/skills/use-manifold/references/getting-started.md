# Getting Started

> Source: [manifold/bindings/wasm/documents/bindings.md](https://github.com/elalish/manifold/blob/master/bindings/wasm/documents/bindings.md)
> (Apache-2.0). Adapted for the manifold3d-mcp sandbox.

## You do **not** need to install or initialize anything

In a stand-alone manifold project you would write:

```ts
import Module from 'manifold-3d';
const wasm = await Module();
wasm.setup();
const { Manifold, CrossSection } = wasm;
```

Inside the manifold3d-mcp sandbox, snippets are **TypeScript-only** and `Manifold`,
`CrossSection`, `Mesh`, `console`, and `result` are **already pre-bound as
ambient globals**. Do **not** write `import` or `export` statements — module
syntax is blocked by the static lint and will fail with `FORBIDDEN_GLOBAL`.

A minimal valid snippet is therefore one line:

```ts
result = Manifold.cube([20, 20, 20], true);
```

`result` is the only output channel: whatever Manifold instance you assign to
`result` is what the validator inspects and what the preview renders.

> **Don't redeclare `result`.** It is already declared by the sandbox, so
> `let result = …`, `const result = …`, and `var result = …` all fail
> typecheck with `TS2451: Cannot redeclare block-scoped variable 'result'`.
> Just write `result = …`.

## The intro example, in sandbox form

The official intro example becomes:

```ts
const { cube, sphere } = Manifold;
const box = cube([100, 100, 100], true);
const ball = sphere(60, 100);
result = box.subtract(ball);
```

Notice: no `delete()` calls, no top-level `await`, and no module syntax. The
typecheck stage compiles this TypeScript before runtime, so API
shape mistakes (for example object-style constructor arguments) are reported
without running the snippet.

## What you get back

- `validate_script` returns a YAML report only (the user does **not** see a
  preview update).
- `execute_script` returns the same YAML report **plus** a `previewUrl`. The
  user's browser receives the mesh over WebSocket and renders it.
- Both tools accept exactly one script source: inline `code` or a local
  `filePath` read by the MCP server. `filePath` must be an absolute path;
  relative paths are not supported.

See [`validation-report.md`](validation-report.md) for the report schema.
