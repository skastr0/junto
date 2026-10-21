/**
 * The seat-state source for automations (plan 0.10/07, runner rules owned by
 * pty): this machine's seat-state events, folded through the pure trigger
 * machine in `@shared/seat-state-trigger`, as firings an automation acts on.
 *
 * A firing names its seat by binding id (`SeatStateFiring.seat`). The runner
 * resolves it to the agent node whose `bindingId` it is, on a canvas this
 * machine edits, and drops it otherwise. A firing's `key` is unique per seat,
 * epoch, state and episode, so the runner claims it once.
 *
 * The rules: idle and working fire after holding 30 s, attention once per
 * episode, gone 60 s after its exit when no new generation takes the seat,
 * unknown never. A cache cut is invisible. On start every seat's current
 * state counts as settled, so a restart fires nothing.
 */
import { Context, type Stream } from "effect";
import type { SeatStateFiring } from "@shared/seat-state-trigger";

export class SeatStateSource extends Context.Service<
  SeatStateSource,
  {
    /** Every firing from the moment of subscribing on, in the order they happened. */
    readonly firings: Stream.Stream<SeatStateFiring>;
  }
>()("@junto/SeatStateSource") {}
