# Repository agent guide

Keep Manifold 3D small, explicit and coherent. These instructions concern
repository maintenance; user-facing modeling guidance lives in `skills/`.

## Read the relevant context

Read the existing owner and affected consumers before editing. Follow applicable
ancestor AGENTS.md files and the reading routes below; do not assume every
harness automatically loads all nested guidance.

| Work                                                                   | Read                                                                         |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| MCP or Copilot app behavior                                            | [apps/AGENTS.md](apps/AGENTS.md)                                             |
| Compilation, geometry, Workers or software capture                     | [modeling guide](packages/modeling/AGENTS.md)                                |
| Viewer, annotations, export or XR                                      | [Viewer guide](packages/viewer/AGENTS.md)                                    |
| Build scripts, workspace configuration, shipped skills or distribution | [build guide](scripts/AGENTS.md), including for build files outside scripts/ |
| Protocol, Viewer Host, dependency direction or cross-module ownership  | [Architecture](docs/architecture.md)                                         |

[The change guide](docs/change-guide.md) explains how to choose a complete fix
and meaningful evidence. [CONTRIBUTING.md](CONTRIBUTING.md) owns the command and
release reference; package scripts and source types define the actual interfaces.

## Preserve the design

- Put logic at its owner. Apps adapt hosts; packages provide reusable capabilities.
  Do not copy compilation, geometry or scene implementation into each adapter.
- Production cross-package imports use public exports. Do not add private-source
  aliases to make an import work in TypeScript while failing in the installed
  runtime. Focused tests may exercise internal source without creating a shipped API.
- Prefer explicit state and ownership over additional flags, registries, retries
  and wrappers. A new abstraction needs a real responsibility and consumer.
  Small, clear differences between entry points can remain duplicated.
- Preserve the meaning of failure. Use established reports, action states and
  errors; do not return an empty/default success to hide a broken contract.
  Do not remove valid recovery or boundary handling merely because it uses catch.
- Keep canonical data separate from presentation and external side effects.
  Preserve lifecycle ownership when an operation completes asynchronously.
- Treat new hosts, persistence and broader embedding as explicit capability
  changes, not compatibility behavior to guess into existence.

## Edit sources, not mirrors

`plugins/`, application bundles and generated sandbox declarations are outputs.
Edit their source, then use the existing generation workflow. The root package
version is the product-version authority; outputs must not become generation inputs.
See the build guide for which changes require artifact regeneration.

These maintenance instructions and `docs/` do not belong in end-user plugins.
Do not create custom agent roles, Markdown preprocessors or new quality tools
just to maintain this guidance.

## Finish with the right evidence

Exercise the changed behavior, including affected boundaries and callers.
Choose existing targeted checks first; use complete artifact checks when changing
distribution. Missing build output and skipped tests are not a passing result.
Distinguish a successful RPC from an observed UI interaction.

Update the relevant contract documentation when behavior or ownership changes.
Do not turn a local implementation edit into a documentation rewrite or a new
framework. Preserve unrelated work and keep the change focused.
