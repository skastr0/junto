/**
 * An E2E run must never reach the operator's app: not its home, not its
 * sockets, not its credential, and not a real agent binary. That was left to
 * each spec's discipline until a spec spread `...process.env` into a launch and
 * a test app inherited the live home, socket and token.
 *
 * So the app checks itself, fail-closed, at boot (`enforceE2eSandboxAtBoot`) and
 * again where a seat's harness is resolved (`e2eHarnessRefusal`). This module is
 * the pure half: given an environment and the real account home, it names the
 * violation or says nothing. The caller prints and exits; nothing here throws
 * at import, touches a file, or reads a clock.
 *
 * The real home comes from `os.userInfo().homedir`, never `$HOME`: the harness
 * overrides HOME on purpose, and a check that asked HOME where home is would
 * pass itself.
 */
import { isAbsolute, resolve, sep } from "node:path";

/** The harness marker. Only `1` counts as an E2E run. */
export const E2E_ENV = "JUNTO_E2E";

/**
 * The sandbox's own bin dirs, colon separated, set by the harness
 * (`e2e/harness/launch-env.ts`). A seat resolves its harness from here; a real
 * install is somewhere else on purpose.
 */
export const E2E_SANDBOX_PATH_ENV = "JUNTO_E2E_SANDBOX_PATH";

/** The one variable that lets a spec run a real harness binary on purpose. */
export const realHarnessOptInEnv = (harness: string): string =>
  `JUNTO_REAL_${harness.replace(/[^A-Za-z0-9]+/gu, "_").toUpperCase()}_SOCKET`;

/** Which check refused, so a test can name the rule it broke. */
export type E2eSandboxCheck = "junto-home" | "path" | "seat" | "harness";

export interface E2eSandboxRefusal {
  readonly check: E2eSandboxCheck;
  /** One plain sentence naming the path or variable and why it is refused. */
  readonly reason: string;
  /** The offending absolute path, when the refusal is about a path. */
  readonly path?: string;
}

export interface E2eSandboxInput {
  /** The process's own environment. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /** `os.userInfo().homedir`: the account home, not `$HOME`. */
  readonly realHome: string;
  /** Electron's user-data dir, when the caller knows it. */
  readonly userData?: string | undefined;
  /** The Junto home this process resolved, when the caller knows it. */
  readonly juntoHome?: string | undefined;
}

const refused = (check: E2eSandboxCheck, reason: string, path?: string): E2eSandboxRefusal =>
  path === undefined ? { check, reason } : { check, reason, path };

/** A non-empty path value, resolved; anything else is not a path at all. */
const pathValue = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  if (trimmed === undefined || trimmed.length === 0) return undefined;
  if (!isAbsolute(trimmed)) return undefined;
  return resolve(trimmed);
};

/** Equal to `root`, or inside it. Both are already resolved. */
export const underOrEqual = (path: string, root: string): boolean =>
  path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

/** The real account's Junto tree: the one directory a test app never uses. */
export const realJuntoTree = (realHome: string): string => resolve(realHome, ".junto");

/**
 * Every environment variable that names a Junto home or socket. The family is
 * open (`JUNTO_HOME`, `JUNTO_WORK_HOME`, `JUNTO_BROWSER_HOME`,
 * `JUNTO_WORK_SOCKET`, `JUNTO_SOCKET`, and whatever lands next), so match the
 * shape instead of listing names that go stale.
 */
export const juntoPathEnvKeys = (env: Readonly<Record<string, string | undefined>>): readonly string[] =>
  Object.keys(env)
    .filter((key) => /^JUNTO_[A-Z0-9_]*(?:HOME|SOCKET)$/u.test(key))
    .filter((key) => pathValue(env[key]) !== undefined)
    .sort();

/**
 * What only a seat's environment carries: its credential, its seat and node
 * identity, and the socket it reports to. No real launch of Junto has any of
 * them; an app started from inside a seat has all of them, and that app would
 * present the seat's credential and report to the live work socket.
 */
export const SEAT_VARIABLE_KEYS = [
  "JUNTO_WORK_TOKEN",
  "JUNTO_TOKEN",
  "JUNTO_SEAT",
  "JUNTO_NODE_REF",
  "JUNTO_WORK_SOCKET",
  "JUNTO_SOCKET",
] as const;

/**
 * The unconditional boot rule, E2E or not: a Junto process never inherits a
 * seat's identity. This is asked first, because a second app launched from a
 * seat's shell is the case no test-only guard would catch.
 */
export const seatVariableRefusal = (
  env: Readonly<Record<string, string | undefined>>,
): E2eSandboxRefusal | undefined => {
  for (const key of SEAT_VARIABLE_KEYS) {
    if ((env[key] ?? "").trim().length > 0) {
      return refused(
        "seat",
        `this Junto process inherited ${key} from a seat's environment; only an app started from inside a seat carries it, so it refuses to start`,
      );
    }
  }
  return undefined;
};

/**
 * The boot check. `undefined` means the run is safe to start; anything else is
 * the reason the process must print and exit nonzero before it opens the
 * database, a log, a socket or a window.
 *
 * (a) The resolved Junto home, the work home, every `JUNTO_*_HOME` and
 *     `JUNTO_*SOCKET` value, and the user-data dir stay out of the operator's
 *     `~/.junto`. E2E only: an ordinary launch is meant to use the real one.
 * (b) The seat-identity rule above is unconditional, and `bootRefusal` asks it
 *     first.
 */
export const e2eSandboxRefusal = (input: E2eSandboxInput): E2eSandboxRefusal | undefined => {
  const { env } = input;
  if (env[E2E_ENV]?.trim() !== "1") return undefined;

  const realJunto = realJuntoTree(input.realHome);

  // (a) the resolved trees.
  const juntoHome =
    pathValue(input.juntoHome) ??
    pathValue(env.JUNTO_HOME) ??
    pathValue(env.HOME);
  if (juntoHome !== undefined && underOrEqual(resolve(juntoHome, ".junto"), realJunto)) {
    return refused(
      "junto-home",
      `an E2E run resolved its Junto home to ${juntoHome}, which is the operator's real home; a test app never touches ${realJunto}`,
      juntoHome,
    );
  }
  const workHome = pathValue(env.JUNTO_WORK_HOME) ??
    (juntoHome === undefined ? undefined : resolve(juntoHome, ".junto", "work"));
  if (workHome !== undefined && underOrEqual(workHome, realJunto)) {
    return refused(
      "path",
      `an E2E run was handed JUNTO_WORK_HOME=${workHome}, inside the operator's ${realJunto}; a test app never opens it`,
      workHome,
    );
  }

  // (a) every Junto home and socket the environment names.
  for (const key of juntoPathEnvKeys(env)) {
    const path = pathValue(env[key]);
    if (path === undefined) continue;
    if (underOrEqual(path, realJunto)) {
      return refused(
        "path",
        `an E2E run was handed ${key}=${path}, inside the operator's ${realJunto}; a test app never opens it`,
        path,
      );
    }
  }

  // (a) the user-data dir, when the caller has one.
  const userData = pathValue(input.userData);
  if (userData !== undefined && underOrEqual(userData, realJunto)) {
    return refused(
      "path",
      `an E2E run's user-data dir is ${userData}, inside the operator's ${realJunto}; a test app never opens it`,
      userData,
    );
  }

  return undefined;
};

/**
 * Everything the boot guard asks, in order: the seat rule first (it holds for
 * every launch), then the E2E-only path rules. `undefined` means start.
 */
export const bootRefusal = (input: E2eSandboxInput): E2eSandboxRefusal | undefined =>
  seatVariableRefusal(input.env) ?? e2eSandboxRefusal(input);

export interface E2eHarnessInput {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The harness a seat asked for (`claude`, `codex`, `hermes`, ...). */
  readonly harness: string;
  /** Where the harness resolved on the seat's PATH. */
  readonly file: string;
  /** `os.userInfo().homedir`: a seat that runs in the real home is not a sandbox. */
  readonly realHome: string;
}

/**
 * (c) A seat in an E2E run launches only a harness inside the sandbox: the
 * sandbox bin dirs the harness names, the launch's temp roots, and a throwaway
 * HOME. A real install (the operator's own `claude`, `codex`, an absolute path
 * into their home) is refused, because a test that starts a real agent spends
 * the operator's account and can reach the real machine. The real home stays
 * excluded even when a spec points HOME at it on purpose, which two opt-in
 * specs do so a real harness finds its own login.
 *
 * A spec that needs the real binary says so by name for that harness:
 * `JUNTO_REAL_CODEX_SOCKET=1`, the opt-in the real-Codex spec already uses.
 */
export const e2eHarnessRefusal = (input: E2eHarnessInput): E2eSandboxRefusal | undefined => {
  const { env } = input;
  if (env[E2E_ENV]?.trim() !== "1") return undefined;
  if (env[realHarnessOptInEnv(input.harness)]?.trim() === "1") return undefined;

  const file = pathValue(input.file);
  if (file === undefined) {
    // A bare name that never resolved cannot run; the caller's own missing
    // binary refusal owns that, and refusing here would double-report it.
    return undefined;
  }
  const realHome = pathValue(input.realHome);
  const home = pathValue(env.HOME);
  const sandboxHome =
    home !== undefined && (realHome === undefined || !underOrEqual(home, realHome))
      ? home
      : undefined;
  const roots = [
    sandboxHome,
    pathValue(env.TMPDIR),
    pathValue(env.TMP),
    pathValue(env.TEMP),
    ...(env[E2E_SANDBOX_PATH_ENV] ?? "")
      .split(":")
      .map((entry) => pathValue(entry)),
  ].filter((root): root is string => root !== undefined);
  if (roots.some((root) => underOrEqual(file, root))) return undefined;

  return refused(
    "harness",
    `a seat tried to launch ${input.harness} from ${file}, which is outside this E2E run's sandbox; a real agent binary needs an explicit opt-in (${realHarnessOptInEnv(input.harness)}=1)`,
    file,
  );
};
