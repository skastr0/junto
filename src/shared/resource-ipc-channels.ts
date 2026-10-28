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
    pending: "junto:resource-task-pending",
    changed: "junto:resource-task-changed",
  },
  artifact: {
    list: "junto:resource-artifact-list",
    history: "junto:resource-artifact-history",
    body: "junto:resource-artifact-body",
    apply: "junto:resource-artifact-apply",
    pending: "junto:resource-artifact-pending",
    labelColours: "junto:resource-artifact-label-colours",
    colour: "junto:resource-artifact-colour",
    changed: "junto:resource-artifact-changed",
  },
  thread: {
    list: "junto:resource-thread-list",
    post: "junto:resource-thread-post",
    changed: "junto:resource-thread-changed",
  },
} as const;

/** The resource kinds that change: a thread changes with its task or artifact. */
export type ResourceIpcDomain = Exclude<keyof typeof RESOURCE_IPC_CHANNELS, "thread">;
