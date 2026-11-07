/**
 * Host-owned launch environment inherited by a managed seat's child processes.
 */
import { existsSync } from "node:fs";
import { resolveJuntoHome } from "@shared/junto-home";
import { delimiter, dirname, join, resolve } from "node:path";
import {
  WORK_HOME_ENV,
  workControlDir,
  workControlSocketPath,
} from "@shared/work-control";

export type SeatEnvInjectInput = {
  readonly agentKey?: string;
  readonly canvasName?: string;
  readonly nodeId?: string;
};

/**
 * The `bin` of the machine package this process runs from, when it runs from
 * one: a windowless core is `<package>/bin/node <package>/core/junto.cjs`, and
 * the package ships its CLI as `<package>/bin/junto`. The entry is taken as
 * launched, not resolved, so an installed core names `<install>/current/bin`,
 * which follows the selected build across updates.
 */
export const machinePackageCliDir = (
  entry: string | undefined = process.argv[1],
): string | undefined => {
  if (entry === undefined || entry.length === 0) return undefined;
  const root = dirname(dirname(resolve(entry)));
  const bin = join(root, "bin");
  return existsSync(join(root, "manifest.json")) && existsSync(join(bin, "junto")) ? bin : undefined;
};

/**
 * Directories that may hold the `junto` CLI binary. Fail-soft — missing dirs omitted.
 *
 * A Junto that ships its own CLI hands its seats only that one: the app's
 * `<resources>/bin/junto`, or a windowless core's package `bin/junto`. A
 * packaged app started from inside a checkout must not pick up the checkout's
 * `dist/junto`, which can be older than the app. `<cwd>/dist` is the CLI only
 * when nothing is bundled, as in development.
 */
export const juntoCliPathPrefixes = (
  cwd: string = process.cwd(),
  resourcesPath: string | undefined = typeof process.resourcesPath === "string"
    ? process.resourcesPath
    : undefined,
  packageBin: string | undefined = machinePackageCliDir(),
): readonly string[] => {
  const bin = resourcesPath ? join(resourcesPath, "bin") : undefined;
  if (bin !== undefined && existsSync(join(bin, "junto"))) return [bin];
  if (packageBin !== undefined) return [packageBin];
  const out: string[] = [];
  const dist = join(cwd, "dist");
  if (existsSync(join(dist, "junto"))) out.push(dist);
  if (bin !== undefined && existsSync(bin)) out.push(bin);
  return out;
};

export const resolveWorkHomeForSeat = (
  env: NodeJS.ProcessEnv = process.env,
  home: string = resolveJuntoHome(),
): string => {
  const override = env[WORK_HOME_ENV]?.trim();
  if (override) return override;
  return workControlDir(home);
};

/**
 * Host inject map for managed harness spawn. Merged after scrub; never reintroduces
 * scrubbed Claude nested-session keys (caller must use buildSpawnEnv).
 */
export const buildManagedSeatInject = (
  input: SeatEnvInjectInput = {},
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> => {
  const inject: Record<string, string> = {};

  const prefixes = juntoCliPathPrefixes();
  if (prefixes.length > 0) {
    const current = typeof env.PATH === "string" ? env.PATH : "";
    inject.PATH = [...prefixes, current].filter((p) => p.length > 0).join(delimiter);
  }

  const workHome = resolveWorkHomeForSeat(env);
  inject.JUNTO_WORK_HOME = workHome;
  const socket = workControlSocketPath(workHome);
  inject.JUNTO_SOCKET = socket;
  inject.JUNTO_WORK_SOCKET = socket;

  // The ONE canonical CLI location for this seat. There is no second path:
  // the seat's CLI is the binary the seat was launched with. Agents reference
  // this variable when their shell reset PATH; the message never prints the
  // literal path (machine-specific internals stay out of agent context).
  const cliPrefix = juntoCliPathPrefixes().find((prefix) =>
    existsSync(join(prefix, "junto")),
  );
  if (cliPrefix !== undefined) {
    inject.JUNTO_CLI = join(cliPrefix, "junto");
  }

  if (input.agentKey?.trim()) {
    inject.JUNTO_SEAT = input.agentKey.trim();
  }
  if (input.canvasName?.trim() && input.nodeId?.trim()) {
    inject.JUNTO_NODE_REF = `${input.canvasName.trim()}:${input.nodeId.trim()}`;
  }

  return inject;
};
