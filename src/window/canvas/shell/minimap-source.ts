/**
 * The minimap's source interface (docs/canvas-gpu-architecture.md, section 17).
 *
 * The map keeps its own drawing; it asks for rectangles, a subscription to
 * their changes, the camera, a subscription to the camera and a way to set it.
 * Both canvases implement it while both exist, so the bar is mounted beside
 * the canvas and finds no store. The handle is module state: exactly one
 * canvas is mounted at a time.
 */

import type { NodeKind } from "@shared/model/kinds";
import type { Camera, CameraTarget, Point, Size } from "../contract";

export type MinimapRect = {
  readonly id: string;
  readonly kind: NodeKind;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export interface MinimapSource {
  readonly rects: () => ReadonlyArray<MinimapRect>;
  readonly onRects: (listener: () => void) => () => void;
  readonly camera: () => Camera;
  readonly onCamera: (listener: (camera: Camera) => void) => () => void;
  readonly viewport: () => Size;
  readonly onViewport: (listener: () => void) => () => void;
  /** Set the camera at once (a map click or drag writes its result). */
  readonly setCamera: (camera: Camera) => void;
  /** Zoom about the view's centre (a map wheel step). */
  readonly zoomBy: (factor: number) => void;
  /** Move the camera through the canvas's own easing (map click). */
  readonly moveCamera: (target: CameraTarget, durationMs?: number) => void;
  /** Flow units per map pixel, for clicks; the map does its own SVG math. */
  readonly screenToBoard: (screen: Point) => Point;
  readonly element: () => HTMLElement | null;
}

let active: MinimapSource | undefined;
const listeners = new Set<() => void>();

export const minimapSource = (): MinimapSource | undefined => active;

export const setMinimapSource = (source: MinimapSource | undefined): void => {
  active = source;
  for (const listener of [...listeners]) listener();
};

export const clearMinimapSource = (source: MinimapSource): void => {
  if (active !== source) return;
  active = undefined;
  for (const listener of [...listeners]) listener();
};

export const subscribeMinimapSource = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
