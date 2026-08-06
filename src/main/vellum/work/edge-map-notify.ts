/**
 * One edge-notification theory: when a canvas commit adds or removes
 * slot-bearing edges for an agent seat, deliver exactly one compact map-change
 * notice — added contracts inline, removals as a re-orient hint. Never a full
 * doctrine re-injection, never a duplicate from a parallel subsystem.
 *
 * The former actor↔actor msg.send-enable notice path is folded into this
 * engine: an agent edge's msg contract arrives with the map change, so a
 * separate link notice would be a second, equivalent notification from a
 * different part of the program — the failure mode this module exists to
 * prevent.
 */

import { Effect } from "effect";
import { ulid } from "ulid";
import type { CanvasDoc } from "@shared/canvas";
import {
  composeEdgeMapChangeNotice,
  planEdgeMapChanges,
} from "@shared/managed-terminal-injection";
import { makeUserMessage } from "@shared/task";
import type { CanvasChangeDetail } from "../canvases";
import { WorkService } from "./service";

export const deliverEdgeMapChangeNotices = (input: {
  readonly canvas: string;
  readonly previous: CanvasDoc;
  readonly next: CanvasDoc;
}): Effect.Effect<number, never, WorkService> =>
  Effect.gen(function* () {
    const changes = planEdgeMapChanges(input.previous, input.next);
    if (changes.length === 0) return 0;
    const work = yield* WorkService;
    let sent = 0;
    for (const change of changes) {
      const result = yield* work.workSystemMailboxNotify(
        input.canvas,
        change.seatId,
        makeUserMessage({
          messageId: ulid(),
          text: composeEdgeMapChangeNotice(change),
          contextId: input.canvas,
          metadata: {
            factoryLink: true,
            edgeMapChange: true,
            addedIds: change.added.map((t) => t.id),
            removedIds: change.removed.map((t) => t.id),
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
export const onCanvasChangeForEdgeMap = (
  canvas: string,
  detail: CanvasChangeDetail | undefined,
): Effect.Effect<number, never, WorkService> => {
  if (detail?.previous === undefined || detail.next === undefined) {
    return Effect.succeed(0);
  }
  return deliverEdgeMapChangeNotices({
    canvas,
    previous: detail.previous,
    next: detail.next,
  });
};
