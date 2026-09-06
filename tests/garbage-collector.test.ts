import { describe, expect, it } from 'vitest';

import {
  cleanup,
  garbageCollectFunction,
  garbageCollectInstance,
  getLastCleanupDeleteFailures,
} from '../packages/modeling/src/sandbox/garbage-collector.js';

describe('garbage-collector MNT-6 delete failure tracking', () => {
  it('reports zero failures when all deletes succeed', () => {
    let calls = 0;
    garbageCollectInstance({
      delete() {
        calls++;
      },
    });
    garbageCollectInstance({
      delete() {
        calls++;
      },
    });
    cleanup();
    expect(calls).toBe(2);
    expect(getLastCleanupDeleteFailures()).toBe(0);
  });

  it('counts swallowed errors thrown from delete()', () => {
    garbageCollectInstance({
      delete() {
        throw new Error('boom-1');
      },
    });
    garbageCollectInstance({
      delete() {
        throw new Error('boom-2');
      },
    });
    garbageCollectInstance({
      delete() {
        // success path mixed in
      },
    });
    cleanup();
    expect(getLastCleanupDeleteFailures()).toBe(2);
  });

  it('counts failures inside arrays (e.g. decompose() / split() results)', () => {
    const arr = [
      {
        delete() {
          throw new Error('arr-fail');
        },
      },
      {
        delete() {
          /* ok */
        },
      },
    ];
    garbageCollectInstance(arr);
    cleanup();
    expect(getLastCleanupDeleteFailures()).toBe(1);
  });

  it('resets the counter at the start of every cleanup() call', () => {
    garbageCollectInstance({
      delete() {
        throw new Error('first-pass');
      },
    });
    cleanup();
    expect(getLastCleanupDeleteFailures()).toBe(1);

    // Second pass: only successful deletes should reset the counter to 0.
    garbageCollectInstance({
      delete() {
        /* ok */
      },
    });
    cleanup();
    expect(getLastCleanupDeleteFailures()).toBe(0);
  });

  it('tolerates objects without a delete() method', () => {
    garbageCollectInstance({});
    garbageCollectInstance({ unrelated: 1 });
    cleanup();
    expect(getLastCleanupDeleteFailures()).toBe(0);
  });

  it('deletes the same registered object only once per cleanup', () => {
    let calls = 0;
    const shared = {
      delete() {
        calls++;
      },
    };
    garbageCollectInstance(shared);
    garbageCollectInstance(shared);
    garbageCollectInstance(shared);
    cleanup();
    expect(calls).toBe(1);
    expect(getLastCleanupDeleteFailures()).toBe(0);
  });

  it('deduplicates an object registered by both a wrapped factory and the caller', () => {
    let calls = 0;
    const shared = {
      delete() {
        calls++;
      },
    };
    const factory = garbageCollectFunction(() => shared);
    const result = factory();
    garbageCollectInstance(result);
    cleanup();
    expect(calls).toBe(1);
    expect(getLastCleanupDeleteFailures()).toBe(0);
  });

  it('deduplicates array entries and shared elements while deleting every distinct object', () => {
    const calls = new Map<string, number>();
    const tracked = (name: string) => ({
      delete() {
        calls.set(name, (calls.get(name) ?? 0) + 1);
      },
    });
    const shared = tracked('shared');
    const first = tracked('first');
    const second = tracked('second');
    const appended = tracked('appended');
    const array = [shared, first];

    garbageCollectInstance(array);
    garbageCollectInstance(array);
    array.push(appended);
    garbageCollectInstance([shared, second]);
    garbageCollectInstance(shared);
    cleanup();

    expect(Object.fromEntries(calls)).toEqual({ shared: 1, first: 1, appended: 1, second: 1 });
    expect(getLastCleanupDeleteFailures()).toBe(0);
  });

  it('clears identity tracking after cleanup', () => {
    let calls = 0;
    const shared = {
      delete() {
        calls++;
      },
    };
    garbageCollectInstance(shared);
    cleanup();
    garbageCollectInstance(shared);
    cleanup();
    expect(calls).toBe(2);
  });
});
