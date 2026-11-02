/**
 * What the core does with a stop signal, kept out of the process entry so a
 * failure can be proven in a test.
 *
 * `core.close()` drains owner commands, seat work, canvas edits, the write
 * gate, the runtime and its service children. A drain that fails must not be
 * reported as a clean stop: the failure is logged as `[core] stop failed:` and
 * the process leaves with 1.
 *
 * Exiting 1 cannot respawn the core mid-quit. Main's restart supervisor keys on
 * its own `stopping` flag, not on the child's exit code
 * (core-process/host.ts: `stop()` sets `stopping = true` before it signals, and
 * the child's exit handler returns early `if (stopping) return;`). During a
 * quit the supervisor is therefore already off, and outside a quit a zero exit
 * would restart the core exactly as a nonzero one does, so the code decides
 * nothing about restarts either way.
 */
export const stopCoreOnSignal = (
  close: () => Promise<void>,
  exit: (code: number) => void = (code) => process.exit(code),
  log: (message: string, error: unknown) => void = (message, error) => console.error(message, error),
): void => {
  void close().then(
    () => exit(0),
    (error: unknown) => {
      // The drain failed: say which step and why, then leave nonzero so a
      // supervisor or a boot harness reads a failed stop, not a clean one.
      log("[core] stop failed:", error);
      exit(1);
    },
  );
};
