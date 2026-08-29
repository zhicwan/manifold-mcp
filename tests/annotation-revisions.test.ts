import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ANNOTATIONS_PROTOCOL_VERSION, MAX_ANNOTATION_NOTE_LENGTH } from '../packages/protocol/src/wire/annotations.js';
import { AnnotationStore } from '../packages/viewer/src/marks/annotation-store.js';
import { installAnnotationsUplink } from '../packages/viewer/src/marks/ws-uplink.js';

describe('viewer annotation revisions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', {
      setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay),
      clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('increments monotonically and uplinks a versioned snapshot revision', () => {
    const store = new AnnotationStore();
    const sent: unknown[] = [];
    store.setModelVersion('v1');
    expect(store.getRevision()).toBe(1);
    const uplink = installAnnotationsUplink(store, {
      send: message => sent.push(message),
      isOpen: () => true,
    });
    try {
      uplink.flushNow();
      expect(sent.at(-1)).toMatchObject({
        kind: 'annotations',
        protocolVersion: ANNOTATIONS_PROTOCOL_VERSION,
        revision: 1,
        modelVersion: 'v1',
        items: [],
      });

      const annotation = store.addComment({
        kind: 'point',
        anchorWorld: [0, 0, 0],
        worldCoord: [0, 0, 0],
        triIds: [],
        note: 'review',
      });
      expect(store.getRevision()).toBe(2);
      uplink.flushNow();
      expect(sent.at(-1)).toMatchObject({ revision: 2, items: [{ note: 'review' }] });
      const wire = (sent.at(-1) as { items: Array<Record<string, unknown>> }).items[0]!;
      expect(wire).not.toHaveProperty('intent');
      expect(wire).not.toHaveProperty('state');
      expect(wire).not.toHaveProperty('batchId');
      expect(annotation).toMatchObject({ intent: 'comment', state: 'draft' });
      store.cancelCurrentBatch();
      expect(store.getRevision()).toBe(3);
    } finally {
      uplink.dispose();
    }
  });

  it('rebases a reloaded store above the revision retained by the host', () => {
    const store = new AnnotationStore();
    store.rebaseRevision(7);
    store.setModelVersion('v1');
    expect(store.getRevision()).toBe(8);
    expect(() => store.rebaseRevision(-1)).toThrow(/nonnegative safe integer/);
  });

  it('rejects overlong notes at add and update boundaries', () => {
    const store = new AnnotationStore();
    const input = {
      kind: 'point' as const,
      anchorWorld: [0, 0, 0] as [number, number, number],
      worldCoord: [0, 0, 0] as [number, number, number],
      triIds: [],
      note: 'x'.repeat(MAX_ANNOTATION_NOTE_LENGTH + 1),
    };
    expect(() => store.addComment(input)).toThrow(/cannot exceed/);
    const annotation = store.addComment({ ...input, note: '' });
    expect(() => store.update(annotation.id, { note: input.note })).toThrow(/cannot exceed/);
    expect(store.get(annotation.id)?.note).toBe('');
  });

  it('reports serialization/flush failures without throwing and recovers on a later flush', () => {
    const store = new AnnotationStore();
    store.setModelVersion('v1');
    const invalid = store.addComment({
      kind: 'point',
      anchorWorld: [0, 0, 0],
      worldCoord: [Number.NaN, 0, 0],
      triIds: [],
      note: 'review',
    });
    const errors: Error[] = [];
    const successes = vi.fn();
    const sent: unknown[] = [];
    const uplink = installAnnotationsUplink(
      store,
      {
        send: message => sent.push(message),
        isOpen: () => true,
      },
      {
        onError: error => errors.push(error),
        onSuccess: successes,
      },
    );
    try {
      expect(() => uplink.flushNow()).not.toThrow();
      expect(uplink.hasPendingFlush()).toBe(true);
      expect(errors.at(-1)?.message).toMatch(/finite/);
      expect(sent).toEqual([]);

      expect(store.remove(invalid.id)).toBe(true);
      store.addComment({
        kind: 'point',
        anchorWorld: [0, 0, 0],
        worldCoord: [0, 0, 0],
        triIds: [],
        note: 'recovered',
      });
      expect(uplink.flushNow()).toBe(true);
      expect(uplink.hasPendingFlush()).toBe(false);
      expect(successes).toHaveBeenCalledTimes(1);
      expect(sent).toHaveLength(1);
    } finally {
      uplink.dispose();
    }
  });
});
