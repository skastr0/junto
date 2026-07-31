// When actor↔actor msg.send becomes newly granted on an authorial canvas
// commit, append a durable mailbox notice so seats learn without re-onboarding.

import { Effect } from "effect";
import { ulid } from "ulid";
import type { CanvasDoc } from "@shared/canvas";
import {
  composeMsgSendEnableMailboxText,
  planMsgSendEnableNotices,
} from "@shared/msg-send-enable";
import { makeUserMessage } from "@shared/task";
import type { CanvasChangeDetail } from "../canvases";
import { WorkService } from "./service";

export const deliverMsgSendEnableNotices = (input: {
  readonly canvas: string;
  readonly previous: CanvasDoc;
  readonly next: CanvasDoc;
}): Effect.Effect<number, never, WorkService> =>
  Effect.gen(function* () {
    const notices = planMsgSendEnableNotices(input.previous, input.next);
    if (notices.length === 0) return 0;
    const work = yield* WorkService;
    let sent = 0;
    for (const notice of notices) {
      const result = yield* work.workSystemMailboxNotify(
        input.canvas,
        notice.recipientId,
        makeUserMessage({
          messageId: ulid(),
          text: composeMsgSendEnableMailboxText(notice),
          contextId: input.canvas,
          metadata: {
            factoryLink: true,
            msgSendEnabled: true,
            peerId: notice.peerId,
          },
        }),
      );
      if (result.ok) sent += 1;
    }
    return sent;
  }).pipe(Effect.catchAll(() => Effect.succeed(0)));

/**
 * Canvas change listener body. No previous doc ⇒ skip (open / first paint /
 * work-projection ticks without authorial topology delta).
 */
export const onCanvasChangeForMsgSendEnable = (
  canvas: string,
  detail: CanvasChangeDetail | undefined,
): Effect.Effect<number, never, WorkService> => {
  if (detail?.previous === undefined || detail.next === undefined) {
    return Effect.succeed(0);
  }
  return deliverMsgSendEnableNotices({
    canvas,
    previous: detail.previous,
    next: detail.next,
  });
};
