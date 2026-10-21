/**
 * The resource IPC channel names (`resource-ipc.ts`), apart from the
 * contract's schemas so the sandboxed preload can import them: no Effect is
 * reached from here.
 */
export const RESOURCE_IPC_CHANNELS = {
  task: {
    list: "junto:resource-task-list",
    all: "junto:resource-task-all",
    context: "junto:resource-task-context",
    apply: "junto:resource-task-apply",
    changed: "junto:resource-task-changed",
  },
  artifact: {
    list: "junto:resource-artifact-list",
    history: "junto:resource-artifact-history",
    body: "junto:resource-artifact-body",
    apply: "junto:resource-artifact-apply",
    changed: "junto:resource-artifact-changed",
  },
} as const;

export type ResourceIpcDomain = keyof typeof RESOURCE_IPC_CHANNELS;
