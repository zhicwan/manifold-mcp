# Build and distribution scripts

Apply the [root guide](../AGENTS.md). Commands and release procedures live in
[CONTRIBUTING.md](../CONTRIBUTING.md); the source/output boundary is described in
[Architecture](../docs/architecture.md).

## One generation path

- The npm `build:plugins` command builds the apps, then invokes the assembler.
  Keep the scripts focused on the two real targets; do not create a plugin
  framework, manifest DSL or Markdown conditional compiler.
- Read metadata from authoritative source, never from the output being generated.
  The root package version drives runtime/plugin/catalog versions.
- Keep two short skill entries explicit and copy shared references into each
  plugin. Installed output must not depend on another plugin or the checkout.
- Assemble required inputs before replacing output. Report missing inputs and
  target collisions rather than silently skipping or overwriting them.
- Check mode must compare complete output without replacing committed plugins.
  The enclosing npm command still builds; do not describe it as having no side effects.
  Clean must not delete committed plugin directories.

## Standalone artifacts

- Preserve single-file Worker bootstrap, embedded resources and license notices.
  Only the Extension's host-provided SDK remains an external package at runtime.
  Do not solve missing resources with runtime downloads or path searches.
- Keep output deterministic: no local absolute paths, random data or timestamps
  introduced by generation. Do not hand-edit generated bundles to repair drift.
- Keep the cross-platform lock complete. Do not replace dependency correctness
  with CI-specific installation commands or platform-specific generated artifacts.
- Release uploads the committed runtimes; do not add a separate rebuild,
  distribution branch, version synchronizer or self-updater.

Use [assembly regressions](../tests/plugin-assembly.test.mjs),
[installed-plugin smoke](test-installed-plugin.mjs) and existing standalone/flat
checks when their contracts change. Pure repository-maintenance Markdown changes
do not require rebuilding the products; shipped skills and notices are different.
