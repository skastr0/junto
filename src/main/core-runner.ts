import type { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { ModelService } from "./junto/model/service";
import type { MachineRepository } from "./junto/machines/repository";
import type { SeatSessionRepository } from "./junto/seat-sessions/repository";
import type { MachineLink } from "./junto/link/service";
import type { HostsService } from "./junto/hosts/service";

type CoreServices = ModelService | MachineRepository | SeatSessionRepository | SqlClient.SqlClient | MachineLink | HostsService;

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
