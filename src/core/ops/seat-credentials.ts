/**
 * The core's handler of the seat credential lookup
 * (src/contract/core/seat-credentials.ts), for the one process that is not
 * the terminal plane: Electron main's browser control server admits a seat at
 * its door, and the registry that mints, suspends and revokes those
 * credentials lives here, where the seats are spawned (term/local-host.ts).
 *
 * While the handlers live, every publish and revocation is pushed as it
 * happens, in order, so a grant main already cached is torn down at once: a
 * suspended seat fails closed on its next request, and a revoked one hears the
 * sentence it would hear at the work socket.
 */
import { Effect, Queue } from "effect";
import { SEAT_CREDENTIAL_CHANGED } from "../../contract/core/channels";
import { SeatCredentialsRpcs } from "../../contract/core/seat-credentials";
import { getSeatCredentialRegistry, type SeatCredentialEvent } from "../work/seat-credentials";
import { CorePushes } from "../push";

export const SeatCredentialsHandlers = SeatCredentialsRpcs.toLayer(
  Effect.gen(function* () {
    const registry = getSeatCredentialRegistry();
    const pushes = yield* CorePushes;
    // A generation that ends takes what it was granted, wherever the grant lives.
    const changes = yield* Queue.unbounded<SeatCredentialEvent>();
    yield* Effect.acquireRelease(
      Effect.sync(() => registry.subscribe((event) => Queue.offerUnsafe(changes, event))),
      (unsubscribe) => Effect.sync(unsubscribe),
    );
    yield* Queue.take(changes).pipe(
      Effect.flatMap((event) => pushes.publish(SEAT_CREDENTIAL_CHANGED, event)),
      Effect.forever,
      Effect.forkScoped,
    );
    return {
      SeatCredentialsLookup: ({ credential }) => Effect.sync(() => registry.lookup(credential)),
    };
  }),
);
