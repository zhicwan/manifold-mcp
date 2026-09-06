# Making a good change

This guide concerns maintenance of the repository, including agent-authored code.
Model-generation instructions for end users belong in `skills/`, not here.
Start with [AGENTS.md](../AGENTS.md) and the relevant local guide.

## Find the smallest complete change

1. Identify the behavior being changed, its owner and its callers. Read the
   existing implementation and related tests before proposing a new abstraction.
2. Describe the actual trigger, expected result and affected state. For a new
   capability, identify a real consumer and the boundary it needs.
3. Add a regression that exercises that behavior, then implement at its owner.
   Include affected producers, consumers and generated outputs; a small diff
   that leaves inconsistent behavior is not a complete fix.
4. Use the relevant existing checks and update the authoritative documentation
   when a contract changes. Ordinary internal edits need not rewrite architecture.

A little duplication in two concrete entry points is preferable to a framework
that hides their different semantics. Reuse established helpers and contracts,
but do not add a facade, registry, option or fallback for a hypothetical future
host. [Architecture](architecture.md) explains the current boundaries.

## Treat different outcomes differently

| Situation                             | Expected handling                                                           |
| ------------------------------------- | --------------------------------------------------------------------------- |
| Invalid script or tool input          | The established diagnostic report or failed action; no fabricated success   |
| Broken internal invariant             | Surface the failure rather than supplying a guessed value                   |
| Operation cancelled or owner replaced | Stop that operation from modifying replacement state                        |
| Failure after an external effect      | Describe what actually committed; do not blindly repeat the whole operation |
| One resource fails to close           | Release the other owned resources and report meaningful cleanup errors      |
| SDK logging fails                     | Keep delivery and shutdown independent of best-effort logging               |

Prefer types, explicit inputs and clear ownership over assertions that merely
silence the compiler. Do not expand file access, weaken wire/origin checks or
relax Worker boundaries to make a scenario pass. Equally, do not delete valid
boundary handling by searching for `catch` or `fallback`.

## Choose evidence for the changed behavior

The command reference lives in [CONTRIBUTING.md](../CONTRIBUTING.md), with actual
script definitions in [package.json](../package.json). This table routes changes;
it is not another copy of the command catalog.

| Change                                          | Representative evidence                                                                                                                                                                                          | Generated plugins                                                |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Modeling, sandbox or Worker                     | [Runner](../tests/runner-host.test.ts), [API/runtime contract](../tests/ambient-vs-runtime.test.ts), [compiler](../tests/typescript-compiler.test.ts), [error mapping](../tests/runtime-source-location.test.ts) | Rebuild shipped changes; regenerate declarations for API changes |
| Viewer, XR, export or capture                   | [Ownership](../tests/viewer-component-ownership.test.ts), [STL](../tests/stl-export.test.ts), [renderer](../tests/renderer.test.ts); flat-build proof when the XR boundary changes                               | Rebuild affected application assets                              |
| Host actions or application lifecycle           | [Extension integration](../apps/copilot-extension/test/extension.integration.test.ts), [preview lifecycle](../tests/preview-lifecycle.test.ts), [MCP smoke](../tests/smoke.test.ts)                              | Rebuild affected runtimes                                        |
| Wire, imports or Viewer Host                    | [Protocol](../tests/viewer-protocol.test.ts), [rooms](../tests/viewer-host-rooms.test.ts), [package boundaries](../tests/package-boundaries.test.ts)                                                             | Rebuild changed consumers                                        |
| Build, shipped skills or release metadata       | [Assembly](../tests/plugin-assembly.test.mjs), existing output comparison and [isolated installation](../scripts/test-installed-plugin.mjs)                                                                      | Regenerate complete outputs                                      |
| Repository AGENTS/docs/README/CONTRIBUTING only | Markdown formatting, links and consistency with actual code/commands                                                                                                                                             | No runtime rebuild or product-version bump                       |

Start with the smallest relevant selection. Broaden when behavior crosses
boundaries, a targeted result reveals uncertainty, or packaging affects complete
deliverables. Use existing tooling instead of introducing another test framework.
`:built` commands require fresh corresponding build output. A skipped test due to
missing output is not evidence that the behavior works.

Keep expectations tied to observable results:

- Check actual dimensions, coordinates, framing and occlusion, not just triangle
  counts or whether a PNG was produced.
- Check the content sent and effects performed, not only mock invocation order.
- Exercise delayed completion and replacement when lifecycle ownership changes.
- Check independent artifact execution and failure paths, not only a successful
  cube inside a checkout that supplies missing dependencies.
- Distinguish SDK/RPC success from seeing the host UI. A URL or Canvas open
  response alone does not establish layout, interaction or rendering correctness.

If a relevant behavior was not exercised, say so rather than extending a claim
from a narrower result. Do not reload a user's running extension, replace their
installation or send a Fix message merely to complete an automated check.

## Update the correct source

| Information                         | Source of truth                                                       |
| ----------------------------------- | --------------------------------------------------------------------- |
| Runtime APIs and allowed data       | Source types, implementations and behavior tests                      |
| Architectural ownership and reasons | [architecture.md](architecture.md)                                    |
| Agent action guidance               | Root and scoped AGENTS.md files                                       |
| Commands and release procedure      | [CONTRIBUTING.md](../CONTRIBUTING.md), package scripts and workflows  |
| Product version                     | Root package.json                                                     |
| Sandbox declarations                | [ambient-types.ts](../packages/modeling/src/sandbox/ambient-types.ts) |
| Product skill content               | Authored `skills/` entries and shared references                      |
| Plugin installation directories     | Generated from those sources, never edited as independent source      |

Do not copy whole API schemas, changing test totals or the current product
version into maintenance guidance. Link to the authoritative location.
Keep global rules in the root guide and local constraints in their applicable
subtree; add another scoped file only when it has distinct, useful instructions.

The documentation-only exception does not cover shipped skill content,
LICENSE or NOTICE: those can affect the delivered artifacts. Follow the existing
generation and version procedure for product changes. A documentation task is
not a reason to upgrade dependencies, rebuild large artifacts, add CI machinery
or alter runtime behavior.
