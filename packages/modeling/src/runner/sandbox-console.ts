/**
 * Per-run sandbox `console` factory.
 *
 * User snippets get a `console` global that forwards to the worker's
 * stderr (host stdout is reserved for the MCP JSON-RPC stream, so we
 * route everything else to stderr). The factory takes a `stderrWrite`
 * function captured at module load — the runner worker passes
 * `process.stderr.write.bind(process.stderr)` BEFORE the SEC-1 sandbox
 * scrub deletes `process` from `globalThis`. After the scrub, user
 * code cannot reach `process.stderr` directly.
 */

export type StderrWrite = (chunk: string) => unknown;

export type SandboxConsole = Pick<Console, 'log' | 'warn' | 'error' | 'info'>;

/**
 * Build a frozen sandbox `console` whose methods write to `stderrWrite`.
 * Each call is prefixed with `[script:<level>]` so console output from
 * snippets is easy to filter from the host's own logs.
 */
export function createSandboxConsole(stderrWrite: StderrWrite): SandboxConsole {
  const out =
    (level: string) =>
    (...parts: unknown[]): void => {
      stderrWrite(`[script:${level}] ${parts.map(String).join(' ')}\n`);
    };
  return {
    log: out('log'),
    info: out('info'),
    warn: out('warn'),
    error: out('error'),
  } as SandboxConsole;
}
