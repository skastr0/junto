/**
 * Typed remote filesystem plans — the source of truth for remote mutations.
 *
 * Hand-authored shell strings are forbidden at the product boundary. Callers
 * build a closed AST of confined operations; only `compileRemotePlan` may emit
 * shell, and only for a statically known, allowlisted shape.
 *
 * Doctrine (machine-safety + security-doctrine):
 * - No ambient `rm` / arbitrary executable / free-form path.
 * - Paths are branded, absolute, and confined under the remote home `.vellum`.
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
 * 1. invalidate topology seals
 * 2. atomic write settings via exclusive temp + rename
 * 3. re-invalidate seals
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
        op: "removeExactLeaves",
        directory: vellumDir,
        basenames: Object.freeze(["topology.key", "topology.seal"] as const),
      },
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
