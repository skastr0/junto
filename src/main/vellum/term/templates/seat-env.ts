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
 * Directories that may hold `vellum` CLI binary. Fail-soft — missing dirs omitted.
 */
export const vellumCliPathPrefixes = (
  cwd: string = process.cwd(),
  resourcesPath: string | undefined = typeof process.resourcesPath === "string"
    ? process.resourcesPath
    : undefined,
): readonly string[] => {
  const out: string[] = [];
  const dist = join(cwd, "dist");
  if (existsSync(join(dist, "vellum"))) out.push(dist);
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
  inject.VELLUM_COMMAND_WORK_HOME = workHome;
  const socket = workControlSocketPath(workHome);
  inject.VELLUM_COMMAND_SOCKET = socket;
  inject.VELLUM_COMMAND_WORK_SOCKET = socket;

  if (input.agentKey?.trim()) {
    inject.VELLUM_COMMAND_SEAT = input.agentKey.trim();
  }
  if (input.canvasName?.trim() && input.nodeId?.trim()) {
    inject.VELLUM_COMMAND_NODE_REF = `${input.canvasName.trim()}:${input.nodeId.trim()}`;
  }

  return inject;
};
