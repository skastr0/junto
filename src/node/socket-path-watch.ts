/**
 * A listener whose path no longer names its socket serves no one: the home
 * it was started on was deleted, relinked or replaced, and every client now
 * reaches whatever answers the path. Its core stops, so the home ends with
 * one reachable core, not a lost one beside a new one (remote-verify, VM B).
 */

/** How often a core checks that its socket path still names its socket. */
export const SOCKET_PATH_WATCH_MS = 5_000;

/**
 * Call `lost` once, the first time `owned` answers false. A check that
 * throws is not a loss: only a path that is gone or names another inode is.
 * Answers the stop; the timer never keeps a process alive.
 */
export const watchSocketPathOwned = (
  owned: () => boolean,
  lost: () => void,
  intervalMs: number = SOCKET_PATH_WATCH_MS,
): (() => void) => {
  let done = false;
  const timer = setInterval(() => {
    if (done) return;
    let still: boolean;
    try {
      still = owned();
    } catch {
      return;
    }
    if (still) return;
    done = true;
    clearInterval(timer);
    lost();
  }, intervalMs);
  timer.unref();
  return () => {
    done = true;
    clearInterval(timer);
  };
};
