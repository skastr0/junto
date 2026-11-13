/**
 * Camera targets as arithmetic (docs/canvas-gpu-architecture.md, section 19).
 *
 * The shell holds the camera and the cards' board rectangles, so every camera
 * move the rest of the app asks for — fit, centre, zoom about a point — is
 * worked out here, synchronously, and handed to whichever canvas is mounted.
 * The same functions serve the old canvas's opening placement
 * (`lib/camera-placement.ts`), so both canvases open on the same view.
 */

import {
  CAMERA_MAX_ZOOM,
  CAMERA_MIN_ZOOM,
  type Camera,
  type CameraTarget,
  type Point,
  type Rect,
  type Size,
} from "../contract";

/** Today's `getViewportForBounds`: bounds letterboxed with padding, centred. */
export const viewportForBounds = (
  bounds: Rect,
  viewport: Size,
  minZoom: number,
  maxZoom: number,
  padding: number,
): Camera => {
  const width = Math.max(bounds.width, 1);
  const height = Math.max(bounds.height, 1);
  const zoom = Math.min(
    viewport.width / (width * (1 + padding)),
    viewport.height / (height * (1 + padding)),
  );
  const clamped = Math.max(minZoom, Math.min(maxZoom, zoom));
  return {
    x: viewport.width / 2 - (bounds.x + bounds.width / 2) * clamped,
    y: viewport.height / 2 - (bounds.y + bounds.height / 2) * clamped,
    zoom: clamped,
  };
};

export const boundsOfRects = (rects: ReadonlyArray<Rect>): Rect | undefined => {
  if (rects.length === 0) return undefined;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const rect of rects) {
    left = Math.min(left, rect.x);
    top = Math.min(top, rect.y);
    right = Math.max(right, rect.x + rect.width);
    bottom = Math.max(bottom, rect.y + rect.height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
};

const clampZoom = (zoom: number): number =>
  Math.max(CAMERA_MIN_ZOOM, Math.min(CAMERA_MAX_ZOOM, zoom));

/** The camera a target names, given the camera and viewport now. */
export const cameraForTarget = (
  target: CameraTarget,
  now: Camera,
  viewport: Size,
  boundsOf: (ids: ReadonlyArray<string>) => Rect | undefined,
  ids?: ReadonlyArray<string>,
): Camera => {
  switch (target.kind) {
    case "camera":
      return { ...target.camera, zoom: clampZoom(target.camera.zoom) };
    case "fit": {
      const bounds = boundsOfRects(target.rects);
      if (bounds === undefined) return now;
      return viewportForBounds(bounds, viewport, CAMERA_MIN_ZOOM, target.maxZoom, target.padding);
    }
    case "centre": {
      const zoom = clampZoom(target.zoom ?? now.zoom);
      return centreOn(target.at, zoom, viewport);
    }
    case "zoomBy": {
      const zoom = clampZoom(now.zoom * target.factor);
      const about = target.about ?? { x: viewport.width / 2, y: viewport.height / 2 };
      return zoomAbout(now, zoom, about);
    }
    case "zoomTo": {
      const zoom = clampZoom(target.zoom);
      const about = target.about ?? { x: viewport.width / 2, y: viewport.height / 2 };
      return zoomAbout(now, zoom, about);
    }
  }
  void ids;
  return now;
};

export const centreOn = (at: Point, zoom: number, viewport: Size): Camera => ({
  x: viewport.width / 2 - at.x * zoom,
  y: viewport.height / 2 - at.y * zoom,
  zoom,
});

/** Keep the board point under `about` where it is while the zoom changes. */
export const zoomAbout = (camera: Camera, zoom: number, about: Point): Camera => {
  const ratio = zoom / camera.zoom;
  return {
    x: about.x - (about.x - camera.x) * ratio,
    y: about.y - (about.y - camera.y) * ratio,
    zoom,
  };
};

/** Cubic in-out, the ease the smooth zoom path uses. */
export const easeInOut = (t: number): number =>
  t <= 0 ? 0 : t >= 1 ? 1 : t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;

export const sameCamera = (a: Camera, b: Camera): boolean =>
  a.x === b.x && a.y === b.y && a.zoom === b.zoom;

export const interpolateCamera = (from: Camera, to: Camera, t: number): Camera => {
  const k = easeInOut(t);
  return {
    x: from.x + (to.x - from.x) * k,
    y: from.y + (to.y - from.y) * k,
    zoom: from.zoom + (to.zoom - from.zoom) * k,
  };
};
