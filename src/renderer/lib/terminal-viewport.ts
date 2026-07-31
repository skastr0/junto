/**
 * Viewport position bookmarks for terminal pin/unpin remounts.
 *
 * Pinning destroys the renderer xterm and creates another one. Serialized
 * replay restores contents/modes, but not the public buffer viewport — without
 * this, reviewing older output jumps back to the bottom after pin/unpin.
 *
 * Never restore across a changed session epoch.
 */

export type TerminalViewportBookmark = {
  readonly epoch: string;
  readonly viewportY: number;
  readonly wasAtBottom: boolean;
};

const bookmarks = new Map<string, TerminalViewportBookmark>();

/** Build a bookmark from xterm buffer fields (pure — unit-testable). */
export function bookmarkFromBuffer(
  epoch: string,
  viewportY: number,
  baseY: number,
): TerminalViewportBookmark {
  return {
    epoch,
    viewportY,
    // Fully scrolled to bottom when viewport top equals baseY.
    wasAtBottom: viewportY >= baseY,
  };
}

/**
 * Resolve how to restore after replay.
 * Returns `"bottom"` when the user was following output; otherwise a clamped line.
 */
export function resolveViewportRestore(
  bookmark: TerminalViewportBookmark,
  baseY: number,
): "bottom" | number {
  if (bookmark.wasAtBottom) return "bottom";
  const maxY = Math.max(0, baseY);
  return Math.max(0, Math.min(bookmark.viewportY, maxY));
}

export function storeTerminalViewport(
  bindingId: string,
  bookmark: TerminalViewportBookmark,
): void {
  if (!bindingId || !bookmark.epoch) return;
  bookmarks.set(bindingId, bookmark);
}

export function takeTerminalViewport(
  bindingId: string,
  epoch: string,
): TerminalViewportBookmark | undefined {
  const saved = bookmarks.get(bindingId);
  if (!saved) return undefined;
  // Consume always — a mismatched epoch must not linger for a later attach.
  bookmarks.delete(bindingId);
  if (saved.epoch !== epoch) return undefined;
  return saved;
}

/** Test helper — clear module state between cases. */
export function clearTerminalViewportBookmarks(): void {
  bookmarks.clear();
}
