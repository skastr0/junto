/**
 * This machine's canvas authorities (0.11/06 F2): the one way a ruler
 * reaches the driver. Behind AUTHORITY_ENABLED a ruler judges its batch here,
 * on the canvas it rules, and the host opens that canvas's authority as it
 * first needs it. The tag stands alone so a ruler can import it without the
 * driver, which reads the rulers' own stores.
 *
 * F5 adds the operator's side: the read every surface shows, the list edit
 * and the fork, all answered from the same driver state.
 */
import { Context, type Effect } from "effect";
import type { AuthorityMachineFacts, AuthorityRead } from "@shared/authority";
import type { Entry } from "./consensus";
import type { FleetDriverError, Judgment } from "./driver";

export class CanvasAuthorities extends Context.Service<
  CanvasAuthorities,
  {
    /** Judge a batch on `canvasName`'s authority, opening it first if this machine holds it open no more. */
    readonly judge: <A, E, R>(canvasName: string, batch: Effect.Effect<A, E, R>) => Effect.Effect<Judgment<A>, E | FleetDriverError, R>;
    /** Wait until a judged entry applies on this machine, opening the canvas's authority first; fails retryable as its `landed` does. */
    readonly landed: (canvasName: string, entry: Pick<Entry, "index" | "term">) => Effect.Effect<void, FleetDriverError>;
    /** One canvas's read, or every canvas this machine holds, in canvas order. */
    readonly status: (canvasName?: string) => Effect.Effect<ReadonlyArray<AuthorityRead>, FleetDriverError>;
    /** The operator's ordered list by machine name: propose the joint entry, then answer the read it left. */
    readonly setList: (canvasName: string, order: ReadonlyArray<string>) => Effect.Effect<AuthorityRead, FleetDriverError>;
    /** The operator's fork on a pair that cannot commit: this machine becomes the sole voter. */
    readonly alone: (canvasName: string) => Effect.Effect<AuthorityRead, FleetDriverError>;
    /** This machine and every pinned peer, as the status command and the view name them. */
    readonly machines: () => Effect.Effect<{ readonly self: AuthorityMachineFacts; readonly machines: ReadonlyArray<AuthorityMachineFacts> }, FleetDriverError>;
  }
>()("@junto/CanvasAuthorities") {}
