/**
 * How long each step of putting Junto on another machine may take, and the
 * command bounds derived from them (docs/machines.md, "Every wait is bounded").
 * A command's bound is the sum of the steps it can run, plus a margin, so no
 * outer timeout fires while an inner step is still inside its own limit and
 * the step that ran out is the one that says so. The window waits a minute
 * past the core, so the core's answer, timed out or not, always arrives.
 * `tests/machine-command-bounds.test.ts` holds the order.
 */

/** Downloading the machine bundle for the far end's platform. */
export const MACHINE_BUNDLE_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
/**
 * Packing that bundle into the archive Send copies. It needs about 5 s of
 * CPU, and took 1 min 47 s of wall on a Mac at load 394 (remote-verify,
 * 2026-11-23), so it is sized for a loaded machine, not an idle one.
 */
export const MACHINE_ARCHIVE_TIMEOUT_MS = 10 * 60_000;
/** Copying the archive and installing it on the far end, over SSH. */
export const MACHINE_TRANSFER_TIMEOUT_MS = 20 * 60_000;
/** A Boat sandbox that is falling asleep, until it is asleep and can be woken. */
export const MACHINE_BOAT_ASLEEP_WAIT_MS = 90_000;
/** A Boat sandbox that is waking, until it is awake. */
export const MACHINE_BOAT_AWAKE_WAIT_MS = 150_000;
/**
 * A woken Boat machine's core, until its link answers. A wake for a seat or
 * for mail waits for it; an install does not, since the core it would wait
 * for is the one the install replaces.
 */
export const MACHINE_BOAT_CORE_WAIT_MS = 120_000;
/** What a command spends outside its steps: SSH setup, preflight, the answer. */
export const MACHINE_INSTALL_MARGIN_MS = 2 * 60_000;

/** `machine.send`, `machine.update` and `machine.boat-add`: wake, download, pack, copy, install. */
export const MACHINE_INSTALL_COMMAND_TIMEOUT_MS =
  MACHINE_BOAT_ASLEEP_WAIT_MS + MACHINE_BOAT_AWAKE_WAIT_MS + MACHINE_BUNDLE_DOWNLOAD_TIMEOUT_MS +
  MACHINE_ARCHIVE_TIMEOUT_MS + MACHINE_TRANSFER_TIMEOUT_MS + MACHINE_INSTALL_MARGIN_MS;

/** The machine commands that install Junto, and take the install bound. */
export const MACHINE_INSTALL_COMMANDS = ["machine.send", "machine.update", "machine.boat-add"] as const;

/** How long the window waits for any machine command: a minute past the longest core bound. */
export const MACHINE_COMMAND_WINDOW_TIMEOUT_MS = MACHINE_INSTALL_COMMAND_TIMEOUT_MS + 60_000;
