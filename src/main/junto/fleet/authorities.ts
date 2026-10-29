/**
 * This machine's canvas authorities (0.11/06 F2): the one way a ruler
 * reaches the driver. Behind AUTHORITY_ENABLED a ruler judges its batch here,
 * on the canvas it rules, and the host opens that canvas's authority as it
 * first needs it. The tag stands alone so a ruler can import it without the
 * driver, which reads the rulers' own stores.
 */
import { Context, type Effect } from "effect";
import type { FleetDriverError, Judgment } from "./driver";

export class CanvasAuthorities extends Context.Service<
  CanvasAuthorities,
  {
    /** Judge a batch on `canvasName`'s authority, opening it first if this machine holds it open no more. */
    readonly judge: <A, E, R>(canvasName: string, batch: Effect.Effect<A, E, R>) => Effect.Effect<Judgment<A>, E | FleetDriverError, R>;
  }
>()("@junto/CanvasAuthorities") {}
