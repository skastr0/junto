import { Effect, Layer } from "effect";
import { MachineRepository } from "../machines/repository";
import { ActorSeatOccupy, makeActorSeatOccupy } from "./actor-seat-occupy";
import { termPlane } from "./plane";
import { liveSeatEnvironment } from "../region-env/live";
import { makeSeatsProcessClient } from "./seats-client";

/** Select the seat's machine directly; starting it needs no projection ACK. */
export const ActorSeatOccupyLive = Layer.effect(
  ActorSeatOccupy,
  Effect.gen(function* () {
    const installation = yield* MachineRepository;
    return makeActorSeatOccupy({
      local: termPlane.host,
      localHostId: () => installation.machineName.pipe(
        Effect.mapError((cause) => new Error(cause.message)),
      ),
      clientForOccupy: async (hostId) => makeSeatsProcessClient(hostId),
      seatEnvironment: liveSeatEnvironment,
    });
  }),
);
