/**
 * The operator threads IPC channel names (Global threads: the operator's
 * threads across every seat of a canvas), apart from the schemas so the
 * sandboxed preload can import them: no Effect is reached from here. The
 * shapes are `src/shared/operator-threads.ts`.
 */
export const OPERATOR_THREADS_IPC_CHANNELS = {
  /** One page of the operator's threads across every seat. */
  list: "junto:operator-threads-list",
  /** Start pushes of the rows a filter holds as they change; answers the watch's id. */
  watch: "junto:operator-threads-watch",
  /** Stop a watch; a window that closes stops its own. */
  unwatch: "junto:operator-threads-unwatch",
  /** Main → renderer: the rows that changed under one watch. */
  changed: "junto:operator-threads-changed",
} as const;
