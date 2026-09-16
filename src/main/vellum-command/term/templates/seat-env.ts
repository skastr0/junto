/**
 * Managed-terminal seat env inject — PATH for dist/vellum-command + work-control paths.
 * Secrets stay file-backed (token on disk); we inject socket/home paths only.
 * Zero writes to harness configs.
 */
import { existsSync } from "node:fs";
import { resolveVellumCommandHome } from "@shared/vellum-home";
import { delimiter, join } from "node:path";
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
 * Directories that may hold the `vellum-command` CLI binary. Fail-soft — missing dirs omitted.
 */
export const vellumCliPathPrefixes = (
  cwd: string = process.cwd(),
  resourcesPath: string | undefined = typeof process.resourcesPath === "string"
    ? process.resourcesPath
    : undefined,
): readonly string[] => {
  const out: string[] = [];
  const dist = join(cwd, "dist");
  if (existsSync(join(dist, "vellum-command"))) out.push(dist);
  if (resourcesPath) {
    const bin = join(resourcesPath, "bin");
    if (existsSync(bin)) out.push(bin);
  }
  return out;
};

export const resolveWorkHomeForSeat = (
  env: NodeJS.ProcessEnv = process.env,
  home: string = resolveVellumCommandHome(),
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

  const prefixes = vellumCliPathPrefixes();
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
  const cliPrefix = vellumCliPathPrefixes().find((prefix) =>
    existsSync(join(prefix, "vellum-command")),
  );
  if (cliPrefix !== undefined) {
    inject.JUNTO_CLI = join(cliPrefix, "vellum-command");
  }

  if (input.agentKey?.trim()) {
    inject.JUNTO_SEAT = input.agentKey.trim();
  }
  if (input.canvasName?.trim() && input.nodeId?.trim()) {
    inject.JUNTO_NODE_REF = `${input.canvasName.trim()}:${input.nodeId.trim()}`;
  }

  return inject;
};
