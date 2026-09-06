import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import type { AnnotationStore } from './annotation-store.js';
import type { FeatureResolver } from './feature-resolver.js';
import { eventToNdc, pickPoint, pickRegion } from './picker.js';
import type { FlyoutLayer } from './flyout/index.js';
import type { MarkMode } from './types.js';

/**
 * Interaction mode for the mark tool:
 *   - 'orbit'    — default camera interaction.
 *   - 'annotate' — click creates a point comment; drag creates a region
 *                  comment and opens its flyout.
 *   - 'select'   — click/drag creates a pending point/region selection
 *                  and notifies ViewerCanvas so it can attach it.
 *
 * Both tools stay armed after a gesture. Escape returns to orbit.
 *
 * Gesture state machine:
 *
 *   idle ──mousedown (armed mode)────► armed
 *   armed ──move>threshold──────────► dragging
 *   armed ──mouseup─────────────────► point pick
 *   dragging ──mouseup──────────────► region pick
 *
 * If the gesture begins inside a flyout, we let it bubble (so users can
 * type / click delete) and skip the state machine entirely.
 */
export class MarkTool {
  private readonly rubberBand: HTMLDivElement;
  private enabled = true;
  private state: 'idle' | 'armed' | 'dragging' = 'idle';
  private mode: MarkMode = 'orbit';
  private startScreen = { x: 0, y: 0 };
  private startNdc = new THREE.Vector2();
  private endNdc = new THREE.Vector2();
  private listeners: Array<() => void> = [];

  constructor(
    overlayParent: HTMLElement,
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: THREE.Camera,
    private readonly controls: OrbitControls,
    private readonly store: AnnotationStore,
    private readonly flyouts: FlyoutLayer,
    private readonly getMesh: () => THREE.Mesh | null,
    private readonly getResolver: () => FeatureResolver | null,
    /** Notified whenever the mode changes (from setMode or Escape). */
    private readonly onModeChange?: (mode: MarkMode) => void,
    /** Notified when a pending selection is ready to be attached. */
    private readonly onSelectionCreated?: (id: string) => void,
  ) {
    this.rubberBand = document.createElement('div');
    this.rubberBand.className = 'marks-rubber-band';
    this.rubberBand.style.display = 'none';
    overlayParent.appendChild(this.rubberBand);

    const onDown = (ev: MouseEvent) => this.handleDown(ev);
    const onMove = (ev: MouseEvent) => this.handleMove(ev);
    const onUp = (ev: MouseEvent) => this.handleUp(ev);
    const onDocClick = (ev: MouseEvent) => this.handleDocClick(ev);
    const onKeyDown = (ev: KeyboardEvent) => this.handleKeyDown(ev);

    canvas.addEventListener('mousedown', onDown);
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    window.addEventListener('click', onDocClick, true);
    window.addEventListener('keydown', onKeyDown);

    this.listeners = [
      () => canvas.removeEventListener('mousedown', onDown),
      () => window.removeEventListener('mousemove', onMove),
      () => window.removeEventListener('mouseup', onUp),
      () => window.removeEventListener('click', onDocClick, true),
      () => window.removeEventListener('keydown', onKeyDown),
    ];
  }

  dispose(): void {
    for (const off of this.listeners) {
      off();
    }
    this.rubberBand.remove();
    delete document.body.dataset.markMode;
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) {
      return;
    }
    if (!enabled) {
      this.cancelGesture();
    }
    this.enabled = enabled;
  }

  /**
   * Switch interaction mode. Cancels any in-flight gesture, updates the
   * cursor affordance, and notifies the UI store. Idempotent.
   */
  setMode(mode: MarkMode): void {
    if (this.mode === mode) {
      return;
    }
    this.mode = mode;
    this.cancelGesture();
    // Drive the cursor from a <body> attribute; orbit clears it and falls
    // back to the default canvas cursor.
    if (mode === 'orbit') {
      delete document.body.dataset.markMode;
    } else {
      document.body.dataset.markMode = mode;
    }
    this.onModeChange?.(mode);
  }

  private cancelGesture(): void {
    if (this.state === 'idle') {
      return;
    }
    this.state = 'idle';
    this.rubberBand.style.display = 'none';
    this.controls.enabled = true;
  }

  private handleKeyDown(ev: KeyboardEvent): void {
    if (!this.enabled || ev.key !== 'Escape') {
      return;
    }
    // Don't steal Escape from an open flyout textarea; the flyout
    // handles its own dismissal first, then a second Escape exits the
    // tool mode.
    if (this.flyouts.ownsTarget(ev.target)) {
      return;
    }
    if (this.mode !== 'orbit') {
      this.setMode('orbit');
    } else {
      this.cancelGesture();
    }
  }

  private handleDown(ev: MouseEvent): void {
    if (!this.enabled || ev.button !== 0) {
      return;
    }
    if (this.mode === 'orbit') {
      return;
    }
    if (this.flyouts.ownsTarget(ev.target)) {
      return;
    }
    this.state = 'armed';
    this.startScreen = { x: ev.clientX, y: ev.clientY };
    this.startNdc.copy(eventToNdc(ev, this.canvas));
    this.controls.enabled = false;
    ev.preventDefault();
    ev.stopPropagation();
  }

  private handleMove(ev: MouseEvent): void {
    if (!this.enabled || this.state === 'idle') {
      return;
    }
    const dx = ev.clientX - this.startScreen.x;
    const dy = ev.clientY - this.startScreen.y;
    if (this.state === 'armed' && Math.hypot(dx, dy) > 4) {
      this.state = 'dragging';
      this.rubberBand.style.display = '';
    }
    if (this.state === 'dragging') {
      this.endNdc.copy(eventToNdc(ev, this.canvas));
      this.updateRubberBandRect(ev);
    }
  }

  private handleUp(ev: MouseEvent): void {
    if (!this.enabled || this.state === 'idle') {
      return;
    }
    const wasDragging = this.state === 'dragging';
    this.state = 'idle';
    this.rubberBand.style.display = 'none';
    this.controls.enabled = true;

    const mesh = this.getMesh();
    if (!mesh) {
      return;
    }
    if (wasDragging) {
      this.endNdc.copy(eventToNdc(ev, this.canvas));
      const region = pickRegion(this.startNdc, this.endNdc, this.camera, mesh);
      if (region) {
        const resolver = this.getResolver();
        const partLabel = resolver?.labelForRegion(region.triIds) ?? undefined;
        this.createAnnotation({
          kind: 'region',
          worldCoord: region.centroidWorld.toArray() as [number, number, number],
          anchorWorld: region.centroidWorld.toArray() as [number, number, number],
          triIds: region.triIds,
          ...(partLabel !== undefined ? { partLabel } : {}),
        });
      }
    } else {
      const ndc = eventToNdc(ev, this.canvas);
      const hit = pickPoint(ndc, this.camera, mesh);
      if (hit) {
        const resolver = this.getResolver();
        const partLabel = resolver?.labelForPoint(hit.triId, hit.worldCoord) ?? undefined;
        this.createAnnotation({
          kind: 'point',
          worldCoord: hit.worldCoord.toArray() as [number, number, number],
          anchorWorld: hit.worldCoord.toArray() as [number, number, number],
          triIds: [],
          ...(partLabel !== undefined ? { partLabel } : {}),
        });
      }
    }
  }

  /**
   * Any click outside flyouts dismisses an open flyout in orbit mode.
   * In an explicit tool mode clicks are
   * the marking gesture, so they must not double as "dismiss".
   */
  private handleDocClick(ev: MouseEvent): void {
    if (!this.enabled || this.mode !== 'orbit') {
      return;
    }
    if (this.flyouts.ownsTarget(ev.target)) {
      return;
    }
    this.flyouts.dismissAll();
  }

  private updateRubberBandRect(ev: MouseEvent): void {
    const rect = this.canvas.getBoundingClientRect();
    const left = Math.min(this.startScreen.x, ev.clientX) - rect.left;
    const top = Math.min(this.startScreen.y, ev.clientY) - rect.top;
    const width = Math.abs(ev.clientX - this.startScreen.x);
    const height = Math.abs(ev.clientY - this.startScreen.y);
    this.rubberBand.style.left = `${left}px`;
    this.rubberBand.style.top = `${top}px`;
    this.rubberBand.style.width = `${width}px`;
    this.rubberBand.style.height = `${height}px`;
  }

  private createAnnotation(input: {
    kind: 'point' | 'region';
    worldCoord: [number, number, number];
    anchorWorld: [number, number, number];
    triIds: number[];
    partLabel?: string;
  }): void {
    if (this.mode === 'select') {
      const selection = this.store.addSelection(input);
      this.onSelectionCreated?.(selection.id);
      return;
    }
    const comment = this.store.addComment({ ...input, note: '' });
    this.flyouts.openExpanded(comment.id);
  }
}
