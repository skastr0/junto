/**
 * Did the camera move between a shot and the rectangles measured against it?
 *
 * The proof takes a tier's picture, then reads where seats and badges are and
 * looks for ink inside those rectangles. A real click in between that lands
 * on operator chrome (the minimap flies the camera on a click) moves the
 * camera, and the rectangles then belong to a different picture: small items
 * read blank at the old picture's pixels (#913 far clusters). A stop's shot and
 * its rectangles must share one camera.
 */

export type ProofCamera = { readonly x: number; readonly y: number; readonly zoom: number };

/** Screen-pixel slack at the shot's zoom, for a camera that settles a hair off. */
export const CAMERA_DRIFT_EPSILON = 0.01;

/** The two cameras differ by more than the slack in x, y or zoom. */
export const cameraDrifted = (shot: ProofCamera, now: ProofCamera): boolean =>
  Math.abs(shot.x - now.x) > CAMERA_DRIFT_EPSILON || Math.abs(shot.y - now.y) > CAMERA_DRIFT_EPSILON || Math.abs(shot.zoom - now.zoom) > CAMERA_DRIFT_EPSILON;
