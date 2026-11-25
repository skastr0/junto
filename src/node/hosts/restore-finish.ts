/**
 * The core's boot step after it takes the home lock and before it reads the
 * database: `junto machine restore-finish` (native/cli/src/install/mod.rs)
 * finishes a restore an install left owed. The core's lock covers the child,
 * which takes only the install lock, and only when a marker is there; the
 * lock is close-on-exec, so the child does not inherit it.
 *
 * Only the exit code is read: 0 nothing was owed or it finished, 75 an install
 * holds this home, anything else the restore refused. Its words go to the
 * core's own output, where the service log keeps them; nothing is parsed.
 * JUNTO_HOME and JUNTO_INSTALL_ROOT are always set from this core, never left
 * to the child's defaults, which need not agree with the install's.
 */
import { spawn } from "node:child_process";

export type RestoreFinishOutcome = "ready" | "updating" | "refused";

export type RestoreFinishInput = Readonly<{
  /** The bundle's native CLI, `<generation>/bin/junto`. */
  junto: string;
  home: string;
  installRoot: string;
  /** The environment the child starts from; this core's own by default. */
  env?: NodeJS.ProcessEnv;
}>;

export const RESTORE_FINISH_UPDATING_EXIT = 75;

/** Run restore-finish once and say what its exit means for this boot. */
export const runRestoreFinish = (input: RestoreFinishInput): Promise<RestoreFinishOutcome> =>
  new Promise((resolve) => {
    const child = spawn(input.junto, ["machine", "restore-finish"], {
      env: { ...(input.env ?? process.env), JUNTO_HOME: input.home, JUNTO_INSTALL_ROOT: input.installRoot },
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.once("error", (cause) => {
      console.error("[core] junto machine restore-finish could not start", cause);
      resolve("refused");
    });
    child.once("exit", (code) => {
      resolve(code === 0 ? "ready" : code === RESTORE_FINISH_UPDATING_EXIT ? "updating" : "refused");
    });
  });
