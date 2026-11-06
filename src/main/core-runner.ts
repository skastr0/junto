import { Effect } from "effect";
import type { Canvas } from "@shared/model";
import type { SqlClient } from "effect/unstable/sql";
import type { ModelService } from "./junto/model/service";
import type { MachineRepository } from "./junto/machines/repository";
import type { SeatSessionRepository } from "./junto/seat-sessions/repository";
import type { MachineLink } from "./junto/link/service";
import type { HostsService } from "./junto/hosts/service";
import type { VaultTokens } from "./junto/vault/repository";
import type { WorkService } from "./junto/work/service";

type CoreServices = ModelService | MachineRepository | SeatSessionRepository | SqlClient.SqlClient | MachineLink | HostsService | VaultTokens | WorkService;

/** Promise callbacks enter the process's existing core, never a shell runtime. */
export interface CoreRunner {
  readonly runPromise: <A, E>(effect: Effect.Effect<A, E, CoreServices>) => Promise<A>;
}

let installed: CoreRunner | undefined;

export const installCoreRunner = (runner: CoreRunner): (() => void) => {
  if (installed !== undefined) throw new Error("Junto core runner is already installed");
  installed = runner;
  return () => {
    if (installed === runner) installed = undefined;
  };
};

export const coreRunner: CoreRunner = {
  runPromise: (effect) => installed === undefined
    ? Promise.reject(new Error("Junto core is not running"))
    : installed.runPromise(effect),
};

/**
 * The few reads core code outside a service needs: a canvas, this machine's
 * name, its vault scope, a spawn's environment. Only the core loads this
 * module; startCore installs the reads on its runtime
 * (core-process/in-process-reads.ts, kept apart so the model, machine and
 * vault services load only where they are used). A read before then is a
 * boot-order bug, so it throws, a spawn's included.
 */
export interface CoreReads {
  readonly canvas: (canvasName: string) => Promise<Canvas | undefined>;
  readonly machineName: () => Promise<string>;
  readonly vaultScope: () => Promise<{ readonly vault: string } | undefined>;
  /** The environment a spawn uses: the core's resolved shell environment. */
  readonly spawnEnv: () => Promise<Record<string, string | undefined>>;
  /** The same environment for a spawn options literal that cannot await: what the shell read applied. */
  readonly spawnEnvNow: () => NodeJS.ProcessEnv;
}

let installedReads: CoreReads | undefined;

const reads = (): CoreReads => {
  if (installedReads === undefined) throw new Error("Junto core read before startCore installed its reads");
  return installedReads;
};

/** Core only: answer these reads on the runtime this process installs. */
export const installCoreReads = (next: CoreReads): void => {
  installedReads = next;
};

export const coreReads: CoreReads = {
  canvas: async (canvasName) => reads().canvas(canvasName),
  machineName: async () => reads().machineName(),
  vaultScope: async () => reads().vaultScope(),
  spawnEnv: async () => reads().spawnEnv(),
  spawnEnvNow: () => reads().spawnEnvNow(),
};
