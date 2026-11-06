/**
 * What the core does with a stop signal, kept out of the process entry so a
 * failure can be proven in a test.
 *
 * `core.close()` drains owner commands, seat work, canvas edits, the write
 * gate, the runtime and its service children; `closeCoreProcess` then drains
 * the process's own plane. A drain that fails must not be
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
import {
  appProcessBlocksAppExit,
  appProcessPlane,
  describeAppProcessStraggler,
  type AppProcessPlane,
} from "../junto/app-process-plane";
import { runStopSteps } from "../stop-scope";

/**
 * The core process's own children (adapter CLIs, store tools, the login shell
 * read) live on this process's plane, which main's quit cannot reach. A
 * process entry drains it once the core has closed, never `startCore`'s
 * close: the drain shuts the plane to new spawns for the rest of the process.
 * Only an adapter CLI whose ownership could not be verified may stay behind;
 * any other straggler fails the stop.
 */
export const drainCoreProcessPlane = async (plane: Pick<AppProcessPlane, "drainOnQuit"> = appProcessPlane): Promise<void> => {
  const receipt = await plane.drainOnQuit();
  if (receipt.clean) return;
  const retained = receipt.stragglers.map(describeAppProcessStraggler).join("; ");
  if (!appProcessBlocksAppExit(receipt.stragglers)) {
    console.error(`[core] stop continues with unsignalable read-only retention: ${retained}`);
    return;
  }
  throw new Error(`core process plane retained ${receipt.stragglers.length} child generation(s): ${retained}`);
};

/** Close the core, then drain its plane; the drain runs even when the close failed. */
export const closeCoreProcess = (close: () => Promise<void>): Promise<void> =>
  runStopSteps([close, () => drainCoreProcessPlane()]);

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
