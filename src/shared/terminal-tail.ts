/**
 * Terminal tail — a few most-recent plain-text lines from a managed native
 * PTY, broadcast for node-card preview. Not the full buffer (see AttachScreen
 * in src/main/vellum/term/observer/types.ts); this is a small, coalesced
 * projection meant to be shown small and quiet on the canvas node itself.
 */

export type TerminalTailEvent = {
  readonly bindingId: string;
  readonly epoch: string;
  /** Bottom-most lines, trimmed of trailing blank lines, oldest→newest. */
  readonly lines: readonly string[];
  readonly at: number;
};
