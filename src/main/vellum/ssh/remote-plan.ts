/**
 * Typed remote filesystem plans — the source of truth for remote mutations.
 *
 * Hand-authored shell strings are forbidden at the product boundary. Callers
 * build a closed AST of confined operations (or call a named product compiler);
 * only this module may emit shell, and only for a statically known shape.
 *
 * Doctrine (machine-safety + security-doctrine):
 * - No ambient `rm` / arbitrary executable / free-form path.
 * - Settings paths are branded, absolute, and confined under remote home `.vellum`.
 * - Herdr image staging is confined under the fixed product root
 *   `/tmp/vellum-herdr-images` with product basenames only.
 * - Linux Remote preflight is a fixed named product program (no free paths).
 * - Destructive leaf ops name exact allowlisted basenames only.
 * - Compilation is pure and unit-tested; argv still cross `makeRemoteCommand`.
 */

import { Effect } from "effect";
import { makeRemoteCommand, type RemoteCommand, SshInputError } from "./domain";

// ---------------------------------------------------------------------------
// Confined path brands
// ---------------------------------------------------------------------------

const ConfinedRemotePathTypeId: unique symbol = Symbol("@vellum/ssh/ConfinedRemotePath");

/**
 * Absolute POSIX path proven to live under `<home>/.vellum` (or a named child).
 * Unforgeable at the type level; mint only via `confineUnderVellumHome`.
 */
export interface ConfinedRemotePath {
  readonly [ConfinedRemotePathTypeId]: typeof ConfinedRemotePathTypeId;
  readonly value: string;
}

const pathValues = new WeakMap<ConfinedRemotePath, string>();

/** Basename allowlist for seal invalidation / known durable leaves. */
export const VELLUM_LEAF_BASENAMES = [
  "settings.json",
  "topology.key",
  "topology.seal",
  "hosts.json",
  "hosts.key",
  "hosts.seal",
] as const;
export type VellumLeafBasename = (typeof VELLUM_LEAF_BASENAMES)[number];

const LEAF_SET = new Set<string>(VELLUM_LEAF_BASENAMES);

/** Safe absolute path segment: no shell metacharacters, no `..`, no NULs. */
const SAFE_ABS_PATH =
  /^\/(?:[A-Za-z0-9._+-]+\/)*[A-Za-z0-9._+-]+$/u;

const isSafeAbsPath = (value: string): boolean =>
  SAFE_ABS_PATH.test(value) &&
  !value.includes("..") &&
  !value.includes("\0") &&
  Buffer.byteLength(value, "utf8") <= 512;

/**
 * Admit a remote home (absolute) and return the confined `.vellum` directory.
 * Rejects anything that is not a clean absolute path under the home root.
 */
export const confineVellumDirectory = (
  remoteHome: string,
): Effect.Effect<ConfinedRemotePath, SshInputError> => {
  if (!isSafeAbsPath(remoteHome)) {
    return Effect.fail(
      new SshInputError({
        message: "remote home must be a clean absolute POSIX path",
      }),
    );
  }
  const dir = `${remoteHome}/.vellum`;
  if (!isSafeAbsPath(dir) || !dir.startsWith(`${remoteHome}/`)) {
    return Effect.fail(
      new SshInputError({ message: "remote .vellum path is not confining" }),
    );
  }
  return Effect.succeed(mintPath(dir));
};

/** Child of a confined vellum directory — exact allowlisted basename only. */
export const confineVellumLeaf = (
  directory: ConfinedRemotePath,
  basename: VellumLeafBasename,
): Effect.Effect<ConfinedRemotePath, SshInputError> => {
  if (!LEAF_SET.has(basename)) {
    return Effect.fail(
      new SshInputError({ message: `basename "${basename}" is not an allowlisted vellum leaf` }),
    );
  }
  const parent = inspectPath(directory);
  const path = `${parent}/${basename}`;
  if (!isSafeAbsPath(path) || !path.startsWith(`${parent}/`)) {
    return Effect.fail(
      new SshInputError({ message: "vellum leaf path is not confining" }),
    );
  }
  return Effect.succeed(mintPath(path));
};

const mintPath = (value: string): ConfinedRemotePath => {
  const handle = Object.freeze({
    [ConfinedRemotePathTypeId]: ConfinedRemotePathTypeId,
    value,
  }) as ConfinedRemotePath;
  pathValues.set(handle, value);
  return handle;
};

export const inspectPath = (path: ConfinedRemotePath): string => {
  const value = pathValues.get(path);
  if (value === undefined || value !== path.value) {
    throw new TypeError("ConfinedRemotePath was not minted by remote-plan");
  }
  return value;
};

// ---------------------------------------------------------------------------
// Plan AST — closed operation set
// ---------------------------------------------------------------------------

export type RemotePlanStep =
  | { readonly op: "setUmask"; readonly mode: 0o077 }
  | { readonly op: "ensureDirectory"; readonly path: ConfinedRemotePath }
  | { readonly op: "refuseIfSymlink"; readonly path: ConfinedRemotePath; readonly code: number }
  | {
      readonly op: "refuseIfExistsNotRegularFile";
      readonly path: ConfinedRemotePath;
      readonly code: number;
    }
  | {
      readonly op: "removeExactLeaves";
      readonly directory: ConfinedRemotePath;
      readonly basenames: readonly VellumLeafBasename[];
    }
  | {
      readonly op: "writeStdinAtomic";
      readonly path: ConfinedRemotePath;
      readonly mode: 0o600;
      /** Temp suffix must be a fixed product token (no `$`, no user input). */
      readonly tempSuffix: "vellum-configure";
    };

export type RemotePlan = {
  readonly name: string;
  readonly steps: ReadonlyArray<RemotePlanStep>;
};

// ---------------------------------------------------------------------------
// Named product plans (only these may be compiled for production use)
// ---------------------------------------------------------------------------

/**
 * Install sealed Remote station settings under `~/.vellum/settings.json`.
 *
 * Order (interrupt-safe, fail-closed):
 * 1. atomic write settings via exclusive temp + rename
 * 2. invalidate topology seals only after settings write succeeds
 *
 * Never delete seals before the settings postcondition — a failed write must
 * leave prior seal material intact so the next boot cannot bootstrap a mint.
 */
export const remoteStationSettingsInstallPlan = (
  vellumDir: ConfinedRemotePath,
  settingsPath: ConfinedRemotePath,
): RemotePlan =>
  Object.freeze({
    name: "remote-station-settings-install",
    steps: Object.freeze([
      { op: "setUmask", mode: 0o077 },
      { op: "ensureDirectory", path: vellumDir },
      { op: "refuseIfSymlink", path: settingsPath, code: 73 },
      { op: "refuseIfExistsNotRegularFile", path: settingsPath, code: 73 },
      {
        op: "writeStdinAtomic",
        path: settingsPath,
        mode: 0o600,
        tempSuffix: "vellum-configure",
      },
      {
        op: "removeExactLeaves",
        directory: vellumDir,
        basenames: Object.freeze(["topology.key", "topology.seal"] as const),
      },
    ] satisfies RemotePlanStep[]),
  });

// ---------------------------------------------------------------------------
// Compiler — sole emitter of remote shell text
// ---------------------------------------------------------------------------

const shellSingleQuote = (value: string): string =>
  `'${value.replace(/'/g, `'\\''`)}'`;

const compileStep = (step: RemotePlanStep): string => {
  switch (step.op) {
    case "setUmask":
      return `umask ${step.mode.toString(8).padStart(3, "0")}`;
    case "ensureDirectory": {
      const p = shellSingleQuote(inspectPath(step.path));
      return [
        `if [ -L ${p} ]; then printf '%s\\n' 'vellum-remote-plan: directory is a symlink' >&2; exit 73; fi`,
        `/bin/mkdir -p -- ${p}`,
        `if [ -L ${p} ] || [ ! -d ${p} ]; then printf '%s\\n' 'vellum-remote-plan: directory unsafe' >&2; exit 73; fi`,
      ].join("\n");
    }
    case "refuseIfSymlink": {
      const p = shellSingleQuote(inspectPath(step.path));
      return `if [ -L ${p} ]; then printf '%s\\n' 'vellum-remote-plan: path is a symlink' >&2; exit ${step.code}; fi`;
    }
    case "refuseIfExistsNotRegularFile": {
      const p = shellSingleQuote(inspectPath(step.path));
      return `if [ -e ${p} ] && [ ! -f ${p} ]; then printf '%s\\n' 'vellum-remote-plan: path is not a regular file' >&2; exit ${step.code}; fi`;
    }
    case "removeExactLeaves": {
      const dir = inspectPath(step.directory);
      const lines: string[] = [];
      for (const base of step.basenames) {
        if (!LEAF_SET.has(base)) {
          throw new TypeError(`removeExactLeaves: basename not allowlisted: ${base}`);
        }
        const leaf = shellSingleQuote(`${dir}/${base}`);
        // -f: missing is fine; never recursive; never globs.
        lines.push(`/bin/rm -f -- ${leaf}`);
      }
      return lines.join("\n");
    }
    case "writeStdinAtomic": {
      const path = inspectPath(step.path);
      const quoted = shellSingleQuote(path);
      // Fixed product suffix only — never interpolate PID into a shell word from TS user data.
      // $$ is the remote shell's own pid for uniqueness under the confined parent.
      const tmp = shellSingleQuote(`${path}.${step.tempSuffix}`);
      const mode = step.mode.toString(8).padStart(3, "0");
      return [
        `tmp=${tmp}.$$`,
        `if [ -e "$tmp" ] || [ -L "$tmp" ]; then printf '%s\\n' 'vellum-remote-plan: temp path busy' >&2; exit 73; fi`,
        // Exclusive create via noclobber when available; still confined under parent path.
        `set -C`,
        `cat > "$tmp" || { set +C; /bin/rm -f -- "$tmp"; exit 73; }`,
        `set +C`,
        `/bin/chmod ${mode} -- "$tmp" || { /bin/rm -f -- "$tmp"; exit 73; }`,
        `/bin/mv -f -- "$tmp" ${quoted} || { /bin/rm -f -- "$tmp"; exit 73; }`,
        `/bin/chmod ${mode} -- ${quoted}`,
      ].join("\n");
    }
    default: {
      const _exhaustive: never = step;
      throw new TypeError(`unknown remote plan step: ${JSON.stringify(_exhaustive)}`);
    }
  }
};

/** Pure compile: plan AST → shell source. Throws on malformed plan (type system should prevent). */
export const compileRemotePlanSource = (plan: RemotePlan): string => {
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(plan.name)) {
    throw new TypeError("remote plan name must be a short product slug");
  }
  if (plan.steps.length === 0 || plan.steps.length > 32) {
    throw new TypeError("remote plan step count out of bounds");
  }
  const body = plan.steps.map(compileStep).join("\n");
  return `set -eu\n${body}\n`;
};

/**
 * Compile a product plan into a branded RemoteCommand (`/bin/sh -c <source>`).
 * Argv still passes makeRemoteCommand bounds (null, size, executable).
 */
export const compileRemotePlan = (
  plan: RemotePlan,
): Effect.Effect<RemoteCommand, SshInputError> => {
  let source: string;
  try {
    source = compileRemotePlanSource(plan);
  } catch (error) {
    return Effect.fail(
      new SshInputError({
        message: error instanceof Error ? error.message : "remote plan compile failed",
      }),
    );
  }
  return makeRemoteCommand("/bin/sh", ["-c", source, `vellum-plan:${plan.name}`]);
};

/** Test/audit helper: list every concrete path a plan will touch. */
export const remotePlanPathFootprint = (plan: RemotePlan): ReadonlyArray<string> => {
  const paths = new Set<string>();
  for (const step of plan.steps) {
    switch (step.op) {
      case "setUmask":
        break;
      case "ensureDirectory":
      case "refuseIfSymlink":
      case "refuseIfExistsNotRegularFile":
      case "writeStdinAtomic":
        paths.add(inspectPath(step.path));
        break;
      case "removeExactLeaves": {
        const dir = inspectPath(step.directory);
        for (const base of step.basenames) paths.add(`${dir}/${base}`);
        break;
      }
      default: {
        const _exhaustive: never = step;
        throw new TypeError(String(_exhaustive));
      }
    }
  }
  return [...paths].sort();
};

// ---------------------------------------------------------------------------
// Named transactional programs (settings snapshot / stamp / restore)
// ---------------------------------------------------------------------------
//
// These are larger protocols (stdin frames + compare-and-swap). They are still
// typed: only ConfinedRemotePath + bounded numeric limit are inputs. No free
// string paths. Shell is an implementation detail of the compiler only.

const assertByteLimit = (limit: number): number => {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 16 * 1024 * 1024) {
    throw new TypeError("settings byte limit out of bounds");
  }
  return limit;
};

/** Snapshot remote settings.json: ABSENT or PRESENT mode size + base64 body. */
export const compileRemoteSettingsSnapshot = (
  vellumDir: ConfinedRemotePath,
  settingsPath: ConfinedRemotePath,
  maxBytes: number,
): Effect.Effect<RemoteCommand, SshInputError> => {
  try {
    const limit = assertByteLimit(maxBytes);
    const dir = shellSingleQuote(inspectPath(vellumDir));
    const settings = shellSingleQuote(inspectPath(settingsPath));
    const source = [
      "set -eu",
      `DIR=${dir}`,
      `SETTINGS=${settings}`,
      `LIMIT=${limit}`,
      'if [ -L "$DIR" ]; then printf \'%s\\n\' \'SETTINGS_DIR_IS_SYMLINK\' >&2; exit 11; fi',
      'if [ ! -e "$SETTINGS" ] && [ ! -L "$SETTINGS" ]; then /usr/bin/printf \'ABSENT\\n\'; exit 0; fi',
      'if [ -L "$SETTINGS" ] || [ ! -f "$SETTINGS" ]; then printf \'%s\\n\' \'SETTINGS_PATH_NOT_REGULAR\' >&2; exit 12; fi',
      "MODE=\"$(/usr/bin/stat -f '%Lp' \"$SETTINGS\" 2>/dev/null || /usr/bin/stat -c '%a' \"$SETTINGS\" 2>/dev/null)\"",
      "case \"$MODE\" in",
      "  [0-7][0-7][0-7]|[0-7][0-7][0-7][0-7]) ;;",
      "  *) printf '%s\\n' 'SETTINGS_MODE_UNREADABLE' >&2; exit 13 ;;",
      "esac",
      "BYTES=\"$(/usr/bin/wc -c < \"$SETTINGS\" | /usr/bin/tr -d ' ')\"",
      "case \"$BYTES\" in",
      "  ''|*[!0-9]*) printf '%s\\n' 'SETTINGS_SIZE_UNREADABLE' >&2; exit 13 ;;",
      "esac",
      'if [ "$BYTES" -gt "$LIMIT" ]; then printf \'%s\\n\' \'SETTINGS_TOO_LARGE\' >&2; exit 14; fi',
      "/usr/bin/printf 'PRESENT %s %s\\n' \"$MODE\" \"$BYTES\"",
      '/usr/bin/base64 < "$SETTINGS"',
      "",
    ].join("\n");
    return makeRemoteCommand("/bin/sh", [
      "-c",
      source,
      "vellum-plan:remote-settings-snapshot",
    ]);
  } catch (error) {
    return Effect.fail(
      new SshInputError({
        message: error instanceof Error ? error.message : "snapshot compile failed",
      }),
    );
  }
};

/**
 * Stamp settings via framed stdin (vellum-settings-stamp-v1).
 *
 * Order (fail-closed): validate CAS preimage → atomic write settings → THEN
 * invalidate topology seals. Failed CAS (exit 34) must leave seals intact so
 * a later boot cannot bootstrap mint authority over an unstamped role.
 */
export const compileRemoteSettingsStamp = (
  vellumDir: ConfinedRemotePath,
  settingsPath: ConfinedRemotePath,
  maxBytes: number,
): Effect.Effect<RemoteCommand, SshInputError> => {
  try {
    const limit = assertByteLimit(maxBytes);
    const dir = shellSingleQuote(inspectPath(vellumDir));
    const settings = shellSingleQuote(inspectPath(settingsPath));
    const topologyKey = shellSingleQuote(
      `${inspectPath(vellumDir)}/topology.key`,
    );
    const topologySeal = shellSingleQuote(
      `${inspectPath(vellumDir)}/topology.seal`,
    );
    const source = [
      "set -eu",
      `DIR=${dir}`,
      `SETTINGS=${settings}`,
      `LIMIT=${limit}`,
      "IFS= read -r FRAME_VERSION",
      "IFS= read -r EXPECTED_KIND",
      "IFS= read -r EXPECTED_MODE",
      "IFS= read -r EXPECTED_SIZE",
      "IFS= read -r NEXT_MODE",
      "IFS= read -r NEXT_SIZE",
      '[ "$FRAME_VERSION" = "vellum-settings-stamp-v1" ] || exit 32',
      'case "$EXPECTED_KIND" in PRESENT|ABSENT) ;; *) exit 32 ;; esac',
      'case "$EXPECTED_MODE:$NEXT_MODE" in',
      "  [0-7][0-7][0-7]:[0-7][0-7][0-7]|[0-7][0-7][0-7][0-7]:[0-7][0-7][0-7]|[0-7][0-7][0-7]:[0-7][0-7][0-7][0-7]|[0-7][0-7][0-7][0-7]:[0-7][0-7][0-7][0-7]) ;;",
      "  *) exit 32 ;;",
      "esac",
      'case "$EXPECTED_SIZE:$NEXT_SIZE" in',
      "  *[!0-9:]*|:*|*:) exit 32 ;;",
      "esac",
      '[ "$EXPECTED_SIZE" -le "$LIMIT" ] && [ "$NEXT_SIZE" -le "$LIMIT" ] || exit 32',
      'if [ -L "$DIR" ]; then printf \'%s\\n\' \'SETTINGS_DIR_UNSAFE\' >&2; exit 33; fi',
      '/bin/mkdir -p -- "$DIR"',
      'if [ -L "$DIR" ] || [ ! -d "$DIR" ]; then printf \'%s\\n\' \'SETTINGS_DIR_UNSAFE\' >&2; exit 33; fi',
      'EXPECTED_TMP="$(/usr/bin/mktemp "$SETTINGS.stamp-expected.XXXXXX")"',
      'NEXT_TMP="$(/usr/bin/mktemp "$SETTINGS.stamp-next.XXXXXX")"',
      "cleanup_settings_stamp() {",
      '  /bin/rm -f -- "$EXPECTED_TMP" "$NEXT_TMP"',
      "}",
      "trap cleanup_settings_stamp EXIT HUP INT TERM",
      '/bin/dd bs=1 count="$EXPECTED_SIZE" of="$EXPECTED_TMP" 2>/dev/null',
      '/bin/dd bs=1 count="$NEXT_SIZE" of="$NEXT_TMP" 2>/dev/null',
      'EXPECTED_READ="$(/usr/bin/wc -c < "$EXPECTED_TMP" | /usr/bin/tr -d \' \')"',
      'NEXT_READ="$(/usr/bin/wc -c < "$NEXT_TMP" | /usr/bin/tr -d \' \')"',
      '[ "$EXPECTED_READ" = "$EXPECTED_SIZE" ] && [ "$NEXT_READ" = "$NEXT_SIZE" ] || exit 32',
      'TRAILING="$(/bin/dd bs=1 count=1 2>/dev/null | /usr/bin/wc -c | /usr/bin/tr -d \' \')"',
      '[ "$TRAILING" = "0" ] || exit 32',
      'if [ "$EXPECTED_KIND" = "PRESENT" ]; then',
      '  if [ -L "$SETTINGS" ] || [ ! -f "$SETTINGS" ]; then',
      "    printf '%s\\n' 'SETTINGS_CHANGED_BEFORE_STAMP' >&2",
      "    exit 34",
      "  fi",
      '  CURRENT_MODE="$(/usr/bin/stat -f \'%Lp\' "$SETTINGS" 2>/dev/null || /usr/bin/stat -c \'%a\' "$SETTINGS" 2>/dev/null)"',
      '  [ "$CURRENT_MODE" = "$EXPECTED_MODE" ] || {',
      "    printf '%s\\n' 'SETTINGS_CHANGED_BEFORE_STAMP' >&2",
      "    exit 34",
      "  }",
      '  /usr/bin/cmp -s "$SETTINGS" "$EXPECTED_TMP" || {',
      "    printf '%s\\n' 'SETTINGS_CHANGED_BEFORE_STAMP' >&2",
      "    exit 34",
      "  }",
      "else",
      '  [ "$EXPECTED_SIZE" = "0" ] || exit 32',
      '  if [ -e "$SETTINGS" ] || [ -L "$SETTINGS" ]; then',
      "    printf '%s\\n' 'SETTINGS_CHANGED_BEFORE_STAMP' >&2",
      "    exit 34",
      "  fi",
      "fi",
      '/bin/chmod "$NEXT_MODE" "$NEXT_TMP"',
      // Settings write first — only then may seals be invalidated.
      '/bin/mv -f -- "$NEXT_TMP" "$SETTINGS"',
      `/bin/rm -f -- ${topologyKey} ${topologySeal}`,
      "/usr/bin/printf 'STAMPED\\n'",
      "",
    ].join("\n");
    return makeRemoteCommand("/bin/sh", [
      "-c",
      source,
      "vellum-plan:remote-settings-stamp",
    ]);
  } catch (error) {
    return Effect.fail(
      new SshInputError({
        message: error instanceof Error ? error.message : "stamp compile failed",
      }),
    );
  }
};

/**
 * Restore prior settings snapshot via framed stdin (vellum-settings-rollback-v1).
 *
 * Fail-closed after a successful restore: invalidate topology seals so the next
 * boot bootstraps over the restored settings bytes (never leave an old seal
 * covering new/restored plaintext).
 */
export const compileRemoteSettingsRestore = (
  vellumDir: ConfinedRemotePath,
  settingsPath: ConfinedRemotePath,
  maxBytes: number,
): Effect.Effect<RemoteCommand, SshInputError> => {
  try {
    const limit = assertByteLimit(maxBytes);
    const dir = shellSingleQuote(inspectPath(vellumDir));
    const settings = shellSingleQuote(inspectPath(settingsPath));
    const topologyKey = shellSingleQuote(
      `${inspectPath(vellumDir)}/topology.key`,
    );
    const topologySeal = shellSingleQuote(
      `${inspectPath(vellumDir)}/topology.seal`,
    );
    const source = [
      "set -eu",
      `DIR=${dir}`,
      `SETTINGS=${settings}`,
      `LIMIT=${limit}`,
      'if [ -L "$DIR" ] || [ ! -d "$DIR" ]; then printf \'%s\\n\' \'SETTINGS_DIR_UNSAFE\' >&2; exit 21; fi',
      "IFS= read -r FRAME_VERSION",
      "IFS= read -r EXPECTED_MODE",
      "IFS= read -r EXPECTED_SIZE",
      "IFS= read -r ORIGINAL_KIND",
      "IFS= read -r ORIGINAL_MODE",
      "IFS= read -r ORIGINAL_SIZE",
      '[ "$FRAME_VERSION" = "vellum-settings-rollback-v1" ] || exit 22',
      'case "$EXPECTED_SIZE:$ORIGINAL_SIZE" in',
      "  *[!0-9:]*|:*|*:) exit 22 ;;",
      "esac",
      'case "$ORIGINAL_KIND" in PRESENT|ABSENT) ;; *) exit 22 ;; esac',
      'case "$EXPECTED_MODE:$ORIGINAL_MODE" in',
      "  [0-7][0-7][0-7]:[0-7][0-7][0-7]|[0-7][0-7][0-7][0-7]:[0-7][0-7][0-7]|[0-7][0-7][0-7]:[0-7][0-7][0-7][0-7]|[0-7][0-7][0-7][0-7]:[0-7][0-7][0-7][0-7]) ;;",
      "  *) exit 22 ;;",
      "esac",
      'case "$ORIGINAL_MODE" in',
      "  [0-7][0-7][0-7]|[0-7][0-7][0-7][0-7]) ;;",
      "  *) exit 22 ;;",
      "esac",
      '[ "$EXPECTED_SIZE" -le "$LIMIT" ] && [ "$ORIGINAL_SIZE" -le "$LIMIT" ] || exit 22',
      'EXPECTED_TMP="$(/usr/bin/mktemp "$SETTINGS.rollback-expected.XXXXXX")"',
      'ORIGINAL_TMP="$(/usr/bin/mktemp "$SETTINGS.rollback-original.XXXXXX")"',
      "cleanup_settings_rollback() {",
      '  /bin/rm -f -- "$EXPECTED_TMP" "$ORIGINAL_TMP"',
      "}",
      "trap cleanup_settings_rollback EXIT HUP INT TERM",
      '/bin/dd bs=1 count="$EXPECTED_SIZE" of="$EXPECTED_TMP" 2>/dev/null',
      '/bin/dd bs=1 count="$ORIGINAL_SIZE" of="$ORIGINAL_TMP" 2>/dev/null',
      'EXPECTED_READ="$(/usr/bin/wc -c < "$EXPECTED_TMP" | /usr/bin/tr -d \' \')"',
      'ORIGINAL_READ="$(/usr/bin/wc -c < "$ORIGINAL_TMP" | /usr/bin/tr -d \' \')"',
      '[ "$EXPECTED_READ" = "$EXPECTED_SIZE" ] && [ "$ORIGINAL_READ" = "$ORIGINAL_SIZE" ] || exit 22',
      'TRAILING="$(/bin/dd bs=1 count=1 2>/dev/null | /usr/bin/wc -c | /usr/bin/tr -d \' \')"',
      '[ "$TRAILING" = "0" ] || exit 22',
      'if [ -L "$SETTINGS" ] || [ ! -f "$SETTINGS" ]; then',
      "  printf '%s\\n' 'SETTINGS_COMPARE_TARGET_UNSAFE' >&2",
      "  exit 23",
      "fi",
      '  CURRENT_MODE="$(/usr/bin/stat -f \'%Lp\' "$SETTINGS" 2>/dev/null || /usr/bin/stat -c \'%a\' "$SETTINGS" 2>/dev/null)"',
      'if [ "$CURRENT_MODE" != "$EXPECTED_MODE" ]; then',
      "  printf '%s\\n' 'SETTINGS_CHANGED_SINCE_STAMP' >&2",
      "  exit 24",
      "fi",
      'if ! /usr/bin/cmp -s "$SETTINGS" "$EXPECTED_TMP"; then',
      "  printf '%s\\n' 'SETTINGS_CHANGED_SINCE_STAMP' >&2",
      "  exit 24",
      "fi",
      'if [ "$ORIGINAL_KIND" = "PRESENT" ]; then',
      '  /bin/chmod "$ORIGINAL_MODE" "$ORIGINAL_TMP"',
      '  /bin/mv -f -- "$ORIGINAL_TMP" "$SETTINGS"',
      "else",
      '  [ "$ORIGINAL_SIZE" = "0" ] || exit 22',
      '  /bin/rm -f -- "$SETTINGS"',
      "fi",
      // Restore postcondition: drop seals so next boot bootstraps restored bytes.
      `/bin/rm -f -- ${topologyKey} ${topologySeal}`,
      "/usr/bin/printf 'RESTORED\\n'",
      "",
    ].join("\n");
    return makeRemoteCommand("/bin/sh", [
      "-c",
      source,
      "vellum-plan:remote-settings-restore",
    ]);
  } catch (error) {
    return Effect.fail(
      new SshInputError({
        message: error instanceof Error ? error.message : "restore compile failed",
      }),
    );
  }
};

/**
 * Probe whether topology.key + topology.seal both exist as regular files.
 * Symlinks or asymmetric presence → UNSEALED (not an admit success).
 * Remote cannot HMAC-verify without the local admit path; presence is the
 * gate for "already configured" early-return (absent → force re-stamp).
 */
export const compileRemoteTopologySealPresence = (
  vellumDir: ConfinedRemotePath,
): Effect.Effect<RemoteCommand, SshInputError> => {
  try {
    const dir = inspectPath(vellumDir);
    const key = shellSingleQuote(`${dir}/topology.key`);
    const seal = shellSingleQuote(`${dir}/topology.seal`);
    const source = [
      "set -eu",
      `if [ -L ${key} ] || [ -L ${seal} ]; then /usr/bin/printf 'UNSEALED\\n'; exit 0; fi`,
      `if [ -f ${key} ] && [ -f ${seal} ]; then /usr/bin/printf 'SEALED\\n'; exit 0; fi`,
      "/usr/bin/printf 'UNSEALED\\n'",
      "",
    ].join("\n");
    return makeRemoteCommand("/bin/sh", [
      "-c",
      source,
      "vellum-plan:remote-topology-seal-presence",
    ]);
  } catch (error) {
    return Effect.fail(
      new SshInputError({
        message:
          error instanceof Error
            ? error.message
            : "topology seal presence compile failed",
      }),
    );
  }
};

// ---------------------------------------------------------------------------
// Linux remote preflight (fixed V3 product program)
// ---------------------------------------------------------------------------
//
// Named compiler: no free path/command args from callers. Stdin supplies
// bundle bytes + version + package hashes; stdout is exactly one
// LINUX_REMOTE_PREFLIGHT_V3 (or REFUSED_V3) line. Generation readiness is a
// plain `${INVOCATION}\n` receipt under ready-$INVOCATION (exact 33 bytes via
// wc + cmp against printf) plus work sock/token — never deep JSON, never term/browser.

/** Product paths for release helper/bridge — never caller-controlled. */
const LINUX_RELEASE_INSTALLER_PATH = "/usr/libexec/vellum-release-installer";
const LINUX_RELEASE_BRIDGE_PATH = "/usr/libexec/vellum-release-bridge";

/**
 * Pure compile of the fixed Ubuntu Remote preflight shell source.
 * Source of truth for the V3 protocol body; deploy-linux must not re-author it.
 */
export const compileLinuxRemotePreflightSource = (): string => {
  // Local names only for String.raw path interpolation — product constants.
  const HELPER = LINUX_RELEASE_INSTALLER_PATH;
  const BRIDGE = LINUX_RELEASE_BRIDGE_PATH;
  // `${"$"}` escapes shell `${…}` so TypeScript does not consume `$`.
  return String.raw`
set -eu
umask 077
refuse() {
  echo "LINUX_REMOTE_PREFLIGHT_REFUSED_V3 reason=$1"
  exit 0
}
private_file() {
  [ -f "$1" ] && [ ! -L "$1" ] && [ -O "$1" ] &&
    [ "$(/usr/bin/stat -c '%a' "$1" 2>/dev/null || true)" = 600 ]
}
private_socket() {
  [ -S "$1" ] && [ ! -L "$1" ] && [ -O "$1" ] &&
    [ "$(/usr/bin/stat -c '%a' "$1" 2>/dev/null || true)" = 600 ]
}
exact_field() {
  echo "$1" | /usr/bin/awk -F= -v wanted="$2" '
    $1 == wanted { count += 1; value = substr($0, length(wanted) + 2) }
    END { if (count == 1 && length(value) > 0) print value; else exit 1 }
  '
}
IFS= read -r BUNDLE_BYTES || refuse disk
IFS= read -r EXPECTED_VERSION || refuse version
IFS= read -r EXPECTED_DEB_SHA || refuse package
IFS= read -r EXPECTED_MANIFEST_SHA || refuse package
case "$BUNDLE_BYTES" in ""|*[!0-9]*) refuse disk ;; esac
[ "$BUNDLE_BYTES" -gt 0 ] && [ "$BUNDLE_BYTES" -le 3221225472 ] || refuse disk
case "$EXPECTED_VERSION" in
  0|*[!0-9.]*|.*|*.) refuse version ;;
esac
echo "$EXPECTED_VERSION" | /usr/bin/awk -F. '
  NF == 3 && $1 ~ /^(0|[1-9][0-9]*)$/ &&
  $2 ~ /^(0|[1-9][0-9]*)$/ &&
  $3 ~ /^(0|[1-9][0-9]*)$/ { ok = 1 }
  END { exit(ok ? 0 : 1) }
' || refuse version
case "$EXPECTED_DEB_SHA:$EXPECTED_MANIFEST_SHA" in
  *[!0-9a-f:]*|*:*:* ) refuse package ;;
esac
[ "${"$"}{#EXPECTED_DEB_SHA}" -eq 64 ] || refuse package
[ "${"$"}{#EXPECTED_MANIFEST_SHA}" -eq 64 ] || refuse package
for REQUIRED_COMMAND in \
  /bin/hostname \
  /usr/bin/awk \
  /usr/bin/cat \
  /usr/bin/cmp \
  /usr/bin/df \
  /usr/bin/dpkg \
  /usr/bin/dpkg-query \
  /usr/bin/getconf \
  /usr/bin/grep \
  /usr/bin/id \
  /usr/bin/loginctl \
  /usr/bin/stat \
  /usr/bin/sudo \
  /usr/bin/systemctl \
  /usr/bin/tr \
  /usr/bin/uname \
  /usr/bin/wc
do
  [ -x "$REQUIRED_COMMAND" ] || refuse commands
done
OS_ID=$(/usr/bin/awk -F= '$1 == "ID" { gsub(/^"|"$/, "", $2); print $2 }' /etc/os-release)
OS_RELEASE=$(/usr/bin/awk -F= '$1 == "VERSION_ID" { gsub(/^"|"$/, "", $2); print $2 }' /etc/os-release)
[ "$OS_ID" = ubuntu ] || refuse os
[ "$OS_RELEASE" = 24.04 ] || refuse release
[ "$(/usr/bin/uname -m)" = x86_64 ] || refuse architecture
GLIBC_FACT=$(/usr/bin/getconf GNU_LIBC_VERSION 2>/dev/null || true)
case "$GLIBC_FACT" in "glibc "[0-9]*.[0-9]*) ;; *) refuse libc ;; esac
LIBC_VERSION=${"$"}{GLIBC_FACT#glibc }
LIBC_VERSION=$(/usr/bin/awk -F. '{ print $1 "." $2 }' <<EOF
$LIBC_VERSION
EOF
)
LIBC_MAJOR=${"$"}{LIBC_VERSION%%.*}
LIBC_MINOR=${"$"}{LIBC_VERSION#*.}
case "$LIBC_MAJOR:$LIBC_MINOR" in *[!0-9:]*) refuse libc ;; esac
if [ "$LIBC_MAJOR" -lt 2 ] ||
   { [ "$LIBC_MAJOR" -eq 2 ] && [ "$LIBC_MINOR" -lt 39 ]; }; then
  refuse libc
fi
UID_VALUE=$(/usr/bin/id -u)
GID_VALUE=$(/usr/bin/id -g)
HOST_VALUE=$(/bin/hostname)
case "$UID_VALUE:$GID_VALUE" in
  0:*|*:0|*[!0-9:]*) refuse identity ;;
esac
case "$HOST_VALUE" in
  ""|*[!a-z0-9.-]*|.*|*.) refuse identity ;;
esac
[ "${"$"}{#HOST_VALUE}" -le 253 ] || refuse identity
/usr/bin/systemctl --user show-environment >/dev/null 2>&1 || refuse systemd-user
AVAILABLE_BYTES=$(
  /usr/bin/df -PB1 /var /opt "$HOME" |
    /usr/bin/awk 'NR > 1 && $4 ~ /^[0-9]+$/ {
      if (minimum == "" || $4 < minimum) minimum = $4
    } END { print minimum }'
)
case "$AVAILABLE_BYTES" in ""|*[!0-9]*) refuse disk ;; esac
REQUIRED_BYTES=$((BUNDLE_BYTES * 3 + 536870912))
[ "$AVAILABLE_BYTES" -ge "$REQUIRED_BYTES" ] || refuse disk
PACKAGE_STATE=$(/usr/bin/dpkg-query -W -f='${"$"}{Status}\t${"$"}{Version}\n' vellum 2>/dev/null || true)
if [ -z "$PACKAGE_STATE" ]; then
  CURRENT_VERSION=none
else
  CURRENT_VERSION=$(echo "$PACKAGE_STATE" | /usr/bin/awk -F '\t' '$1 == "install ok installed" && NF == 2 { print $2 }')
  if [ -n "$CURRENT_VERSION" ]; then
    echo "$CURRENT_VERSION" | /usr/bin/awk -F. '
      NF == 3 && $1 ~ /^(0|[1-9][0-9]*)$/ &&
      $2 ~ /^(0|[1-9][0-9]*)$/ &&
      $3 ~ /^(0|[1-9][0-9]*)$/ { ok = 1 }
      END { exit(ok ? 0 : 1) }
    ' || refuse package
  elif echo "$PACKAGE_STATE" | /usr/bin/awk -F '\t' '
    $1 == "deinstall ok config-files" && NF == 2 { found = 1 }
    END { exit(found ? 0 : 1) }
  '; then
    CURRENT_VERSION=none
  else
    refuse package
  fi
fi
ENABLE_STATE=$(/usr/bin/systemctl --user is-enabled vellum-remote.service 2>/dev/null || true)
ACTIVE_STATE=$(/usr/bin/systemctl --user is-active vellum-remote.service 2>/dev/null || true)
if [ "$CURRENT_VERSION" = none ]; then
  [ "$ENABLE_STATE" = not-found ] || refuse systemd-user
  [ "$ACTIVE_STATE" = inactive ] || refuse systemd-user
  ENABLED=0
  ACTIVE=0
  UNIT_STATE=not-found
else
  case "$ENABLE_STATE" in enabled) ENABLED=1 ;; disabled) ENABLED=0 ;; *) refuse systemd-user ;; esac
  case "$ACTIVE_STATE" in active) ACTIVE=1 ;; inactive) ACTIVE=0 ;; *) refuse systemd-user ;; esac
  UNIT_STATE=present
fi
LINGER_VALUE=$(/usr/bin/loginctl show-user "$UID_VALUE" -p Linger --value 2>/dev/null || true)
case "$LINGER_VALUE" in yes) LINGER=1 ;; no) LINGER=0 ;; *) refuse linger ;; esac
HELPER_READY=0
if [ -f "${HELPER}" ] && [ ! -L "${HELPER}" ] &&
   [ "$(/usr/bin/stat -c '%u:%g:%a:%h' "${HELPER}" 2>/dev/null || true)" = "0:0:755:1" ]; then
  HELPER_READY=1
fi
BRIDGE_READY=0
if [ -f "${BRIDGE}" ] && [ ! -L "${BRIDGE}" ] &&
   [ "$(/usr/bin/stat -c '%u:%g:%a:%h' "${BRIDGE}" 2>/dev/null || true)" = "0:0:755:1" ]; then
  BRIDGE_READY=1
fi
CURRENT_READY=0
CURRENT_GENERATION=none
if [ "$ENABLED" = 1 ] && [ "$ACTIVE" = 1 ]; then
  SHOW=$(/usr/bin/systemctl --user show vellum-remote.service -p ActiveState -p SubState -p MainPID -p InvocationID 2>/dev/null || true)
  ACTIVE_DETAIL=$(exact_field "$SHOW" ActiveState 2>/dev/null || true)
  SUB_STATE=$(exact_field "$SHOW" SubState 2>/dev/null || true)
  MAIN_PID=$(exact_field "$SHOW" MainPID 2>/dev/null || true)
  INVOCATION=$(exact_field "$SHOW" InvocationID 2>/dev/null || true)
  case "$MAIN_PID" in ""|*[!0-9]*) MAIN_PID=0 ;; esac
  case "$INVOCATION" in *[!0-9a-f]*|"") INVOCATION=invalid ;; esac
  READY_RECEIPT="/run/user/$UID_VALUE/vellum-remote/ready-$INVOCATION"
  PACKAGE_VERIFY=
  if PACKAGE_VERIFY=$(/usr/bin/dpkg --verify vellum 2>/dev/null); then
    PACKAGE_VERIFY_OK=1
  else
    PACKAGE_VERIFY_OK=0
  fi
  if [ "$ACTIVE_DETAIL" = active ] && [ "$SUB_STATE" = running ] &&
     [ "$MAIN_PID" -gt 1 ] && [ "${"$"}{#INVOCATION}" -eq 32 ] &&
     [ "$PACKAGE_VERIFY_OK" = 1 ] && [ -z "$PACKAGE_VERIFY" ] &&
     private_file "$READY_RECEIPT" &&
     [ "$(/usr/bin/wc -c < "$READY_RECEIPT" 2>/dev/null | /usr/bin/tr -d ' ')" = 33 ] &&
     /usr/bin/printf '%s\n' "$INVOCATION" | /usr/bin/cmp -s - "$READY_RECEIPT" &&
     /usr/bin/tr '\0' '\n' < "/proc/$MAIN_PID/cmdline" |
       /usr/bin/grep -Fqx '/opt/Vellum Command/resources/systemd/vellum-remote-launch-v1' &&
     private_socket "$HOME/.vellum/work/control.sock" &&
     private_file "$HOME/.vellum/work/token"; then
    CURRENT_READY=1
    CURRENT_GENERATION="$INVOCATION"
  fi
fi
echo "LINUX_REMOTE_PREFLIGHT_V3 disk=$AVAILABLE_BYTES current=$CURRENT_VERSION enabled=$ENABLED active=$ACTIVE linger=$LINGER helper=$HELPER_READY bridge=$BRIDGE_READY ready=$CURRENT_READY generation=$CURRENT_GENERATION uid=$UID_VALUE gid=$GID_VALUE host=$HOST_VALUE libc=$LIBC_VERSION unit=$UNIT_STATE"
`.trim();
};

/**
 * Compile the fixed Ubuntu Remote preflight into a branded RemoteCommand.
 * No free path/command injection — product constants only.
 */
export const compileLinuxRemotePreflight = (): Effect.Effect<
  RemoteCommand,
  SshInputError
> => {
  try {
    const source = compileLinuxRemotePreflightSource();
    return makeRemoteCommand("/bin/sh", [
      "-c",
      source,
      "vellum-plan:linux-remote-preflight",
    ]);
  } catch (error) {
    return Effect.fail(
      new SshInputError({
        message:
          error instanceof Error
            ? error.message
            : "linux remote preflight compile failed",
      }),
    );
  }
};

// ---------------------------------------------------------------------------
// Herdr clipboard-image staging (product path under /tmp/vellum-herdr-images)
// ---------------------------------------------------------------------------

/** Fixed remote staging root for herdr clipboard images — never caller-supplied. */
export const HERDR_IMAGE_STAGE_DIR = "/tmp/vellum-herdr-images" as const;

/**
 * Product basenames only (`vellum-clip-<ts36>-<8hex>.<ext>` from stage-image.ts).
 * No slashes, no shell metacharacters, no free-form names.
 */
const HERDR_STAGE_BASENAME =
  /^vellum-clip-[a-z0-9]{1,24}-[a-f0-9]{8}\.(png|jpg|gif|webp|bmp)$/u;

/**
 * Admit a product herdr stage basename and return the confined absolute path.
 */
export const confineHerdrStagePath = (
  remoteName: string,
): Effect.Effect<string, SshInputError> => {
  if (
    typeof remoteName !== "string" ||
    remoteName.length === 0 ||
    remoteName.length > 96 ||
    !HERDR_STAGE_BASENAME.test(remoteName) ||
    remoteName.includes("/") ||
    remoteName.includes("\\") ||
    remoteName.includes("\0") ||
    remoteName.includes("..")
  ) {
    return Effect.fail(
      new SshInputError({ message: "herdr stage basename is not a product token" }),
    );
  }
  const path = `${HERDR_IMAGE_STAGE_DIR}/${remoteName}`;
  if (!isSafeAbsPath(path) || !path.startsWith(`${HERDR_IMAGE_STAGE_DIR}/`)) {
    return Effect.fail(
      new SshInputError({ message: "herdr stage path is not confining" }),
    );
  }
  return Effect.succeed(path);
};

/**
 * Compile the sole remote shell for herdr image staging:
 * umask → ensure stage dir → exclusive stdin write → mode 0600.
 *
 * Paths are product-confined; transport must not hand-author shell strings.
 */
export const compileHerdrImageStage = (
  remoteName: string,
): Effect.Effect<{ readonly command: RemoteCommand; readonly path: string }, SshInputError> =>
  confineHerdrStagePath(remoteName).pipe(
    Effect.flatMap((path) => {
      const dir = shellSingleQuote(HERDR_IMAGE_STAGE_DIR);
      const file = shellSingleQuote(path);
      const source = [
        "set -eu",
        "umask 077",
        `if [ -L ${dir} ]; then printf '%s\\n' 'vellum-remote-plan: stage dir is a symlink' >&2; exit 73; fi`,
        `/bin/mkdir -p -- ${dir}`,
        `if [ -L ${dir} ] || [ ! -d ${dir} ]; then printf '%s\\n' 'vellum-remote-plan: stage dir unsafe' >&2; exit 73; fi`,
        `if [ -L ${file} ]; then printf '%s\\n' 'vellum-remote-plan: stage path is a symlink' >&2; exit 73; fi`,
        `if [ -e ${file} ]; then printf '%s\\n' 'vellum-remote-plan: stage path already exists' >&2; exit 73; fi`,
        // noclobber exclusive create — refuse clobber on name collision.
        "set -C",
        `cat > ${file} || { set +C; /bin/rm -f -- ${file}; exit 73; }`,
        "set +C",
        `/bin/chmod 600 -- ${file}`,
        "",
      ].join("\n");
      return makeRemoteCommand("/bin/sh", [
        "-c",
        source,
        "vellum-plan:herdr-image-stage",
      ]).pipe(Effect.map((command) => ({ command, path })));
    }),
  );

// ---------------------------------------------------------------------------
// Named product compilers for host deploy (mutating / privileged remotes)
// ---------------------------------------------------------------------------

/**
 * Fixed Ubuntu release-bridge executable — no caller argv, no free path.
 * Sole mutation surface for Linux Remote deploy streams.
 */
export const compileLinuxReleaseBridge = (): Effect.Effect<
  RemoteCommand,
  SshInputError
> => makeRemoteCommand(LINUX_RELEASE_BRIDGE_PATH, []);

/**
 * Darwin app stream receiver: product deploy script as `bash -lc <source>`.
 *
 * Source must be the Vellum Darwin deploy program (product markers required).
 * Free-form shell — including `rm -rf -- /` — is not a product deploy script.
 */
export const compileDarwinRemoteDeployScript = (
  remoteScript: string,
): Effect.Effect<RemoteCommand, SshInputError> => {
  if (
    typeof remoteScript !== "string" ||
    remoteScript.length === 0 ||
    Buffer.byteLength(remoteScript, "utf8") > 256 * 1024
  ) {
    return Effect.fail(
      new SshInputError({
        message: "darwin deploy script exceeds product bounds",
      }),
    );
  }
  // Product markers from buildRemoteDeployScript — refuse arbitrary shell.
  if (
    !remoteScript.includes("commit_deploy") ||
    !remoteScript.includes("STATION_READY") ||
    !remoteScript.includes("CONTROL_SOCKET_TIMEOUT")
  ) {
    return Effect.fail(
      new SshInputError({
        message: "darwin deploy script is not a product stream program",
      }),
    );
  }
  return makeRemoteCommand("bash", ["-lc", remoteScript]);
};
