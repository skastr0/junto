export type TerminalGeometry = {
  readonly cols: number;
  readonly rows: number;
};

export const UNKNOWN_TERMINAL_GEOMETRY: TerminalGeometry = { cols: 0, rows: 0 };

/**
 * Trailing window before the child is told a new size after a successful first
 * notify. First notify after attach (acked unknown, failCount 0) is immediate.
 * Failed/false notifies back off — never 0ms again just because acked is 0×0.
 */
export const PTY_NOTIFY_SETTLE_MS = 120;

/** Hard stop after this many failed/false child notifies for one desired size. */
export const PTY_NOTIFY_RETRY_CAP = 8;

const PTY_NOTIFY_BACKOFF_MS = [120, 250, 500, 1000, 2000] as const;

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

/**
 * First SIGWINCH after attach is immediate; later pin/focus hops coalesce;
 * hop-down retries back off from failCount, never 0ms once a notify has failed.
 */
export const ptyNotifyDelayMs = (
  acked: TerminalGeometry,
  failCount = 0,
): number => {
  if (failCount <= 0) {
    return acked.cols === 0 && acked.rows === 0 ? 0 : PTY_NOTIFY_SETTLE_MS;
  }
  const index = Math.min(failCount - 1, PTY_NOTIFY_BACKOFF_MS.length - 1);
  return PTY_NOTIFY_BACKOFF_MS[index]!;
};

export const ptyNotifyShouldRetry = (failCount: number): boolean =>
  failCount < PTY_NOTIFY_RETRY_CAP;

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
