/**
 * Product surface gate for the ACP chat UI.
 *
 * The chat surface and the ACP transport are kept, not deleted — they are
 * unshipped product. This only hides the UI entry points (toolbar, kind strip,
 * double-click open) so the managed terminal stays the one agent work surface.
 */
export const ACP_CHAT_SURFACE_HIDDEN = true as const;
