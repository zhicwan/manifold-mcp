# Contributing

Use Node.js 24 or later and npm. npm installs development dependencies; it is
not the distribution channel for the plugins.

```sh
npm ci
npm run build:plugins
```

## Ownership

| Directory                | Responsibility                                            |
| ------------------------ | --------------------------------------------------------- |
| `apps/manifold3d-mcp`    | MCP/stdio, browser launch and single-room composition     |
| `apps/copilot-extension` | Copilot SDK, Canvas and message integration               |
| `packages/protocol`      | Browser/Node data contracts                               |
| `packages/modeling`      | Compilation, execution, model state and software capture  |
| `packages/viewer`        | Scene, annotation UI, exports and optional XR subpath     |
| `packages/viewer-host`   | HTTP/WS, authenticated rooms and host actions             |
| `skills`                 | Shared references and two directly authored skill entries |
| `plugins`                | Generated, self-contained installation directories        |

Applications depend on reusable packages, not the reverse. Consumers use package
exports rather than cross-package source aliases. XR presentation transforms
must not affect canonical model geometry or exports.

## Build and check

| Command                            | Purpose                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------- |
| `npm run build:plugins`            | Build both single-file applications and assemble plugins                  |
| `npm run build:plugins -- --check` | Build and compare without replacing committed plugin output               |
| `npm run build:mcp`                | Build the standalone MCP runtime and its browser/XR Viewer                |
| `npm run build:extension`          | Build the single-file native Extension and flat Viewer                    |
| `npm run build:sandbox-types`      | Regenerate canonical declarations and sample types                        |
| `npm run check:sync`               | Check authored skill tool lists against application tools                 |
| `npm run typecheck`                | Type-check the workspace                                                  |
| `npm run lint`                     | Lint authored code                                                        |
| `npm run format:check`             | Check authored formatting                                                 |
| `npm test`                         | Build, check generated plugins, and run behavioral and distribution tests |
| `npm run verify:extension`         | Verify the Extension can run its self-test without sibling resources      |
| `npm run verify:viewer-flat`       | Verify the flat Viewer does not include XR                                |
| `npm run dev:viewer`               | Run the demo Viewer                                                       |

The root `.mcp.json` starts `apps/manifold3d-mcp/dist/manifold.mjs`. Build first.
For local plugin development, load the assembled plugin with the host's
`--plugin-dir` option or install that directory in an isolated host configuration.
Do not replace a user's installed plugin or reload their active Canvas as part
of a build.

`clean` removes temporary build output, not the committed `plugins` directories.
Generated JavaScript and copied references should change only through the build.

## Skills

Write shared geometry/API material in `skills/shared/references`. Keep the
MCP entry and workflows in `skills/use-manifold`, and the Canvas entry and
workflows in `skills/use-manifold-canvas`.

The build copies each entry and the shared references into that plugin's own
`skills` directory. Duplication in installation output is intentional: either
plugin must work without the repository or the other plugin. Shared filenames
must not collide with host-specific references.

Use ordinary Markdown and relative links within the assembled skill. There is
no macro language or conditional compiler. MCP's `get_annotations` workflow and
Canvas's Fix/Attach workflow are different and should remain explicit.

The sandbox declaration source is
`packages/modeling/src/sandbox/ambient-types.ts`. Regenerate it instead of
editing `.d.ts` copies. Add model examples under `samples/`, use the ambient
globals, and assign the final solid to the predeclared `result`.

## Plugin configuration

The MCP plugin shares `.claude-plugin/plugin.json` and `.mcp.json` between
Copilot and Claude. Its executable is relative to `${CLAUDE_PLUGIN_ROOT}`,
which both target clients expand. The configuration has no host-only
`type: "local"` or `tools` fields.

Executable location and working directory are different concerns. Copilot
starts plugin MCP servers in the installed plugin directory; Claude can use the
workspace directory. Prefer inline code in plugin tools. Explicitly set
`MANIFOLD_MCP_SCRIPT_ROOTS` to authorize other file roots; never derive an
authorization root by guessing a parent directory. Standalone MCP inherits its
caller's working directory.

The native Extension has a separate manifest, distinct skill name and no MCP
declaration. The GitHub marketplace lists both plugins; the Claude marketplace
lists only MCP.

## Version and release

The root private `package.json` version is the product version. The build
generates plugin/catalog versions and embeds it in the MCP runtime. Both
application workspaces are private.

1. Update the root product version when shipped behavior or content changes.
2. Run `npm run build:plugins` and include source, lockfile, metadata and generated
   plugin changes in the same PR.
3. Merge through the normal review process. Do not use a post-merge bot to
   patch missing generated output into main.
4. Tag that merged commit with the matching `v<version>`.

The release workflow uploads the two already-committed `.mjs` files. It does not
rebuild a different artifact, publish npm packages or update a distribution
branch. Marketplace installs use Git plugin directories, not release asset URLs.
Runtime dependencies must be embedded; the Copilot SDK alone remains external
for the Extension host.

Previously published npm versions remain available but no longer receive new
releases. Migration is an explicit plugin update/configuration change, never
an automatic uninstall or a hidden second MCP server.
