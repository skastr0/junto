import type { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import type { KernelService } from "../kernel/service";
import type { MachineRepository } from "../machines/repository";
import type { ModelService } from "../model/service";
import type { PausePlane } from "../pause-plane";
import type { SettingsService } from "../settings/service";
import type { WorkService } from "../work/service";
import type { SeatSessionRepository } from "./repository";

/** What seat sessions read and write; every machine's core runtime has all of it. */
export type SeatSessionServices =
  | ModelService
  | SeatSessionRepository
  | MachineRepository
  | SettingsService
  | PausePlane
  | KernelService
  | WorkService
  | SqlClient.SqlClient;

/**
 * Run an effect in the runtime this process owns: the window's, or the
 * windowless core's. Seat sessions never import a runtime themselves.
 */
export type SeatSessionRun = <A, E>(effect: Effect.Effect<A, E, SeatSessionServices>) => Promise<A>;
