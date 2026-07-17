// ControlMaster socket location + args shared by every ssh invocation that
// talks to a herdr remote host. Split out of masters.ts so hosts.ts (which
// masters.ts itself depends on via sshTargetForHost/HERDR_HOSTS) can stay
// import-cycle-free while still wiring the same control args into its argv.
import { homedir } from "node:os";
import { join } from "node:path";

/** ~/.vellum/ssh — vellum's established config home, not Electron's userData
 * (keeps this module testable without an Electron runtime). */
export const herdrControlDir = (): string => join(homedir(), ".vellum", "ssh");

/**
 * ControlMaster flags for stock OpenSSH connection reuse. %C is an ssh
 * token (hash of host+user+port) — passed literally into argv (no shell,
 * no quoting concerns). ssh creates the socket file but not the parent
 * directory; if it's missing, ssh logs a warning and falls back to a
 * plain (non-multiplexed) connection rather than failing the call —
 * verified via `ssh -o ControlPath=<missing-dir>/cm-%C ...` (exit 0).
 * warmHost() (masters.ts) calls ensureControlDir() so the common case
 * actually gets the reuse win; callers of controlArgs() elsewhere don't
 * need to, since a missing dir only costs the optimization, not correctness.
 */
export const controlArgs = (): string[] => [
  "-o",
  "ControlMaster=auto",
  "-o",
  `ControlPath=${herdrControlDir()}/cm-%C`,
  "-o",
  "ControlPersist=600",
];
