import * as THREE from 'three';

import { eventToNdc, pickPoint } from './picker.js';
import type { FeatureResolver } from './feature-resolver.js';

/**
 * Alt-hover preview: when the user holds Alt and moves the cursor over
 * the model, every triangle that belongs to the same feature lights up
 * cyan. Gives an explicit "what would I be selecting" preview without
 * implying that a plain click does anything (which it doesn't — marks
 * require Ctrl-modified gestures).
 *
 * Performance:
 *   - Raycast happens on mousemove but the highlight geometry is only
 *     rebuilt when the feature under the cursor changes (we cache the
 *     last featureIdx).
 *   - Move handling is gated on requestAnimationFrame so we coalesce
 *     bursts of mousemove events into at most one raycast per frame.
 *   - Picking is suppressed during a Ctrl-modified gesture (drag-select)
 *     since OrbitControls is also disabled then; rendering an
 *     intermediate highlight would distract from the rubber-band.
 */
/**
 * Cache entry for a previously-hovered feature. We keep both the
 * Float32Array of vertex positions AND the BufferGeometry that wraps
 * it so re-hovering the same feature is a single attribute swap rather
 * than a fresh allocation + copy. Disposed when the model changes
 * (reset()) — feature indices are only meaningful within one model.
 */
interface FeatureGeomCacheEntry {
  positions: Float32Array;
  geometry: THREE.BufferGeometry;
}

export class HoverHighlight {
  private readonly overlay: THREE.Mesh;
  private enabled = true;
  private currentFeatureIdx = -1;
  private pendingEvent: MouseEvent | null = null;
  private lastMouseEvent: MouseEvent | null = null;
  private raf = 0;
  private listeners: Array<() => void> = [];
  /**
   * VIE-5: per-feature highlight geometry cache. The user typically
   * sweeps a cursor back and forth over the same handful of features;
   * without this cache each pass over a 5k-tri feature reallocates
   * 60KB of Float32 + a BufferGeometry. With it we hit cache on the
   * 2nd+ hover and only the index lookup happens.
   */
  private readonly featureGeomCache = new Map<number, FeatureGeomCacheEntry>();

  constructor(
    private readonly scene: THREE.Scene,
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: THREE.Camera,
    private readonly getMesh: () => THREE.Mesh | null,
    private readonly getResolver: () => FeatureResolver | null,
    private readonly requestRender: () => void,
  ) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(0), 3));
    const mat = new THREE.MeshBasicMaterial({
      color: 0x60ffff,
      transparent: true,
      opacity: 0.18,
      depthTest: false,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    this.overlay = new THREE.Mesh(geom, mat);
    this.overlay.renderOrder = 997;
    this.overlay.visible = false;
    this.scene.add(this.overlay);

    const onMove = (ev: MouseEvent): void => {
      if (!this.enabled) {
        return;
      }
      this.lastMouseEvent = ev;
      // Don't compete with marker placement / rubber band.
      if (ev.ctrlKey || ev.metaKey) {
        this.clear();
        return;
      }
      // Highlight is opt-in: only when Alt is held. Without this gate
      // the cyan tint shows up on every hover, which subtly suggests
      // that plain click is interactive (it isn't).
      if (!ev.altKey) {
        this.clear();
        return;
      }
      this.scheduleRefresh(ev);
    };
    const onLeave = (): void => this.clear();

    // Re-trigger / clear on Alt key transitions so the highlight follows
    // the modifier state even when the mouse is stationary.
    const onKeyDown = (ev: KeyboardEvent): void => {
      if (!this.enabled || ev.key !== 'Alt' || !this.lastMouseEvent) {
        return;
      }
      // Replay the last mouse event with altKey now true, by passing a
      // synthetic shape the rest of the pipeline can read.
      const replay = withAltKey(this.lastMouseEvent, true);
      this.scheduleRefresh(replay);
    };
    const onKeyUp = (ev: KeyboardEvent): void => {
      if (ev.key === 'Alt') {
        this.clear();
      }
    };

    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mouseleave', onLeave);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    this.listeners = [
      () => canvas.removeEventListener('mousemove', onMove),
      () => canvas.removeEventListener('mouseleave', onLeave),
      () => window.removeEventListener('keydown', onKeyDown),
      () => window.removeEventListener('keyup', onKeyUp),
    ];
  }

  private scheduleRefresh(ev: MouseEvent): void {
    this.pendingEvent = ev;
    if (this.raf === 0) {
      this.raf = requestAnimationFrame(this.processPending);
    }
  }

  /** Reset state when a new model loads (cached feature idx is stale). */
  reset(): void {
    this.clear();
    // Feature indices are only meaningful within one model — a fresh
    // model's "feature 3" is a totally different region. Drop every
    // cached geometry so we don't leak GPU buffers (VIE-5).
    for (const entry of this.featureGeomCache.values()) {
      entry.geometry.dispose();
    }
    this.featureGeomCache.clear();
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) {
      return;
    }
    this.enabled = enabled;
    if (!enabled) {
      this.pendingEvent = null;
      this.clear();
    }
  }

  dispose(): void {
    if (this.raf !== 0) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    for (const off of this.listeners) {
      off();
    }
    this.scene.remove(this.overlay);
    // The overlay's CURRENT geometry is borrowed from the cache (or the
    // initial empty placeholder); the cache's dispose loop covers the
    // borrowed entry so we don't double-dispose. The placeholder geom
    // installed in the constructor is also in the overlay slot if no
    // hover ever happened, in which case the cache loop is a no-op and
    // we still need to release it explicitly.
    if (!this.overlayGeomFromCache) {
      this.overlay.geometry.dispose();
    }
    for (const entry of this.featureGeomCache.values()) {
      entry.geometry.dispose();
    }
    this.featureGeomCache.clear();
    (this.overlay.material as THREE.Material).dispose();
  }

  private readonly processPending = (): void => {
    this.raf = 0;
    const ev = this.pendingEvent;
    this.pendingEvent = null;
    if (!ev) {
      return;
    }
    const mesh = this.getMesh();
    const resolver = this.getResolver();
    if (!mesh || !resolver) {
      this.clear();
      return;
    }
    const ndc = eventToNdc(ev, this.canvas);
    const hit = pickPoint(ndc, this.camera, mesh);
    if (!hit) {
      this.clear();
      return;
    }
    const featureIdx = resolver.triIdToFeatureIdx(hit.triId);
    if (featureIdx < 0) {
      this.clear();
      return;
    }
    if (featureIdx === this.currentFeatureIdx && this.overlay.visible) {
      // Same feature as last frame: nothing to rebuild.
      return;
    }
    this.show(mesh, resolver, featureIdx);
  };

  private overlayGeomFromCache = false;

  private show(mesh: THREE.Mesh, resolver: FeatureResolver, featureIdx: number): void {
    const triIds = resolver.triIdsForFeature(featureIdx);
    if (triIds.length === 0) {
      this.clear();
      return;
    }

    let entry = this.featureGeomCache.get(featureIdx);
    if (!entry) {
      const sourceGeom = mesh.geometry as THREE.BufferGeometry;
      const sourcePos = sourceGeom.getAttribute('position') as THREE.BufferAttribute;
      const sourceIndex = sourceGeom.getIndex();
      if (!sourceIndex) {
        this.clear();
        return;
      }
      const positions = new Float32Array(triIds.length * 9);
      let cursor = 0;
      for (let i = 0; i < triIds.length; i++) {
        const tri = triIds[i];
        for (let k = 0; k < 3; k++) {
          const vi = sourceIndex.getX(tri * 3 + k);
          positions[cursor++] = sourcePos.getX(vi);
          positions[cursor++] = sourcePos.getY(vi);
          positions[cursor++] = sourcePos.getZ(vi);
        }
      }
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      entry = { positions, geometry };
      this.featureGeomCache.set(featureIdx, entry);
    }

    // Swap geometry. The old overlay.geometry is either the constructor
    // placeholder (first hover) or a different cache entry — in either
    // case we DON'T dispose it here, because:
    //   - the placeholder lives on the overlay; we dispose it once in
    //     dispose() if it's never been swapped out (overlayGeomFromCache=false).
    //   - cache entries are owned by featureGeomCache and disposed in bulk
    //     on reset()/dispose().
    if (!this.overlayGeomFromCache) {
      // First time we replace the placeholder; dispose it so the GPU
      // buffer for the empty Float32Array is released.
      this.overlay.geometry.dispose();
    }
    this.overlay.geometry = entry.geometry;
    this.overlayGeomFromCache = true;
    this.overlay.matrix.copy(mesh.matrixWorld);
    this.overlay.matrixAutoUpdate = false;
    this.overlay.visible = true;
    this.currentFeatureIdx = featureIdx;
    this.requestRender();
  }

  private clear(): void {
    if (!this.overlay.visible && this.currentFeatureIdx === -1) {
      return;
    }
    this.overlay.visible = false;
    this.currentFeatureIdx = -1;
    this.requestRender();
  }
}

/**
 * Build a shallow copy of a mouse event with `altKey` overridden so the
 * raycast pipeline sees the modifier even though the original event
 * predates the keypress. We only read clientX/clientY plus modifier
 * flags downstream so a structural copy is sufficient.
 */
function withAltKey(src: MouseEvent, altKey: boolean): MouseEvent {
  return {
    clientX: src.clientX,
    clientY: src.clientY,
    altKey,
    ctrlKey: src.ctrlKey,
    metaKey: src.metaKey,
    shiftKey: src.shiftKey,
    button: src.button,
    target: src.target,
    preventDefault() {
      // no-op: synthetic event used internally for replaying mouse coords
    },
    stopPropagation() {
      // no-op: synthetic event used internally for replaying mouse coords
    },
  } as unknown as MouseEvent;
}
