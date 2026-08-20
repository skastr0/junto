/**
 * GPU presents for a keep-alive terminal are leased, not ambient.
 *
 * Hidden seats still ingest PTY bytes into the xterm buffer. Only the
 * presenting renderer (WebGL addon) is paused. Optional motion flags pause
 * presents when the page is hidden or the operator asked to freeze motion;
 * omitted flags do not constrain.
 */

export type TerminalPaintLease = {
  readonly visible: boolean;
  readonly reducedMotion?: boolean;
  readonly surfaceMotionLive?: boolean;
};

/**
 * True when this surface may attach a presenting WebGL renderer.
 *
 * `visible` is the keep-alive seat gate. `reducedMotion` / `surfaceMotionLive`
 * are the same motion pause expressed two ways — pass either.
 */
export const shouldPresentTerminalFrames = (
  input: TerminalPaintLease,
): boolean =>
  input.visible &&
  input.reducedMotion !== true &&
  input.surfaceMotionLive !== false;
