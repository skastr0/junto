import { constants, existsSync, statSync } from "node:fs";

/**
 * Fixed system executable discovery. These candidates are product policy, not
 * caller input: Linux and macOS place the procps/BSD `ps` binary here.
 */
const PS_CANDIDATES = process.platform === "darwin"
  ? ["/bin/ps", "/usr/bin/ps"]
  : process.platform === "linux"
    ? ["/usr/bin/ps", "/bin/ps"]
    : [];

const executableFile = (path: string): boolean => {
  try {
    return existsSync(path) && statSync(path).isFile() &&
      (statSync(path).mode & constants.S_IXUSR) !== 0;
  } catch {
    return false;
  }
};

/** Undefined is a diagnostic failure; never fall back to PATH resolution. */
export const resolveSystemPs = (): string | undefined =>
  PS_CANDIDATES.find(executableFile);

/** Exported for focused platform-policy tests without exposing mutable state. */
export const systemPsCandidates = (): readonly string[] => [...PS_CANDIDATES];
