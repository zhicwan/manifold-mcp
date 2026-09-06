import { describe, expect, it, vi } from 'vitest';

import {
  ModelingEngine,
  ModelingSession,
  ModelSubscriberError,
  type ModelArtifact,
  type PreviewRenderer,
  type RenderResult,
} from '../packages/modeling/src/modeling.js';
import { Runner, type RunnerOptions } from '../packages/modeling/src/runner/host.js';
import type { RunRequest, RunResult } from '../packages/modeling/src/runner/protocol.js';
import { addError, emptyReport } from '../packages/modeling/src/validation/report.js';

class StubRunner extends Runner {
  readonly requests: RunRequest[] = [];
  disposeCalls = 0;
  private readonly results: RunResult[];

  constructor(results: RunResult[]) {
    super();
    this.results = [...results];
  }

  override run(request: RunRequest, _options: RunnerOptions = {}): Promise<RunResult> {
    this.requests.push(request);
    const result = this.results.shift();
    if (!result) {
      return Promise.reject(new Error('StubRunner has no queued result.'));
    }
    return Promise.resolve(result);
  }

  override dispose(): Promise<void> {
    this.disposeCalls += 1;
    return Promise.resolve();
  }
}

class StubRenderer implements PreviewRenderer {
  readonly artifacts: ModelArtifact[] = [];
  disposeCalls = 0;

  renderView(model: ModelArtifact): Promise<RenderResult> {
    this.artifacts.push(model);
    return Promise.resolve({ png: Buffer.from('png'), width: 320, height: 240 });
  }

  dispose(): void {
    this.disposeCalls += 1;
  }
}

function artifact(description: string): ModelArtifact {
  return {
    description,
    numProp: 3,
    triangles: 0,
    vertices: 0,
    vertProperties: new ArrayBuffer(0),
    triVerts: new ArrayBuffer(0),
    triFeatureIds: new ArrayBuffer(0),
    features: [],
    volume: 0,
    surfaceArea: 0,
    genus: 0,
    bboxMin: [0, 0, 0],
    bboxMax: [0, 0, 0],
  };
}

function success(model: ModelArtifact): RunResult {
  return { report: emptyReport(), artifact: model };
}

function failure(): RunResult {
  const report = emptyReport('runtime');
  addError(report, { stage: 'runtime', code: 'RUNTIME_ERROR', message: 'failed' });
  return { report };
}

function createSession(results: RunResult[]): {
  session: ModelingSession;
  runner: StubRunner;
  renderer: StubRenderer;
} {
  const runner = new StubRunner(results);
  const renderer = new StubRenderer();
  const session = new ModelingSession(new ModelingEngine(runner, renderer));
  return { session, runner, renderer };
}

function deferredSignal<T>() {
  let resolvePromise: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>(resolve => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

describe('ModelingSession', () => {
  it('submits Runner work immediately so its timeout includes the session queue wait', async () => {
    const { session, runner } = createSession([success(artifact('first')), success(artifact('second'))]);
    const releaseCommit = deferredSignal<void>();
    const first = session.execute(
      { code: 'first' },
      {
        beforeCommit: () => releaseCommit.promise,
      },
    );
    await vi.waitFor(() => expect(runner.requests).toHaveLength(1));

    const second = session.validate({ code: 'second' }, { timeoutMs: 10 });
    await vi.waitFor(() => expect(runner.requests).toHaveLength(2));
    releaseCommit.resolve();

    await expect(first).resolves.toMatchObject({ report: { ok: true } });
    await expect(second).resolves.toMatchObject({ report: { ok: true } });
    await session.dispose();
  });

  it('observes eager Runner rejection until its queued turn can propagate it', async () => {
    const { session } = createSession([success(artifact('first'))]);
    const releaseCommit = deferredSignal<void>();
    const first = session.execute(
      { code: 'first' },
      {
        beforeCommit: () => releaseCommit.promise,
      },
    );
    await vi.waitFor(() => expect(session.getCurrentModel()).toBeUndefined());

    const rejected = session.validate({ code: 'missing runner result' });
    await new Promise<void>(resolve => setImmediate(resolve));
    releaseCommit.resolve();

    await expect(first).resolves.toMatchObject({ report: { ok: true } });
    await expect(rejected).rejects.toThrow('StubRunner has no queued result.');
    await session.dispose();
  });

  it('commits successful artifacts with monotonic revisions and notifies each subscriber once', async () => {
    const firstArtifact = artifact('first');
    const secondArtifact = artifact('second');
    const { session } = createSession([success(firstArtifact), success(secondArtifact)]);
    const notifications: number[] = [];
    session.subscribe(model => {
      expect(session.getCurrentModel()).toBe(model);
      notifications.push(model.revision);
    });

    const first = await session.execute({ code: 'first' });
    const second = await session.execute({ code: 'second' });

    expect(first.model).toEqual({ revision: 1, artifact: firstArtifact });
    expect(second.model).toEqual({ revision: 2, artifact: secondArtifact });
    expect(session.getCurrentModel()).toBe(second.model);
    expect(notifications).toEqual([1, 2]);
    await session.dispose();
  });

  it('preserves the current model after failed validation, execution, or pre-commit publication', async () => {
    const committed = artifact('committed');
    const rejected = artifact('rejected');
    const { session } = createSession([success(committed), failure(), failure(), success(rejected)]);
    const notifications: number[] = [];
    session.subscribe(model => {
      notifications.push(model.revision);
    });

    const first = await session.execute({ code: 'good' });
    const current = first.model;
    expect(current).toBeDefined();

    const validation = await session.validate({ code: 'invalid' });
    expect(validation.report.ok).toBe(false);
    const execution = await session.execute({ code: 'invalid' });
    expect(execution.report.ok).toBe(false);
    await expect(
      session.execute(
        { code: 'publish fails' },
        {
          beforeCommit: () => {
            throw new Error('preview publication failed');
          },
        },
      ),
    ).rejects.toThrow('preview publication failed');

    expect(session.getCurrentModel()).toBe(current);
    expect(notifications).toEqual([1]);
    await session.dispose();
  });

  it('captures the committed current model and returns undefined before one exists', async () => {
    const model = artifact('capture');
    const { session, renderer } = createSession([success(model)]);

    await expect(session.captureCurrent()).resolves.toBeUndefined();
    expect(renderer.artifacts).toEqual([]);

    await session.execute({ code: 'capture' });
    const capture = await session.captureCurrent({ width: 320, height: 240 });

    expect(capture?.model).toBe(session.getCurrentModel());
    expect(capture?.result).toEqual({ png: Buffer.from('png'), width: 320, height: 240 });
    expect(renderer.artifacts).toEqual([model]);
    await session.dispose();
  });

  it('surfaces subscriber failures after commit without rolling state back', async () => {
    const model = artifact('subscriber failure');
    const { session } = createSession([success(model)]);
    const successfulListener = vi.fn();
    session.subscribe(() => {
      throw new Error('listener failed');
    });
    session.subscribe(successfulListener);

    const execution = session.execute({ code: 'model' });
    await expect(execution).rejects.toBeInstanceOf(ModelSubscriberError);

    expect(session.getCurrentModel()?.artifact).toBe(model);
    expect(successfulListener).toHaveBeenCalledOnce();
    await session.dispose();
  });

  it('rejects session operations reentered from lifecycle callbacks instead of deadlocking', async () => {
    const first = artifact('before commit');
    const second = artifact('subscriber');
    const { session } = createSession([success(first), success(second)]);

    await expect(
      session.execute(
        { code: 'before commit' },
        {
          beforeCommit: async () => {
            await session.validate({ code: 'reentrant validation' });
          },
        },
      ),
    ).rejects.toThrow(/cannot be called from a beforeCommit callback/);
    expect(session.getCurrentModel()).toBeUndefined();

    session.subscribe(async () => {
      await session.captureCurrent();
    });
    await expect(session.execute({ code: 'subscriber' })).rejects.toBeInstanceOf(ModelSubscriberError);
    expect(session.getCurrentModel()?.artifact).toBe(second);

    await session.dispose();
  });

  it('rejects disposal reentered from lifecycle callbacks instead of deadlocking', async () => {
    const beforeCommit = createSession([success(artifact('before commit'))]);
    await expect(
      beforeCommit.session.execute(
        { code: 'before commit' },
        {
          beforeCommit: async () => {
            await beforeCommit.session.dispose();
          },
        },
      ),
    ).rejects.toThrow(/cannot be disposed from a beforeCommit callback/);
    await beforeCommit.session.dispose();

    const captureOptions = createSession([success(artifact('capture'))]);
    await captureOptions.session.execute({ code: 'capture' });
    await expect(
      captureOptions.session.captureCurrent(async () => {
        await captureOptions.session.dispose();
        return {};
      }),
    ).rejects.toThrow(/cannot be disposed from a captureOptions callback/);
    await captureOptions.session.dispose();

    const subscriber = createSession([success(artifact('subscriber'))]);
    subscriber.session.subscribe(async () => {
      await subscriber.session.dispose();
    });
    await expect(subscriber.session.execute({ code: 'subscriber' })).rejects.toBeInstanceOf(ModelSubscriberError);
    await subscriber.session.dispose();
  });

  it('allows deferred callback work after the originating callback has settled', async () => {
    const model = artifact('deferred callback');
    const { session } = createSession([success(model), { report: emptyReport() }]);
    let resolveDeferred!: (operation: Promise<unknown>) => void;
    const deferred = new Promise<unknown>((resolve, reject) => {
      resolveDeferred = operation => {
        operation.then(resolve, reject);
      };
    });

    await session.execute(
      { code: 'model' },
      {
        beforeCommit: () => {
          setImmediate(() => resolveDeferred(session.validate({ code: 'deferred validation' })));
        },
      },
    );

    await expect(deferred).resolves.toEqual({ report: emptyReport() });
    await session.dispose();
  });

  it('resolves capture options against the model selected inside the session queue', async () => {
    const model = artifact('queued capture');
    const { session, renderer } = createSession([success(model)]);
    const execution = session.execute({ code: 'queued model' });
    const capture = session.captureCurrent(committed => ({
      width: committed.revision * 320,
      height: 240,
    }));

    await execution;
    await expect(capture).resolves.toEqual({
      model: session.getCurrentModel(),
      result: { png: Buffer.from('png'), width: 320, height: 240 },
    });
    expect(renderer.artifacts).toEqual([model]);
    await session.dispose();
  });

  it('queues unrelated concurrent work while a lifecycle callback is active', async () => {
    const model = artifact('concurrent callback');
    const { session } = createSession([success(model), { report: emptyReport() }]);
    let releaseCommit!: () => void;
    let markEntered!: () => void;
    const entered = new Promise<void>(resolve => {
      markEntered = resolve;
    });
    const holdCommit = new Promise<void>(resolve => {
      releaseCommit = resolve;
    });

    const execution = session.execute(
      { code: 'model' },
      {
        beforeCommit: async () => {
          markEntered();
          await holdCommit;
        },
      },
    );
    await entered;
    const validation = session.validate({ code: 'independent validation' });
    let validationSettled = false;
    void validation.finally(() => {
      validationSettled = true;
    });
    await Promise.resolve();
    expect(validationSettled).toBe(false);

    releaseCommit();
    await execution;
    await expect(validation).resolves.toEqual({ report: emptyReport() });
    await session.dispose();
  });

  it('disposes the engine, runner, and renderer idempotently', async () => {
    const { session, runner, renderer } = createSession([]);

    const first = session.dispose();
    const second = session.dispose();

    expect(second).toBe(first);
    await first;
    expect(runner.disposeCalls).toBe(1);
    expect(renderer.disposeCalls).toBe(1);
    await expect(session.validate({ code: 'after dispose' })).rejects.toThrow('disposed');
  });
});
