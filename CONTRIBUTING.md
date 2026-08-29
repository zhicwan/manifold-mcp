# Contributing to manifold3d-mcp

Thank you for your interest in contributing!

## Prerequisites

- [Node.js](https://nodejs.org/) >= 24
- npm (ships with Node.js)

## Getting started

```bash
git clone https://github.com/zhicwan/manifold3d-mcp.git
cd manifold3d-mcp
npm ci
```

## Local plugin development

Plugin files live under `plugin/`. The repo-root `.mcp.json` points the
`manifold3d-mcp` MCP server at your local
`packages/manifold3d-mcp/dist/server/index.js`, so after building your changes
are picked up automatically:

```bash
npm run build
```

The repo ships two `.mcp.json` files with the same server name (`manifold3d-mcp`):

| File               | Command                                             | Purpose                                 |
| ------------------ | --------------------------------------------------- | --------------------------------------- |
| `.mcp.json` (root) | `node packages/manifold3d-mcp/dist/server/index.js` | Local development against your build    |
| `plugin/.mcp.json` | `npx -y @zhicwan/manifold3d-mcp@1.0.x`              | Published package for end-user installs |

When working from the repo root the local config takes precedence, so your
changes are picked up automatically after `npm run build`.

To test the published plugin experience (via `npx`), install from outside the
repo checkout:

```bash
# Copilot CLI
/plugin install zhicwan/manifold3d-mcp:plugin

# Claude Code
claude --plugin-dir /path/to/manifold3d-mcp/plugin
```

> **Note:** workspace `dist/` directories are git-ignored. You must run
> `npm run build` at least once before the root `.mcp.json` can start the local
> MCP server.

## Scripts

| Command                          | Description                                          |
| -------------------------------- | ---------------------------------------------------- |
| `npm run build`                  | Full build (viewer + server + sandbox types)         |
| `npm run build:extension`        | Build the single-file Copilot CLI Extension          |
| `npm run test:extension`         | Run Extension composition and attachment tests       |
| `npm run verify:extension`       | Build, test, inspect, and self-test the Extension    |
| `npm run extension:install`      | Build and copy the Extension into local discovery    |
| `npm run verify:viewer-flat`     | Build and verify the optional-XR Viewer boundary     |
| `npm run plugin:build`           | Alias for the full build before local plugin testing |
| `npm run plugin:copilot:install` | Build, then install `./plugin` into Copilot CLI      |
| `npm run typecheck`              | TypeScript type checking (all projects)              |
| `npm run lint`                   | ESLint                                               |
| `npm run lint:fix`               | ESLint with auto-fix                                 |
| `npm run format`                 | Prettier formatting                                  |
| `npm run format:check`           | Prettier check (CI)                                  |
| `npm test`                       | Build, then run the full unit + smoke suite          |
| `npm run test:unit`              | Build, then run all non-smoke tests                  |
| `npm run test:smoke`             | Smoke tests (builds first)                           |
| `npm run test:watch`             | Build, then run non-smoke tests in watch mode        |

The default Viewer entry explicitly composes `@manifold3d/viewer/xr`. The
`@manifold3d/viewer/flat` subpath and flat Vite entry use the same Viewer shell
without importing or enabling the optional immersive implementation.

The private `apps/copilot-extension` workspace produces one self-contained
Copilot CLI discovery file and is intentionally excluded from the public MCP
tarball. Its Canvas API and extension-only framing exception are experimental;
review the security and manual host verification notes in
`apps/copilot-extension/README.md` before changing that composition.

## Adding a sample

1. Create a new `.ts` file in `samples/` following the existing naming
   convention (`NN-descriptive-name.ts`).
2. Use the ambient types from `samples/manifold-sandbox.d.ts`.
3. Assign the final `Manifold` to a variable named `result`.

## Updating sandbox types

If you change the sandbox API surface, regenerate the ambient declarations:

```bash
npm run build:sandbox-types
```

This updates `samples/manifold-sandbox.d.ts` and
`plugin/skills/use-manifold/references/manifold-sandbox.d.ts`.

## Branch and PR workflow

1. Branch from `main`.
2. Make your changes and ensure all checks pass:

   ```bash
   npm run format:check && npm run lint && npm run typecheck && npm test
   ```

3. Open a pull request. Squash merge only; all CI checks must pass.

## Releasing / Publishing

The public workspace package (`packages/manifold3d-mcp/package.json`), plugin
manifests, and `plugin/.mcp.json` range move in lockstep. Private internal
workspaces stay at `0.0.0-private` and are never published. Use this semver
convention:

- Patch: bug fixes only, with no MCP tool additions or behavior changes. The
  plugin launches `@zhicwan/manifold3d-mcp@1.0.x`, so compatible patch releases
  are picked up automatically.
- Minor: any new or changed MCP tool. Update the skill docs, bump all package
  and plugin manifest versions, and raise the `plugin/.mcp.json` range in the
  same change.
- Major: breaking changes.

Release steps (works with `main` branch protection):

1. Create a release branch and bump the version **without** tagging. The npm
   public workspace's `version` lifecycle script
   (`scripts/sync-versions.mjs`) propagates the new version to every
   plugin/marketplace manifest and repins the `plugin/.mcp.json` `@x.y.x`
   range, staging them:

   ```bash
   git checkout -b release/v1.0.1
   npm version patch --workspace @zhicwan/manifold3d-mcp --no-git-tag-version
   git commit -am "release: v1.0.1"
   git push -u origin release/v1.0.1
   ```

2. Open a PR and merge it (CI runs `npm run check:sync`, which now passes
   because every manifest moved in lockstep).

3. Tag the **merged** commit on `main` and push the tag — this triggers the
   publish workflow:

   ```bash
   git checkout main && git pull
   git tag v1.0.1
   git push origin v1.0.1
   ```

`.github/workflows/cd.yml` then verifies the tag matches
`packages/manifold3d-mcp/package.json`, runs `check:sync`, and publishes that
workspace through npm OIDC Trusted Publishing (provenance is generated
automatically; no token is used).

> Do not `git push --follow-tags` straight to `main` — branch protection
> rejects the direct push, which can leave the tag pushed without the version
> commit on `main`.

### First publish (one-time bootstrap)

npm cannot register a Trusted Publisher for a package that does not exist yet,
so the **first** publish must be done manually by a maintainer:

```bash
npm publish --workspace @zhicwan/manifold3d-mcp
```

Then register this repository and the `cd.yml` workflow as a Trusted Publisher
on the package access page so all later releases publish via OIDC:
https://www.npmjs.com/package/@zhicwan/manifold3d-mcp/access

Note: this first manual publish does **not** carry OIDC provenance; every
CI-published release afterwards does.

CI runs `npm run check:sync` (`scripts/check-sync.mjs`) to prevent version drift
and ensure the skill's documented tools match the MCP server's registered tools.

### Consuming the published package

The plugin's `plugin/.mcp.json` launches `@zhicwan/manifold3d-mcp@1.0.x`, so
`npx` resolves the latest in-range **patch** on every server start. Two
implications for users:

- A network round-trip to the npm registry happens on each launch; if the
  registry is unreachable and no compatible version is cached, startup fails.
- A new **major** (e.g. `2.0.0`) is intentionally **not** auto-pulled — users
  must update/reinstall the plugin (which raises the range) to move major
  versions.
