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
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { appProcessPlane } from "../app-process-plane";

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

/** Run restore-finish once, as a child the process plane owns, and say what its exit means for this boot. */
export const runRestoreFinish = (input: RestoreFinishInput): Promise<RestoreFinishOutcome> =>
  new Promise((resolve) => {
    let io;
    try {
      io = appProcessPlane.spawnChild({
        source: "core.restore-finish",
        purpose: "finish a restore an install left owed, before the core reads its database",
        command: input.junto,
        args: ["machine", "restore-finish"],
        env: { ...(input.env ?? process.env), JUNTO_HOME: input.home, JUNTO_INSTALL_ROOT: input.installRoot },
      }).io;
    } catch (cause) {
      console.error("[core] junto machine restore-finish could not start", cause);
      resolve("refused");
      return;
    }
    io.stdin.end();
    io.stdout.pipe(process.stdout, { end: false });
    io.stderr.pipe(process.stderr, { end: false });
    io.onError((cause) => {
      console.error("[core] junto machine restore-finish could not start", cause);
      resolve("refused");
    });
    void io.exited.then(({ code }) => {
      resolve(code === 0 ? "ready" : code === RESTORE_FINISH_UPDATING_EXIT ? "updating" : "refused");
    });
  });

/** The install's marker name, `.restore-<uuid>.marker` (native/cli/src/install/restore.rs marker_of, is_uuid). */
const RESTORE_MARKER = /^\.restore-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.marker$/u;

/**
 * The marker an install left in `home`'s state directory when a restore is
 * owed, if one is there. A core with no install root (the desktop app, a dev
 * run, an unpacked bundle) cannot finish the restore, so it must not open the
 * database past one. A state directory it cannot read counts as owing one.
 */
export const owedRestoreMarker = (home: string): string | undefined => {
  const state = join(home, ".junto", "state");
  let entries: string[];
  try {
    entries = readdirSync(state);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return state;
  }
  const marker = entries.find((entry) => RESTORE_MARKER.test(entry));
  return marker === undefined ? undefined : join(state, marker);
};
