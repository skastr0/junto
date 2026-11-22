/**
 * The core's handlers of the loom-seed group: one canvas's seed, read at a
 * launch and written when the planner settles. A store failure answers a
 * tagged error, never a crash; the planner then routes as a first plan.
 */
import { Effect } from "effect";
import { LoomSeedRpcs, LoomSeedUnavailable } from "../../contract/core/loom-seed";
import { LoomSeedRepository } from "../loom-seed/repository";

const unavailable = (error: { readonly message: string }) => new LoomSeedUnavailable({ message: error.message });

export const LoomSeedHandlers = LoomSeedRpcs.toLayer(
  Effect.gen(function* () {
    const store = yield* LoomSeedRepository;
    return {
      LoomSeedLoad: ({ canvas }) => store.load(canvas).pipe(Effect.map((row) => row ?? null), Effect.mapError(unavailable)),
      LoomSeedSave: ({ canvas, routerVersion, seedJson }) =>
        store.save(canvas, routerVersion, seedJson).pipe(Effect.mapError(unavailable), Effect.as(true)),
    };
  }),
);
