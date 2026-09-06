type Cleanup = () => void | Promise<void>;
type SynchronousCleanup = () => void;

interface ContributionEntry {
  dispose: Cleanup;
  promise: Promise<void> | null;
}

export interface ViewerSceneCleanupRegistry {
  register(dispose: Cleanup): () => Promise<void>;
  disposeAll(): Promise<void>;
}

export interface ViewerGenerationCleanupPlan {
  stop(): void;
  readonly beforeContributions: readonly SynchronousCleanup[];
  disposeContributions(): void | Promise<void>;
  readonly afterContributions: readonly Cleanup[];
}

export function createViewerSceneCleanupRegistry(): ViewerSceneCleanupRegistry {
  const entries = new Set<ContributionEntry>();

  const start = (entry: ContributionEntry): Promise<void> => {
    entry.promise ??= Promise.resolve()
      .then(() => entry.dispose())
      .finally(() => entries.delete(entry));
    return entry.promise;
  };

  return {
    register(dispose: Cleanup): () => Promise<void> {
      const entry: ContributionEntry = { dispose, promise: null };
      entries.add(entry);
      return () => start(entry);
    },
    async disposeAll(): Promise<void> {
      const results = await Promise.allSettled([...entries].map(start));
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
      if (failures.length > 0) {
        throw new AggregateError(
          failures.map(failure => failure.reason),
          'One or more Viewer scene contributions failed to dispose.',
        );
      }
    },
  };
}

export function createViewerGenerationDisposer(plan: ViewerGenerationCleanupPlan): () => Promise<void> {
  let disposePromise: Promise<void> | null = null;

  return () => {
    if (disposePromise) {
      return disposePromise;
    }

    const failures: unknown[] = [];
    attemptSync(plan.stop, failures);
    for (const cleanup of plan.beforeContributions) {
      attemptSync(cleanup, failures);
    }

    disposePromise = (async () => {
      await attemptAsync(plan.disposeContributions, failures);
      for (const cleanup of plan.afterContributions) {
        await attemptAsync(cleanup, failures);
      }
      if (failures.length > 0) {
        throw new AggregateError(failures, 'Viewer generation cleanup failed.');
      }
    })();
    return disposePromise;
  };
}

function attemptSync(cleanup: SynchronousCleanup, failures: unknown[]): void {
  try {
    cleanup();
  } catch (error) {
    failures.push(error);
  }
}

async function attemptAsync(cleanup: Cleanup, failures: unknown[]): Promise<void> {
  try {
    await cleanup();
  } catch (error) {
    failures.push(error);
  }
}
