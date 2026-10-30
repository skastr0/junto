/**
 * Seat generation credentials, for the one process that is not the terminal
 * plane (0.12): Electron main's browser control server admits a seat at its
 * door, and the registry that mints, suspends and revokes those credentials
 * lives in the core, where the seats are spawned (term/local-host.ts).
 *
 * Main asks here by credential and gets the status and principal back, never
 * a credential. Every publish, suspension and revocation is published as it
 * happens, so a grant main already cached is torn down at once: a suspended
 * seat fails closed on its next request, and a revoked one hears the sentence
 * it would hear at the work socket. A call that cannot be answered refuses.
 */
import { Effect } from "effect";
import { SEAT_CREDENTIAL_CHANGED, type SeatCredentialChanged } from "../channels";
import { getSeatCredentialRegistry } from "../../junto/work/seat-credentials";
import { coreOps, type CoreOp } from "../ops";
import { publish } from "../push";

type Lookup = ReturnType<ReturnType<typeof getSeatCredentialRegistry>["lookup"]>;

declare module "../ops" {
  interface CoreOps {
    /** The same lookup the work socket admits on, for main's browser door. */
    "seatCredential.lookup": CoreOp<{ readonly credential: string }, Lookup>;
    /** Every live generation and its seat; never a credential value. */
    "seatCredential.live": CoreOp<Record<string, never>, ReturnType<ReturnType<typeof getSeatCredentialRegistry>["liveGenerations"]>>;
  }
}

// A generation that ends takes what it was granted, wherever the grant lives.
getSeatCredentialRegistry().subscribe((event) => publish(SEAT_CREDENTIAL_CHANGED, event satisfies SeatCredentialChanged));

coreOps({
  "seatCredential.lookup": ({ credential }) =>
    Effect.sync(() => getSeatCredentialRegistry().lookup(credential)),
  "seatCredential.live": () => Effect.sync(() => getSeatCredentialRegistry().liveGenerations()),
});
