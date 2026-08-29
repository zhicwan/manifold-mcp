# manifold3d-mcp

<!-- TODO: uncomment badges after first publish
[![CI](https://github.com/zhicwan/manifold3d-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/zhicwan/manifold3d-mcp/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@zhicwan/manifold3d-mcp)](https://www.npmjs.com/package/@zhicwan/manifold3d-mcp)
-->

[![License: Apache-2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
![Node.js >= 24](https://img.shields.io/badge/Node.js-%E2%89%A5%2024-green)
[![Ask DeepWiki](https://deepwiki.com/badge.svg)](https://deepwiki.com/zhicwan/manifold3d-mcp)

An MCP server and plugin that lets an LLM design 3D-printable models with
[manifold-3d](https://github.com/elalish/manifold), validate the generated
TypeScript, and preview/export STL or 3MF in the browser.

## Easy install

```text
/plugin marketplace add zhicwan/manifold3d-mcp
/plugin install manifold@manifold3d-mcp
```

## Contribute setup

```bash
git clone https://github.com/zhicwan/manifold3d-mcp.git
cd manifold3d-mcp
npm install
npm run build
npm test
```

After building, the repo-root `.mcp.json` runs the local MCP server from
`packages/manifold3d-mcp/dist/server/index.js`, and `.github/skills/` points to
`plugin/skills/` for local skill discovery.

The npm workspace is split into private protocol, modeling, viewer, and
viewer-host packages, a private production Copilot CLI Extension app, and the
public `@zhicwan/manifold3d-mcp` CLI package.
The default browser Viewer composes its tree-shakeable `@manifold3d/viewer/xr`
subpath, while `@manifold3d/viewer/flat` remains free of immersive code.

The optional Copilot CLI Extension builds to one self-contained
`apps/copilot-extension/dist/extension.mjs`. See
[`apps/copilot-extension/README.md`](apps/copilot-extension/README.md) for its
build, verification, local install, and experimental Canvas embedding policy.

See [CONTRIBUTING.md](CONTRIBUTING.md) for scripts, local plugin development,
branch workflow, and sample authoring.

## License

[Apache License 2.0](LICENSE) — Copyright 2026 Zhicheng Wang.

See [NOTICE](NOTICE) for upstream attribution.

### Upstream

This project uses and adapts portions of
[elalish/manifold](https://github.com/elalish/manifold) (Apache-2.0):

- `packages/modeling/src/sandbox/garbage-collector.ts`
- Documentation under `plugin/skills/use-manifold/references/`
