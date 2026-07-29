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
