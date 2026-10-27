/**
 * The body backlinks IPC channel names (`artifact-links-ipc.ts`), apart from
 * the contract's schemas so the sandboxed preload can import them: no Effect
 * is reached from here.
 */
export const ARTIFACT_LINKS_IPC_CHANNELS = {
  list: "junto:artifact-links-list",
  changed: "junto:artifact-links-changed",
} as const;
