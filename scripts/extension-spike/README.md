# Single-file Copilot Extension feasibility spike

Run:

```sh
node scripts/extension-spike/verify.mjs
```

The verifier generates one ignored `.mjs`, copies only that file into an empty
temporary directory, and runs it with Node's filesystem permission limited to
the artifact itself. It then removes all generated output.

## Proven

- The same `.mjs` is main and `worker_threads` entry via
  `new Worker(import.meta.url, { workerData: { role: "model-worker" } })`.
  A tiny `Worker` subclass normalizes Node's string `file:` URL to the URL
  object required by the native constructor.
- The installed `manifold-3d/manifold.wasm` is embedded and supplied through
  Emscripten `wasmBinary`; `locateFile` resolves to a deliberately unreadable
  virtual URL. A cube is built in the worker and its mesh/volume stats checked.
- Three in-memory HTML/JS/CSS assets are served on `127.0.0.1` and compared
  byte-for-byte over HTTP.
- Self-test needs only Node, skips the Copilot SDK import, and closes the server
  and worker.
- Normal main mode keeps `@github/copilot-sdk/extension` dynamic and has an
  adapter boundary wiring `joinSession`/`createCanvas`.

## Not proven

Actual Copilot extension discovery, SDK session joining, Canvas rendering,
production viewer bundling, host lifecycle/reload behavior, and production
security hardening are not exercised by this spike.

The production Copilot Extension composition must pass the verified Canvas
ancestor origin through `ViewerHostOptions.frameAncestors`. If host probing
cannot establish one exact origin, it must deliberately choose and document an
explicit embedding policy; the MCP/default Viewer Host remains
`frame-ancestors 'none'`.
