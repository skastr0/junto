import { Effect, Layer } from "effect";
import { MachineRepository } from "../machines/repository";
import { ActorSeatOccupy, makeActorSeatOccupy } from "./actor-seat-occupy";
import { termPlane } from "./plane";
import { liveSeatEnvironment } from "../region-env/live";

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
      clientForOccupy: async (hostId) => {
        const client = await termPlane.router.clientForOccupy(hostId);
        return {
          get: (bindingId) => client.get(bindingId),
          createAgentSeat: (input) => client.createAgentSeat(input),
        };
      },
      seatEnvironment: liveSeatEnvironment,
    });
  }),
);
