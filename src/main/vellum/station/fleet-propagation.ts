import { Context, Effect, Layer } from "effect";
import type { HostId } from "@shared/remote-hosts";
import {
  StationFleetTargetRepository,
  type StationFleetTargetRepositoryError,
} from "./fleet-target-repository";
import {
  StationPropagation,
  type StationPropagationError,
  type StationPropagationReceipt,
} from "./propagation";

export type StationFleetPropagationResult =
  | {
      readonly ok: true;
      readonly hostId: HostId;
      readonly receipt: StationPropagationReceipt;
    }
  | {
      readonly ok: false;
      readonly hostId: HostId;
      readonly error: StationPropagationError;
    };

/**
 * One bounded fleet pass.
 *
 * A failed Remote is data in the result, not a failure of the whole pass, so
 * one offline machine cannot head-of-line block the other independently homed
 * stations. Failure to read the canonical fleet registry remains fatal.
 */
export class StationFleetPropagation extends Context.Tag(
  "@vellum/StationFleetPropagation",
)<
  StationFleetPropagation,
  {
    readonly synchronizeAll: Effect.Effect<
      ReadonlyArray<StationFleetPropagationResult>,
      StationFleetTargetRepositoryError
    >;
  }
>() {}

export const StationFleetPropagationLive = Layer.effect(
  StationFleetPropagation,
  Effect.gen(function* () {
    const targets = yield* StationFleetTargetRepository;
    const propagation = yield* StationPropagation;

    const synchronizeAll = targets.list.pipe(
      Effect.flatMap((fleet) =>
        Effect.forEach(
          fleet,
          (target) =>
            propagation.synchronize({
              endpoint: target.endpoint,
              stationInstallationId: target.stationInstallationId,
            }).pipe(
              Effect.match({
                onFailure: (error): StationFleetPropagationResult => ({
                  ok: false,
                  hostId: target.hostId,
                  error,
                }),
                onSuccess: (receipt): StationFleetPropagationResult => ({
                  ok: true,
                  hostId: target.hostId,
                  receipt,
                }),
              }),
            ),
          { concurrency: 4 },
        )
      ),
      Effect.withSpan("station.fleet.synchronize-all"),
    );

    return StationFleetPropagation.of({ synchronizeAll });
  }),
);
