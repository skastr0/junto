export type TerminalGeometry = {
  readonly cols: number;
  readonly rows: number;
};

/**
 * A child PTY only needs SIGWINCH when its terminal geometry changes.
 * Renderer remounts and local repaints must not manufacture resize edges.
 */
export const shouldNotifyPtyResize = (
  previous: TerminalGeometry,
  next: TerminalGeometry,
): boolean => previous.cols !== next.cols || previous.rows !== next.rows;

/**
 * Pane box is authority. Never measure the live .xterm node — that island
 * is sized to the current grid, so pin/focus/dock growth would freeze.
 */
export const cellsForPane = (input: {
  readonly hostWidth: number;
  readonly hostHeight: number;
  readonly cellW: number;
  readonly cellH: number;
  readonly padX: number;
  readonly padY: number;
}): { readonly cols: number; readonly rows: number; readonly w: number; readonly h: number } | null => {
  const w = Math.max(0, input.hostWidth - input.padX);
  const h = Math.max(0, input.hostHeight - input.padY);
  if (w < 40 || h < 40) return null;
  if (!(input.cellW > 1) || !(input.cellH > 1)) return null;
  return {
    w,
    h,
    cols: Math.max(20, Math.min(300, Math.floor(w / input.cellW))),
    rows: Math.max(5, Math.min(120, Math.floor(h / input.cellH))),
  };
};
