type ContributionDisposer = () => void | Promise<void>;

interface ContributionEntry {
  dispose: ContributionDisposer;
  promise: Promise<void> | null;
}

export interface ViewerSceneCleanupRegistry {
  register(dispose: ContributionDisposer): () => Promise<void>;
  disposeAll(): Promise<void>;
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
    register(dispose: ContributionDisposer): () => Promise<void> {
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
