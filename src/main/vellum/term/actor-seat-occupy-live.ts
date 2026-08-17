/**
 * Production glue for the actor-seat WHEN.
 *
 * Root layers expose ActorSeatOccupy, never a process HOW. The service reads
 * station configuration for every operation so an Unenrolled process that is
 * configured in place immediately recognizes its durable host id.
 */
import { Effect, Layer } from "effect";
import { StationRepository } from "../station/repository";
import {
  ActorSeatOccupy,
  makeActorSeatOccupy,
} from "./actor-seat-occupy";
import { termPlane } from "./plane";

const asError = (cause: unknown): Error =>
  cause instanceof Error ? cause : new Error(String(cause));

export const ActorSeatOccupyLive = Layer.effect(
  ActorSeatOccupy,
  Effect.gen(function* () {
    // Retain the root-owned repository service. Do not snapshot configuration
    // while acquiring the layer: station.configure may happen after boot.
    const station = yield* StationRepository;

    return makeActorSeatOccupy({
      local: termPlane.host,
      localHostId: () =>
        station.configuration.pipe(
          Effect.map((record) => record?.configuration.hostId),
          Effect.mapError(asError),
        ),
      clientForOccupy: async (hostId) => {
        const client = await termPlane.router.clientForOccupy(hostId);
        // Keep routing/control details out of the WHEN. This is the complete
        // Remote process surface needed to inspect or occupy one actor seat.
        return {
          get: (bindingId) => client.get(bindingId),
          createAgentSeat: (input) => client.createAgentSeat(input),
        };
      },
    });
  }),
);
