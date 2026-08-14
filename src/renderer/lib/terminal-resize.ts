export type TerminalGeometry = {
  readonly cols: number;
  readonly rows: number;
};

export const UNKNOWN_TERMINAL_GEOMETRY: TerminalGeometry = { cols: 0, rows: 0 };

/**
 * Trailing window before the child is told a new size after the first notify.
 * First notify (acked is unknown) is immediate — Remote SSH must not delay paint.
 */
export const PTY_NOTIFY_SETTLE_MS = 120;

/**
 * A child PTY only needs SIGWINCH when its terminal geometry changes.
 * Renderer remounts and local repaints must not manufacture resize edges.
 * Compare against last **acked** child size, never the painted xterm grid.
 */
export const shouldNotifyPtyResize = (
  acked: TerminalGeometry,
  desired: TerminalGeometry,
): boolean => acked.cols !== desired.cols || acked.rows !== desired.rows;

export const shouldPaintView = (
  painted: TerminalGeometry,
  desired: TerminalGeometry,
): boolean => painted.cols !== desired.cols || painted.rows !== desired.rows;

/** First SIGWINCH after attach is immediate; later pin/focus hops coalesce. */
export const ptyNotifyDelayMs = (acked: TerminalGeometry): number =>
  acked.cols === 0 && acked.rows === 0 ? 0 : PTY_NOTIFY_SETTLE_MS;

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
