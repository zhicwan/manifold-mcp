import { AsyncLocalStorage } from 'node:async_hooks';

import { createRenderer, type PreviewRenderer, type RenderResult, type RenderViewOptions } from './preview/renderer.js';
import { Runner, type RunnerOptions } from './runner/host.js';
import type { ModelArtifact } from './runner/protocol.js';
import type { Report } from './validation/report.js';

export interface ValidateModelInput {
  code: string;
  suppressSnippet?: boolean;
}

export interface ExecuteModelInput extends ValidateModelInput {
  description?: string;
}

export interface ValidationResult {
  report: Report;
}

export interface ExecutionResult {
  report: Report;
  artifact?: ModelArtifact;
}

export interface CaptureModelInput {
  artifact: ModelArtifact;
  options?: RenderViewOptions;
}

export interface CommittedModel {
  /** Monotonically increasing within one ModelingSession. */
  revision: number;
  artifact: ModelArtifact;
}

export interface SessionExecutionResult extends ExecutionResult {
  model?: CommittedModel;
}

export type ModelSubscriber = (model: CommittedModel) => void | Promise<void>;
export type BeforeModelCommit = (model: CommittedModel) => void | Promise<void>;

export interface SessionExecuteOptions extends RunnerOptions {
  /**
   * Runs after successful execution but before the session model changes.
   * A rejection aborts the commit, which lets transports publish atomically.
   * The callback must not wait for external code that calls this same session.
   */
  beforeCommit?: BeforeModelCommit;
}

export interface CurrentModelCapture {
  model: CommittedModel;
  result: RenderResult;
}

export type CaptureOptionsResolver = (model: CommittedModel) => RenderViewOptions | Promise<RenderViewOptions>;

/**
 * A subscriber failure is reported after the model has committed. All
 * subscribers are attempted exactly once, and the committed state is retained.
 */
export class ModelSubscriberError extends AggregateError {
  readonly model: CommittedModel;
  readonly result: SessionExecutionResult;

  constructor(errors: readonly unknown[], model: CommittedModel, result: SessionExecutionResult) {
    super(errors, `One or more model subscribers failed for revision ${model.revision}.`);
    this.name = 'ModelSubscriberError';
    this.model = model;
    this.result = result;
  }
}

/** Transport-neutral execution and capture services. */
export class ModelingEngine {
  private readonly runner: Runner;
  private readonly renderer: PreviewRenderer;
  private disposed = false;
  private disposePromise: Promise<void> | undefined;

  constructor(runner: Runner = new Runner(), renderer: PreviewRenderer = createRenderer()) {
    this.runner = runner;
    this.renderer = renderer;
  }

  async validate(input: ValidateModelInput, options: RunnerOptions = {}): Promise<ValidationResult> {
    this.assertActive();
    const { report } = await this.runner.run(
      {
        mode: 'validate',
        code: input.code,
        ...(input.suppressSnippet !== undefined ? { suppressSnippet: input.suppressSnippet } : {}),
      },
      options,
    );
    return { report };
  }

  async execute(input: ExecuteModelInput, options: RunnerOptions = {}): Promise<ExecutionResult> {
    this.assertActive();
    const { report, artifact } = await this.runner.run(
      {
        mode: 'execute',
        code: input.code,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.suppressSnippet !== undefined ? { suppressSnippet: input.suppressSnippet } : {}),
      },
      options,
    );
    return artifact ? { report, artifact } : { report };
  }

  async capture(input: CaptureModelInput): Promise<RenderResult> {
    this.assertActive();
    return this.renderer.renderView(input.artifact, input.options);
  }

  /** Idempotently dispose the owned runner and renderer, surfacing all failures. */
  dispose(): Promise<void> {
    if (this.disposePromise) {
      return this.disposePromise;
    }
    this.disposed = true;
    this.disposePromise = (async () => {
      const settled = await Promise.allSettled([
        Promise.resolve().then(() => this.runner.dispose()),
        Promise.resolve().then(() => this.renderer.dispose()),
      ]);
      const errors = settled
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map(result => result.reason as unknown);
      if (errors.length > 0) {
        throw new AggregateError(errors, 'Failed to dispose the modeling engine.');
      }
    })();
    return this.disposePromise;
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error('ModelingEngine has been disposed.');
    }
  }
}

interface PendingNotification {
  model: CommittedModel;
  result: SessionExecutionResult;
  listeners: ModelSubscriber[];
}

interface ScheduledExecution {
  result: SessionExecutionResult;
  notification?: Promise<void>;
}

interface CallbackToken {
  active: boolean;
  kind: 'beforeCommit' | 'captureOptions' | 'subscriber';
}

/**
 * Stateful modeling facade. The session owns only the last committed artifact
 * and its subscribers; transport, source loading, annotations, and process
 * lifecycle remain the caller's responsibility.
 */
export class ModelingSession {
  private readonly engine: ModelingEngine;
  private readonly subscribers = new Set<ModelSubscriber>();
  private readonly callbackContext = new AsyncLocalStorage<CallbackToken>();
  private operationQueue: Promise<void> = Promise.resolve();
  private notificationQueue: Promise<void> = Promise.resolve();
  private currentModel: CommittedModel | undefined;
  private nextRevision = 1;
  private disposed = false;
  private disposePromise: Promise<void> | undefined;

  constructor(engine: ModelingEngine = new ModelingEngine()) {
    this.engine = engine;
  }

  validate(input: ValidateModelInput, options: RunnerOptions = {}): Promise<ValidationResult> {
    return this.startScheduled(() => this.engine.validate(input, options));
  }

  async execute(input: ExecuteModelInput, options: SessionExecuteOptions = {}): Promise<SessionExecutionResult> {
    const { beforeCommit, ...runnerOptions } = options;
    const execution = this.start(() => this.engine.execute(input, runnerOptions));
    if ('error' in execution) {
      throw execution.error;
    }
    const scheduled = await this.enqueue<ScheduledExecution>(async () => {
      const executionResult = await execution.promise;
      if (!executionResult.report.ok || !executionResult.artifact) {
        return { result: executionResult };
      }

      const revision = this.nextRevision;
      const model: CommittedModel = Object.freeze({
        revision,
        artifact: executionResult.artifact,
      });
      if (beforeCommit) {
        await this.runCallback('beforeCommit', () => beforeCommit(model));
      }

      this.currentModel = model;
      this.nextRevision += 1;
      const result: SessionExecutionResult = { ...executionResult, model };
      const notification = this.enqueueNotification({
        model,
        result,
        listeners: [...this.subscribers],
      });
      return { result, notification };
    });

    await scheduled.notification;
    return scheduled.result;
  }

  getCurrentModel(): CommittedModel | undefined {
    return this.currentModel;
  }

  captureCurrent(options: RenderViewOptions | CaptureOptionsResolver = {}): Promise<CurrentModelCapture | undefined> {
    return this.schedule(async () => {
      const model = this.currentModel;
      if (!model) {
        return undefined;
      }
      const renderOptions =
        typeof options === 'function' ? await this.runCallback('captureOptions', () => options(model)) : options;
      const result = await this.engine.capture({ artifact: model.artifact, options: renderOptions });
      return { model, result };
    });
  }

  subscribe(listener: ModelSubscriber): () => void {
    this.assertActive();
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  /** Idempotently drain accepted work and dispose the owned engine. */
  dispose(): Promise<void> {
    const callback = this.activeCallback();
    if (callback) {
      return Promise.reject(new Error(`ModelingSession cannot be disposed from a ${callback.kind} callback.`));
    }
    if (this.disposePromise) {
      return this.disposePromise;
    }
    this.disposed = true;
    this.disposePromise = (async () => {
      await this.operationQueue;
      await this.notificationQueue;
      try {
        await this.engine.dispose();
      } finally {
        this.subscribers.clear();
        this.currentModel = undefined;
      }
    })();
    return this.disposePromise;
  }

  private schedule<T>(operation: () => Promise<T>): Promise<T> {
    const unavailable = this.schedulingError();
    if (unavailable) {
      return Promise.reject(unavailable);
    }
    return this.enqueue(operation);
  }

  private startScheduled<T>(operation: () => Promise<T>): Promise<T> {
    const started = this.start(operation);
    if ('error' in started) {
      return Promise.reject(started.error);
    }
    return this.enqueue(() => started.promise);
  }

  private start<T>(operation: () => Promise<T>): { promise: Promise<T> } | { error: Error } {
    const unavailable = this.schedulingError();
    if (unavailable) {
      return { error: unavailable };
    }
    try {
      const promise = operation();
      // Eager Runner submission starts the end-to-end timeout before this
      // session queue turn. Observe rejection now, then propagate it when the
      // queued consumer awaits the original promise.
      void promise.catch(() => undefined);
      return { promise };
    } catch (error) {
      return { error: error instanceof Error ? error : new Error(String(error)) };
    }
  }

  private schedulingError(): Error | undefined {
    if (this.disposed) {
      return new Error('ModelingSession has been disposed.');
    }
    const callback = this.activeCallback();
    if (callback) {
      return new Error(`ModelingSession operations cannot be called from a ${callback.kind} callback.`);
    }
    return undefined;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationQueue.then(operation);
    this.operationQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private enqueueNotification(notification: PendingNotification): Promise<void> {
    const next = this.notificationQueue.then(async () => {
      const settled = await Promise.allSettled(
        notification.listeners.map(listener =>
          Promise.resolve().then(() => this.runCallback('subscriber', () => listener(notification.model))),
        ),
      );
      const errors = settled
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map(result => result.reason as unknown);
      if (errors.length > 0) {
        throw new ModelSubscriberError(errors, notification.model, notification.result);
      }
    });
    this.notificationQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error('ModelingSession has been disposed.');
    }
  }

  private activeCallback(): CallbackToken | undefined {
    const callback = this.callbackContext.getStore();
    return callback?.active ? callback : undefined;
  }

  private async runCallback<T>(kind: CallbackToken['kind'], callback: () => T | Promise<T>): Promise<T> {
    const token: CallbackToken = { active: true, kind };
    try {
      return await this.callbackContext.run(token, callback);
    } finally {
      token.active = false;
    }
  }
}

export type { ModelArtifact, PreviewRenderer, RenderResult, RenderViewOptions, Report, RunnerOptions };
