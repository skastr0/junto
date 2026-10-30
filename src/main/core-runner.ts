import { Effect } from "effect";
import type { Canvas } from "@shared/model";
import type { SqlClient } from "effect/unstable/sql";
import type { ModelService } from "./junto/model/service";
import type { MachineRepository } from "./junto/machines/repository";
import type { SeatSessionRepository } from "./junto/seat-sessions/repository";
import type { MachineLink } from "./junto/link/service";
import type { HostsService } from "./junto/hosts/service";
import type { WorkService } from "./junto/work/service";

type CoreServices = ModelService | MachineRepository | SeatSessionRepository | SqlClient.SqlClient | MachineLink | HostsService | WorkService;

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
 * The few reads code shared by both processes needs from the core: a canvas,
 * this machine's name, its vault scope. In the core they run on its runtime;
 * in main, with the core in its own process, main installs reads that ask
 * the core by name, since main then has no runtime to run them on.
 */
export interface CoreReads {
  readonly canvas: (canvasName: string) => Promise<Canvas | undefined>;
  readonly machineName: () => Promise<string>;
  readonly vaultScope: () => Promise<{ readonly vault: string } | undefined>;
  /** The environment a spawn in this process uses: the core's resolved shell env in the core, an op in main. */
  readonly spawnEnv: () => Promise<Record<string, string | undefined>>;
}

const runnerReads: CoreReads = {
  canvas: async (canvasName) => {
    const { ModelService } = await import("./junto/model/service");
    const read = await coreRunner.runPromise(Effect.flatMap(ModelService, (model) => model.canvas(canvasName)).pipe(Effect.result));
    return read._tag === "Success" ? read.success : undefined;
  },
  machineName: async () => {
    const { MachineRepository } = await import("./junto/machines/repository");
    return coreRunner.runPromise(Effect.flatMap(MachineRepository, (machine) => machine.machineName));
  },
  vaultScope: async () => {
    const [{ MachineRepository }, { makeVaultTokens }] = await Promise.all([
      import("./junto/machines/repository"), import("./junto/vault/repository"),
    ]);
    const record = await coreRunner.runPromise(Effect.gen(function* () {
      const machine = yield* MachineRepository;
      const tokens = yield* makeVaultTokens;
      return yield* tokens.get(yield* machine.machineName);
    }) as Effect.Effect<{ readonly vault: string } | undefined, unknown, CoreServices>);
    return record === undefined ? undefined : { vault: record.vault };
  },
  // The core's own copy of the service: the one that writes the env its spawns use.
  spawnEnv: async () => {
    const { shellEnvironment } = await import("./junto/shell-environment");
    return { ...(await shellEnvironment.ensure()) };
  },
};
let reads: CoreReads = runnerReads;

/** Main only, with the core in its own process: answer these reads from the core. */
export const installCoreReads = (installedReads: CoreReads): void => {
  reads = installedReads;
};

export const coreReads: CoreReads = {
  canvas: (canvasName) => reads.canvas(canvasName),
  machineName: () => reads.machineName(),
  vaultScope: () => reads.vaultScope(),
  spawnEnv: () => reads.spawnEnv(),
};
