import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';

import type { AnnotationStore } from './annotation-store.js';
import type { FeatureResolver } from './feature-resolver.js';
import { eventToNdc, pickPoint, pickRegion } from './picker.js';
import type { FlyoutLayer } from './flyout.js';

/**
 * Interaction mode for the mark tool:
 *   - 'orbit'  — default. Camera drag on plain left click; annotations
 *                are still reachable through the legacy Ctrl+click /
 *                Ctrl+drag power-user gestures.
 *   - 'point'  — explicit point-annotation tool: plain left click on
 *                the model places a point mark. Drags are ignored (no
 *                accidental marks).
 *   - 'region' — explicit region tool: plain left drag draws the
 *                rubber band and creates a region mark on release.
 *
 * The tool stays armed after each completed mark so users can place
 * several in a row; Escape (or clicking the orbit tool in the UI)
 * returns to 'orbit'.
 *
 * Gesture state machine (unchanged from upstream):
 *
 *   idle ──mousedown (mode or Ctrl)─► armed
 *   armed ──move>threshold──────────► dragging (region-capable gestures)
 *   armed ──mouseup─────────────────► point pick
 *   dragging ──mouseup──────────────► region pick
 *
 * If the gesture begins inside a flyout, we let it bubble (so users can
 * type / click delete) and skip the state machine entirely.
 */
export type MarkToolMode = 'orbit' | 'point' | 'region';

/** How each armed gesture may resolve. */
type GestureKind =
  /** Legacy Ctrl gesture: click ⇒ point, drag ⇒ region. */
  | 'auto'
  /** Point tool: click ⇒ point, drag ⇒ cancelled. */
  | 'point'
  /** Region tool: drag ⇒ region, bare click ⇒ nothing. */
  | 'region';

export class MarkTool {
  private readonly rubberBand: HTMLDivElement;
  private enabled = true;
  private state: 'idle' | 'armed' | 'dragging' = 'idle';
  private mode: MarkToolMode = 'orbit';
  private gesture: GestureKind = 'auto';
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
    private readonly onModeChange?: (mode: MarkToolMode) => void,
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

  getMode(): MarkToolMode {
    return this.mode;
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
  setMode(mode: MarkToolMode): void {
    if (this.mode === mode) {
      return;
    }
    this.mode = mode;
    this.cancelGesture();
    // Drive the cursor from a <body> attribute so styles.css can give
    // point (crosshair) and region (cell) distinct affordances; orbit
    // clears it and falls back to the default canvas cursor.
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
    const ctrl = ev.ctrlKey || ev.metaKey;
    if (this.mode === 'orbit' && !ctrl) {
      return;
    }
    if (this.flyouts.ownsTarget(ev.target)) {
      return;
    }
    // Ctrl in any mode keeps the legacy dual-purpose gesture; the
    // explicit tools pin the gesture kind.
    this.gesture = ctrl ? 'auto' : this.mode === 'region' ? 'region' : 'point';
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
      if (this.gesture === 'point') {
        // Point tool: a drag is not a click — cancel so users don't
        // drop marks by accident while trying to orbit.
        this.cancelGesture();
        return;
      }
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
      const region = pickRegion(this.startNdc, this.endNdc, this.camera, mesh);
      if (region) {
        const resolver = this.getResolver();
        const partLabel = resolver?.labelForRegion(region.triIds) ?? undefined;
        const ann = this.store.add({
          kind: 'region',
          worldCoord: region.centroidWorld.toArray() as [number, number, number],
          anchorWorld: region.centroidWorld.toArray() as [number, number, number],
          triIds: region.triIds,
          note: '',
          ...(partLabel !== undefined ? { partLabel } : {}),
        });
        this.flyouts.openExpanded(ann.id);
      }
    } else {
      if (this.gesture === 'region') {
        // Region tool needs an actual drag; a bare click does nothing.
        return;
      }
      const ndc = eventToNdc(ev, this.canvas);
      const hit = pickPoint(ndc, this.camera, mesh);
      if (hit) {
        const resolver = this.getResolver();
        const partLabel = resolver?.labelForPoint(hit.triId, hit.worldCoord) ?? undefined;
        const ann = this.store.add({
          kind: 'point',
          worldCoord: hit.worldCoord.toArray() as [number, number, number],
          anchorWorld: hit.worldCoord.toArray() as [number, number, number],
          triIds: [],
          note: '',
          ...(partLabel !== undefined ? { partLabel } : {}),
        });
        this.flyouts.openExpanded(ann.id);
      }
    }
  }

  /**
   * Any plain (non-Ctrl) click outside flyouts dismisses an open flyout
   * — but only in orbit mode. In an explicit tool mode plain clicks ARE
   * the marking gesture, so they must not double as "dismiss".
   */
  private handleDocClick(ev: MouseEvent): void {
    if (!this.enabled || ev.ctrlKey || ev.metaKey || this.mode !== 'orbit') {
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
}
