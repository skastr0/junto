/**
 * The backlinks IPC channel names (`mention-ipc.ts`), apart from the
 * contract's schemas so the sandboxed preload can import them: no Effect is
 * reached from here.
 */
export const MENTION_IPC_CHANNELS = {
  list: "junto:mention-list",
  changed: "junto:mention-changed",
} as const;
