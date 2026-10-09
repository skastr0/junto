import type { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { ModelService } from "./junto/model/service";
import type { StationRepository } from "./junto/station/repository";

type SessionServices = ModelService | StationRepository | SqlClient.SqlClient;

/** Promise callbacks enter the process's existing core, never a shell runtime. */
export interface CoreRunner {
  readonly runPromise: <A, E>(effect: Effect.Effect<A, E, SessionServices>) => Promise<A>;
}

let installed: CoreRunner | undefined;

export const installCoreRunner = (runner: CoreRunner): void => {
  if (installed !== undefined) throw new Error("Junto core runner is already installed");
  installed = runner;
};

export const coreRunner: CoreRunner = {
  runPromise: (effect) => installed === undefined
    ? Promise.reject(new Error("Junto core is not running"))
    : installed.runPromise(effect),
};
