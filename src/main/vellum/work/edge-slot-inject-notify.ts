/**
 * When a canvas commit adds a new edge from an agent seat to a slot-bearing
 * target, inject that target's edge contract into the seat's mailbox so the
 * agent learns the new command surface without re-onboarding.
 *
 * Mirrors msg-send-enable-notify (rising edges only, skip on open/first paint).
 * Pure planning lives in shared (planEdgeSlotInjections / composeEdgeSlotInjectionText).
 */

import { Effect } from "effect";
import { ulid } from "ulid";
import type { CanvasDoc } from "@shared/canvas";
import {
  composeEdgeSlotInjectionText,
  planEdgeSlotInjections,
} from "@shared/managed-terminal-injection";
import { makeUserMessage } from "@shared/task";
import type { CanvasChangeDetail } from "../canvases";
import { WorkService } from "./service";

export const deliverEdgeSlotInjections = (input: {
  readonly canvas: string;
  readonly previous: CanvasDoc;
  readonly next: CanvasDoc;
}): Effect.Effect<number, never, WorkService> =>
  Effect.gen(function* () {
    const plans = planEdgeSlotInjections(input.previous, input.next);
    if (plans.length === 0) return 0;
    const work = yield* WorkService;
    let sent = 0;
    for (const plan of plans) {
      const result = yield* work.workSystemMailboxNotify(
        input.canvas,
        plan.seatId,
        makeUserMessage({
          messageId: ulid(),
          text: composeEdgeSlotInjectionText(plan.target),
          contextId: input.canvas,
          metadata: {
            factoryLink: true,
            edgeSlot: true,
            targetId: plan.target.id,
            targetKind: plan.target.kind,
          },
        }),
      );
      if (result.ok) sent += 1;
    }
    return sent;
  }).pipe(Effect.catch(() => Effect.succeed(0)));

/**
 * Canvas change listener body. No previous doc ⇒ skip (open / first paint /
 * work-projection ticks without authorial topology delta).
 */
export const onCanvasChangeForEdgeSlots = (
  canvas: string,
  detail: CanvasChangeDetail | undefined,
): Effect.Effect<number, never, WorkService> => {
  if (detail?.previous === undefined || detail.next === undefined) {
    return Effect.succeed(0);
  }
  return deliverEdgeSlotInjections({
    canvas,
    previous: detail.previous,
    next: detail.next,
  });
};
