/**
 * The camera, handed across the switch (docs/canvas-gpu-architecture.md,
 * section 14): the canvas that unmounts leaves its camera here, and the one
 * that mounts takes it, so turning the GPU canvas on or off never moves the
 * view. A camera is only taken for the canvas it was left on, and only once.
 *
 * Plain module state, no observable: nothing renders from it, and exactly one
 * canvas is mounted at a time. Deleted with the old canvas (milestone 7).
 */

export type HandedCamera = { readonly x: number; readonly y: number; readonly zoom: number };

let left: { readonly canvasName: string; readonly camera: HandedCamera } | undefined;

/** The unmounting canvas leaves the camera it shows on `canvasName`. */
export const leaveCamera = (canvasName: string, camera: HandedCamera): void => {
  if (!canvasName) return;
  if (![camera.x, camera.y, camera.zoom].every(Number.isFinite) || camera.zoom <= 0) return;
  left = { canvasName, camera: { x: camera.x, y: camera.y, zoom: camera.zoom } };
};

/** The mounting canvas takes the camera left on `canvasName`, if any. */
export const takeCamera = (canvasName: string): HandedCamera | undefined => {
  if (left === undefined || left.canvasName !== canvasName) return undefined;
  const { camera } = left;
  left = undefined;
  return camera;
};
