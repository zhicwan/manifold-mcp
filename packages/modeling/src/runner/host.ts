/**
 * Host-side runner: each Runner instance serializes its own requests, creates
 * one disposable Worker per request, enforces an end-to-end timeout, and
 * returns a Report (plus an optional model artifact) only after that Worker has exited.
 *
 * Concurrency model: a 1-slot queue per Runner. Calls made through one
 * instance never overlap, while independent Runner instances can execute
 * independently.
 *
 * Lifecycle:
 *   * Every run() spawns a fresh Worker, waits for its `{ ready: true }`
 *     handshake within the caller's deadline, and posts the request with
 *     only the remaining budget.
 *   * Any result message triggers immediate termination. The result is not
 *     resolved until the Worker has fully exited, so Promise microtasks or
 *     timers scheduled by user code cannot outlive the request.
 *   * This intentionally pays the Manifold WASM bootstrap cost per request
 *     in exchange for never reusing a user-reachable realm.
 *
 * Lifecycle (RUN-1: race-triad fix retained):
 *   The Worker emits up to three lifecycle events per request — `error`
 *   (uncaught throw or fatal allocator condition), `message` (the worker
 *   posted a RunResult), and `exit` (the thread tore down). We treat
 *   `error`/`message` as informational (capture into closures) and settle
 *   from `exit` OR from receiving the result `message`. Result settlement
 *   terminates the worker and awaits `exit`, so the queue chain cannot
 *   overlap two live WASM heaps.
 */
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { addError, emptyReport } from '../validation/report.js';
import { MILLIMETRES_HINT, type RunRequest, type RunResult } from './protocol.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = join(HERE, 'worker.js');

/** Surfaced in script-conventions.md and validation-report.md — keep docs in sync. */
export const DEFAULT_TIMEOUT_MS = 5000;
/** Surfaced in script-conventions.md and validation-report.md — keep docs in sync. */
export const MAX_OLD_GEN_MB = 512;
export interface RunnerOptions {
  /** End-to-end budget covering queue wait, worker bootstrap, and execution. */
  timeoutMs?: number;
  /**
   * Override the per-worker old-generation soft cap (MB). Tests use a
   * tiny value (e.g. 16) to deterministically exercise the OUT_OF_MEMORY
   * path without relying on system-level memory pressure. Production
   * callers should leave this unset and inherit MAX_OLD_GEN_MB.
   *
   * Every request uses a fresh Worker because `resourceLimits` are
   * immutable and user realms are never reused.
   */
  maxOldGenMb?: number;
}

export interface RunnerConstructionOptions {
  /**
   * Worker module to spawn. Defaults to the built sibling worker.js used by
   * the MCP package. A single-file host may pass import.meta.url instead.
   */
  workerFilename?: string | URL;
  /** Structured-cloneable role/bootstrap data supplied to every worker. */
  workerData?: unknown;
}

interface RequestWorker {
  worker: Worker;
  /**
   * Resolves once the Worker has finished bootstrapping (WASM init +
   * sandbox scrub). All callers MUST await this before `postMessage`.
   */
  ready: Promise<void>;
  threadId: number;
  /** Old-gen cap this worker was spawned with. */
  maxOldGenMb: number;
  /**
   * Latest worker-level error captured before `exit`. Used by the
   * race-triad: a `message` arriving before `exit` settles cleanly; an
   * `exit` without a prior `message` consults this to map crashes /
   * OOMs into the right RunResult.
   */
  pendingError?: NodeJS.ErrnoException;
  /** Set once exit fires; latches further postMessage attempts to fail. */
  exited: boolean;
  /**
   * Set when the host has decided this request worker is being retired.
   * Late `message` events on a dismissed worker must be ignored.
   */
  dismissed: boolean;
  /** Resolved when this worker has fully exited. */
  exitPromise: Promise<void>;
  /** Shared idempotent dismissal promise. */
  dismissPromise?: Promise<void>;
}

const activeThreadIds = new WeakMap<Runner, number>();
const lastThreadIds = new WeakMap<Runner, number>();

export class Runner {
  private queue: Promise<void> = Promise.resolve();
  private activeWorker: RequestWorker | undefined;
  private seenMillimetresHint = false;
  private disposed = false;
  private disposePromise: Promise<void> | undefined;
  private readonly workerFilename: string | URL;
  private readonly workerData: unknown;

  constructor(options: RunnerConstructionOptions = {}) {
    this.workerFilename = options.workerFilename ?? WORKER_PATH;
    this.workerData = options.workerData;
  }

  /** Run a script in a fresh disposable worker. Safe to call concurrently. */
  run(req: RunRequest, opts: RunnerOptions = {}): Promise<RunResult> {
    if (this.disposed) {
      return Promise.reject(new Error('Runner has been disposed.'));
    }
    const timeoutMs = normalizeTimeout(opts.timeoutMs);
    const deadline = performance.now() + timeoutMs;
    const next = this.queue.then(() => this.runOnce(req, opts, deadline, timeoutMs));
    // Keep the chain alive even if a single run rejects.
    this.queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  /** Permanently tear down this Runner. Repeated calls share the same promise. */
  dispose(): Promise<void> {
    if (this.disposePromise) {
      return this.disposePromise;
    }
    this.disposed = true;
    this.disposePromise = this.queue.then(async () => {
      if (this.activeWorker) {
        await this.dismissWorker(this.activeWorker);
      }
    });
    this.queue = this.disposePromise.then(
      () => undefined,
      () => undefined,
    );
    return this.disposePromise;
  }

  private async runOnce(req: RunRequest, opts: RunnerOptions, deadline: number, timeoutMs: number): Promise<RunResult> {
    const maxOldGenMb = opts.maxOldGenMb ?? MAX_OLD_GEN_MB;

    if (remainingBudget(deadline) <= 0) {
      return timeoutResult(timeoutMs);
    }

    const active = this.spawnWorker(maxOldGenMb);
    this.activeWorker = active;
    activeThreadIds.set(this, active.threadId);
    lastThreadIds.set(this, active.threadId);

    const ready = await waitForReady(active, remainingBudget(deadline));
    if (ready.status === 'timeout') {
      await this.dismissWorker(active);
      return timeoutResult(timeoutMs);
    }
    if (ready.status === 'error') {
      // Bootstrap failed — surface as crash after retiring this worker.
      await this.dismissWorker(active);
      return crashResult(ready.error, maxOldGenMb);
    }

    const executionBudget = remainingBudget(deadline);
    if (executionBudget <= 0) {
      await this.dismissWorker(active);
      return timeoutResult(timeoutMs);
    }

    return new Promise<RunResult>((resolve, reject) => {
      let settling = false;
      let pendingMessage: RunResult | undefined;

      const settle = (result: RunResult, dismiss: boolean): void => {
        if (settling) {
          return;
        }
        settling = true;
        clearTimeout(timer);
        active.worker.off('message', onMessage);
        active.worker.off('error', onError);
        active.worker.off('exit', onExit);
        void (async () => {
          if (dismiss) {
            // Do not resolve until the user realm has fully exited.
            await this.dismissWorker(active);
          }
          resolve(this.filterSessionHints(result));
        })().catch(reject);
      };

      const onMessage = (msg: unknown): void => {
        // Ignore the bootstrap handshake; only RunResult settles a request.
        if (isReadyMessage(msg) || active.dismissed) {
          return;
        }
        pendingMessage = msg as RunResult;
        settle(pendingMessage, true);
      };

      const onError = (err: NodeJS.ErrnoException): void => {
        active.pendingError = err;
        // Worker errored mid-run — let the exit handler decide OOM vs crash.
      };

      const onExit = (code: number): void => {
        // The result path removes this listener before terminating, so an
        // observed exit here means the worker died before returning a result.
        if (pendingMessage !== undefined) {
          return;
        }
        const errMsg = active.pendingError?.message?.toLowerCase() ?? '';
        const isOomError =
          active.pendingError?.code === 'ERR_WORKER_OUT_OF_MEMORY' ||
          errMsg.includes('out of memory') ||
          errMsg.includes('oom') ||
          errMsg.includes('allocation failed');
        const isOomExitCode = code === 134 || code === 7 || code === 17;
        const r = emptyReport('runtime');
        if (isOomError || isOomExitCode) {
          addError(r, {
            stage: 'runtime',
            code: 'OUT_OF_MEMORY',
            message: `Worker exceeded the ${active.maxOldGenMb} MB old-generation soft cap (exit ${code}${
              active.pendingError ? `; ${active.pendingError.code ?? active.pendingError.name}` : ''
            }).`,
          });
        } else {
          addError(r, {
            stage: 'runtime',
            code: 'WORKER_CRASH',
            message: active.pendingError
              ? `Worker crashed: ${active.pendingError.message}`
              : `Worker exited unexpectedly with code ${code}.`,
          });
        }
        active.dismissed = true;
        settle({ report: r }, false);
      };

      const timer = setTimeout(() => settle(timeoutResult(timeoutMs), true), executionBudget);

      active.worker.on('message', onMessage);
      active.worker.once('error', onError);
      active.worker.once('exit', onExit);

      if (active.exited || active.dismissed) {
        // Worker died between `await ready` and installing the request
        // listeners. The permanent exit listener has already cleared it.
        const r = emptyReport('runtime');
        addError(r, {
          stage: 'runtime',
          code: 'WORKER_CRASH',
          message: 'Request worker exited before the request could be posted.',
        });
        settle({ report: r }, true);
        return;
      }

      try {
        active.worker.postMessage(req);
      } catch (err) {
        settle(crashResult(err, maxOldGenMb), true);
      }
    });
  }

  private filterSessionHints(result: RunResult): RunResult {
    if (!result.report.ok || !result.report.hints.includes(MILLIMETRES_HINT)) {
      return result;
    }
    if (this.seenMillimetresHint) {
      result.report.hints = result.report.hints.filter(hint => hint !== MILLIMETRES_HINT);
    } else {
      this.seenMillimetresHint = true;
    }
    return result;
  }

  private spawnWorker(maxOldGenMb: number): RequestWorker {
    const workerFilename =
      typeof this.workerFilename === 'string' && this.workerFilename.startsWith('file:')
        ? new URL(this.workerFilename)
        : this.workerFilename;
    const worker = new Worker(workerFilename, {
      resourceLimits: {
        maxOldGenerationSizeMb: maxOldGenMb,
      },
      stderr: false,
      stdout: false,
      ...(this.workerData !== undefined ? { workerData: this.workerData } : {}),
    });
    let resolveExit!: () => void;
    const exitPromise = new Promise<void>(resolve => {
      resolveExit = resolve;
    });
    const wrapper: RequestWorker = {
      worker,
      threadId: worker.threadId,
      maxOldGenMb,
      exited: false,
      dismissed: false,
      exitPromise,
      ready: Promise.resolve(), // placeholder, replaced below
    };
    worker.on('error', err => {
      wrapper.pendingError = err as NodeJS.ErrnoException;
      // This listener is permanent. Request/bootstrap listeners are
      // intentionally short-lived, but a late worker error must never become
      // an unhandled EventEmitter 'error' in the host process.
      void this.dismissWorker(wrapper).catch(() => undefined);
    });
    worker.once('exit', () => {
      wrapper.exited = true;
      if (this.activeWorker === wrapper) {
        this.activeWorker = undefined;
      }
      if (activeThreadIds.get(this) === wrapper.threadId) {
        activeThreadIds.delete(this);
      }
      resolveExit();
    });

    wrapper.ready = new Promise<void>((resolve, reject) => {
      let settled = false;
      const cleanup = (): void => {
        worker.off('message', onReady);
        worker.off('error', onBootstrapError);
        worker.off('exit', onBootstrapExit);
      };
      const onReady = (msg: unknown): void => {
        if (!settled && isReadyMessage(msg)) {
          settled = true;
          cleanup();
          resolve();
        }
      };
      const onBootstrapError = (err: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        wrapper.pendingError = err as NodeJS.ErrnoException;
        cleanup();
        reject(err);
      };
      const onBootstrapExit = (code: number): void => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(new Error(`Worker exited during bootstrap with code ${code}`));
      };
      worker.on('message', onReady);
      worker.once('error', onBootstrapError);
      worker.once('exit', onBootstrapExit);
    });

    return wrapper;
  }

  private dismissWorker(active: RequestWorker): Promise<void> {
    if (this.activeWorker === active) {
      this.activeWorker = undefined;
    }
    if (activeThreadIds.get(this) === active.threadId) {
      activeThreadIds.delete(this);
    }
    if (active.dismissPromise) {
      return active.dismissPromise;
    }
    active.dismissed = true;
    active.dismissPromise = (async () => {
      if (!active.exited) {
        await active.worker.terminate();
      }
      // Wait for exit to fully fire so the next spawn cannot race.
      await active.exitPromise;
    })();
    return active.dismissPromise;
  }
}

/** Test hook: active request thread, cleared before run() resolves. */
export function _currentThreadId(runner: Runner): number | undefined {
  return activeThreadIds.get(runner);
}

/** Test hook: most recently spawned request thread. */
export function _lastThreadId(runner: Runner): number | undefined {
  return lastThreadIds.get(runner);
}

function isReadyMessage(msg: unknown): boolean {
  return typeof msg === 'object' && msg !== null && (msg as { ready?: unknown }).ready === true;
}

type ReadyOutcome = { status: 'ready' } | { status: 'timeout' } | { status: 'error'; error: unknown };

function waitForReady(active: RequestWorker, budgetMs: number): Promise<ReadyOutcome> {
  if (budgetMs <= 0) {
    return Promise.resolve({ status: 'timeout' });
  }

  return new Promise(resolve => {
    let settled = false;
    const finish = (outcome: ReadyOutcome): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ status: 'timeout' }), budgetMs);
    active.ready.then(
      () => finish({ status: 'ready' }),
      error => finish({ status: 'error', error }),
    );
  });
}

function normalizeTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs)) {
    return DEFAULT_TIMEOUT_MS;
  }
  return Math.max(0, timeoutMs);
}

function remainingBudget(deadline: number): number {
  return Math.max(0, deadline - performance.now());
}

function timeoutResult(timeoutMs: number): RunResult {
  const report = emptyReport('runtime');
  addError(report, {
    stage: 'runtime',
    code: 'TIMEOUT',
    message: `Modeling run exceeded ${timeoutMs} ms including queue wait, worker bootstrap, and script execution.`,
  });
  report.durationMs = timeoutMs;
  return { report };
}

function crashResult(err: unknown, maxOldGenMb: number): RunResult {
  const r = emptyReport('runtime');
  const message = err instanceof Error ? err.message : String(err);
  // Heuristic: bootstrap-time failures dominated by OOM use the same
  // signal the in-run path uses. (RunnerOptions.maxOldGenMb is named
  // for callers; it is the soft cap, not a hard ceiling.)
  const lower = message.toLowerCase();
  if (
    lower.includes('out of memory') ||
    lower.includes('oom') ||
    lower.includes('allocation failed') ||
    (err as NodeJS.ErrnoException | undefined)?.code === 'ERR_WORKER_OUT_OF_MEMORY'
  ) {
    addError(r, {
      stage: 'runtime',
      code: 'OUT_OF_MEMORY',
      message: `Worker bootstrap exceeded the ${maxOldGenMb} MB old-generation soft cap.`,
    });
  } else {
    addError(r, {
      stage: 'runtime',
      code: 'WORKER_CRASH',
      message: `Worker bootstrap failed: ${message}`,
    });
  }
  return { report: r };
}
