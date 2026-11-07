/**
 * Main's handlers of the window's seat-cache-due group
 * (src/contract/window/seat-cache-due.ts): the auto cache mode's answer and
 * the operator's offboard run and status go to the core's group as they are,
 * and the seats due the question are a follow stream over the core's notice.
 * The seats and their views run in the core (src/contract/core/seat-cache-due.ts),
 * the same operation the overseer and the automatic rules go through
 * (seat-sessions/operator-offboard.ts). What the window sends is decoded
 * closed by the group's own schemas, here and at the core.
 */
import { Effect } from "effect";
import { SEAT_CACHE_DUE_CHANGED } from "../../contract/core/channels";
import { SeatCacheDueCore } from "../../contract/core/seat-cache-due";
import { SeatCacheDueForwarded, SeatCacheDueWindowRpcs } from "../../contract/window/seat-cache-due";
import { following, forwardTo } from "../window/ipc";

export const SeatCacheDueWindowHandlers = SeatCacheDueWindowRpcs.toLayer(
  Effect.gen(function* () {
    const due = yield* SeatCacheDueCore;
    return {
      ...forwardTo(SeatCacheDueForwarded, due),
      // The core's notice carries nothing: each one reads the whole list again.
      SeatCacheDueFollow: () => following(SEAT_CACHE_DUE_CHANGED, due.SeatCacheDueList()),
    };
  }),
);
