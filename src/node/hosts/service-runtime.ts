import { closeSync, constants, fstatSync, ftruncateSync, openSync, readSync, writeFileSync } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Log } from "../observability/logger";

/**
 * The windowless core's service-runtime files: where its install lives, the
 * bounded stderr its service manager appends to, and its boot history. A core
 * started outside a machine bundle (a dev run) has no install root and skips
 * every step here.
 */

/** The install root a bundled core runs from: `<root>/current/core/junto.cjs` or a builds generation. */
export const serviceInstallRoot = (entry: string): string | undefined => {
  const match = /^(.*)\/(?:current|builds\/[0-9a-f]{64}-(?:darwin-arm64|linux-x64))\/core\/junto\.cjs$/.exec(entry);
  return match?.[1];
};

const ownUid = (): number | undefined => process.getuid?.();

/**
 * The tail of a service file, only when it is a regular file this uid owns.
 * O_NOFOLLOW refuses a planted link at open time; anything else is absent.
 */
export const readServiceFileTail = (path: string, maxBytes: number): Buffer | undefined => {
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== ownUid()) return undefined;
      const count = Math.min(stat.size, maxBytes);
      const buffer = Buffer.alloc(count);
      readSync(fd, buffer, 0, count, stat.size - count);
      return buffer;
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
};

/** Empties a service file this uid owns; false when it is absent, linked, or foreign. */
export const truncateServiceFile = (path: string): boolean => {
  try {
    const fd = openSync(path, constants.O_WRONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.uid !== ownUid()) return false;
      ftruncateSync(fd, 0);
      return true;
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
};

export const SERVICE_BOOT_HISTORY = 8;

/**
 * Appends this boot's epoch-ms to the boot history and returns the last
 * SERVICE_BOOT_HISTORY times, oldest first. The file is 0600 under the
 * install's own logs directory.
 */
export const bumpServiceBoots = (path: string, now: number): readonly number[] => {
  let prior: number[] = [];
  try {
    prior = readFileSync(path, "utf8")
      .split("\n")
      .map(line => Number(line.trim()))
      .filter(value => Number.isSafeInteger(value) && value > 0);
  } catch {
    // First boot, or an unreadable history: start empty rather than fail the boot.
  }
  const boots = [...prior, now].slice(-SERVICE_BOOT_HISTORY);
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    ftruncateSync(fd, 0);
    writeFileSync(fd, `${boots.join("\n")}\n`);
  } finally {
    closeSync(fd);
  }
  return boots;
};

/**
 * The post-lease boot record, best-effort throughout: the previous boot's
 * stderr tail becomes a log row while this core's credentials are already
 * registered for the scrub, the service stderr file is emptied so it cannot
 * grow without limit, and the boot history gains this boot. Nothing here may
 * stop a core that already holds the lease.
 */
export const recordServiceBoot = (log: Log, installRoot: string, previousStderr: Buffer | undefined): void => {
  try {
    const stderrLog = join(installRoot, "logs", "stderr.log");
    if (previousStderr !== undefined && previousStderr.length > 0) {
      const tail = previousStderr.toString("utf8").trimEnd().slice(-900);
      try {
        log.writeLog({ level: "warn", source: "system", message: `Junto core previous service stderr:\n${tail}` });
      } catch {
        try {
          log.writeLog({ level: "warn", source: "system", message: `Junto core previous service stderr (${previousStderr.length} bytes)` });
        } catch { /* the row is best-effort */ }
      }
    }
    truncateServiceFile(stderrLog);
    const boots = bumpServiceBoots(join(installRoot, "logs", "core-boots"), Date.now());
    log.writeLog({ level: "info", source: "system", message: "Junto core boot", annotations: { coreBoots: boots.length, coreBootTimes: boots } });
  } catch {
    // Service diagnostics never stop a healthy core.
  }
};

/**
 * A crash is a row, then exit: writeLog reaches the file synchronously, so
 * the reason is on disk before the process goes.
 */
export const serviceCrashExit = (log: Log, kind: string, cause: unknown): void => {
  try {
    log.writeLog({ level: "error", source: "system", message: `Junto core crashed: ${kind}`, failure: cause });
  } catch {
    // The exit matters more than the row.
  }
  process.exitCode = 1;
  process.exit();
};

/**
 * Headless only; the app core's crash is main's to report. Returns the
 * uninstall for tests.
 */
export const installServiceCrashLog = (log: Log): (() => void) => {
  const uncaught = (cause: unknown): void => serviceCrashExit(log, "uncaught exception", cause);
  const rejection = (cause: unknown): void => serviceCrashExit(log, "unhandled rejection", cause);
  process.on("uncaughtException", uncaught);
  process.on("unhandledRejection", rejection);
  return () => {
    process.off("uncaughtException", uncaught);
    process.off("unhandledRejection", rejection);
  };
};
