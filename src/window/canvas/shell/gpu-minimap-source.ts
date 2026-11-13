/**
 * The GPU canvas's minimap source (docs/canvas-gpu-architecture.md, section
 * 17): rectangles and the camera from the shell's mirror, camera writes
 * through the CanvasApi. It imports no renderer.
 */

import type { MinimapRect, MinimapSource } from "./minimap-source";
import type { SurfaceMirror } from "./surface-mirror";
import type { CanvasApi } from "../contract";

export const createGpuMinimapSource = (mirror: SurfaceMirror, api: CanvasApi): MinimapSource => ({
  rects: (): ReadonlyArray<MinimapRect> =>
    mirror.cardIds().map((id) => {
      const card = mirror.card(id)!;
      return { id, kind: card.row.kind, x: card.row.x, y: card.row.y, width: card.row.width, height: card.row.height };
    }),
  onRects: (listener) => mirror.onRects(listener),
  camera: () => mirror.camera(),
  onCamera: (listener) => mirror.onCamera(listener),
  viewport: () => mirror.viewport(),
  onViewport: (listener) => mirror.onViewport(listener),
  setCamera: (camera) => api.moveCamera({ kind: "camera", camera }),
  zoomBy: (factor) => api.zoomBy(factor),
  moveCamera: (target, durationMs) => api.moveCamera(target, { durationMs }),
  screenToBoard: (screen) => mirror.screenToBoard(screen),
  element: () => mirror.element(),
});
