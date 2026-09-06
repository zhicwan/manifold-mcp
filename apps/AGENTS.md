# Application compositions

This guide applies to both apps, in addition to the [root guide](../AGENTS.md).
See [Architecture](../docs/architecture.md) for ownership and publication ordering.

## Keep adapters thin

- Reuse the modeling/session and Viewer Host contracts. Transport input parsing,
  source authorization, SDK integration and response formatting stay in the app.
  Do not move vendor behavior into a reusable package.
- Keep model publication hooks and post-publication presentation distinct.
  Browser detection/opening must not hold up a model commit.
- SDK/tool success must describe the effect actually completed. Do not equate
  accepting an enqueued request with completing an agent's model revision.
- Each app owns its entry/worker dispatch and external resources. Use the existing
  cancellation and close behavior instead of layering a new supervisor around it.

## Preserve each host's contract

- Live MCP and Extension stdout are protocol channels. MCP diagnostics belong
  on stderr; Extension user-facing logging uses its SDK path and must not poison delivery.
- Fix sends a bounded static snapshot in the message, without a pill.
  Attach only appends a pill. Keep these effects separate; saving a draft is
  neither operation. Do not recreate live attachment synchronization.
- Executable location is not the user's workspace. Follow the current file-source
  authorization and actual SDK capabilities; do not infer roots, expand access
  or emulate a missing capability silently.
- Do not install or reload a user's running Extension, or send a Fix message,
  as an incidental side effect of development validation.

For build/entry changes, also read [scripts/AGENTS.md](../scripts/AGENTS.md).
For behavior changes, start with [Extension integration](copilot-extension/test/extension.integration.test.ts),
[preview lifecycle](../tests/preview-lifecycle.test.ts) or
[MCP smoke](../tests/smoke.test.ts). The [Extension README](copilot-extension/README.md)
owns detailed SDK and Canvas notes.
