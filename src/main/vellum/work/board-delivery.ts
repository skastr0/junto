// Operator megaphone for bulletin boards.
// Agent posts never call this path. Best-effort inject; process-local at-most-once.

import { Effect } from "effect";
import { ulid } from "ulid";
import type { CanvasDoc } from "@shared/canvas";
import {
  boardWakeInjectId,
  composeBoardInjectEnvelope,
  resolveBoardWakeSet,
  type BoardWakeEvent,
  type BoardWakeKind,
} from "@shared/board-wake";
import { CanvasesService } from "../canvases";

type Transport = {
  readonly sendManagedTerminalPrompt: (
    bindingId: string,
    text: string,
  ) => Promise<boolean>;
};

let transport: Transport | undefined;
const accepted = new Set<string>();

export const configureBoardDelivery = (next: Transport): void => {
  transport = next;
};

export const deliverBoardWake = (input: {
  readonly canvas: string;
  readonly boardNodeId: string;
  readonly kind: BoardWakeKind;
  readonly topicId?: string;
  readonly topicTitle?: string;
  readonly excerptSource: string;
}): Effect.Effect<number, never, CanvasesService> =>
  Effect.gen(function* () {
    if (!transport) return 0;
    const canvases = yield* CanvasesService;
    const read = yield* canvases
      .read(input.canvas)
      .pipe(Effect.catchAll(() => Effect.succeed(undefined)));
    if (!read) return 0;
    const doc = read.doc as CanvasDoc;
    const wake: BoardWakeEvent = {
      wakeEventId: ulid(),
      canvasName: input.canvas,
      boardNodeId: input.boardNodeId,
      kind: input.kind,
      ...(input.topicId ? { topicId: input.topicId } : {}),
      ...(input.topicTitle ? { topicTitle: input.topicTitle } : {}),
      excerptSource: input.excerptSource,
      createdAt: Date.now(),
    };
    const seats = resolveBoardWakeSet(doc, input.boardNodeId);
    const payload = composeBoardInjectEnvelope(wake);
    let sent = 0;
    for (const seat of seats) {
      const deliveryId = boardWakeInjectId(
        input.canvas,
        seat.nodeId,
        wake.wakeEventId,
      );
      if (accepted.has(deliveryId)) continue;
      const bindingId = seat.target.bindingId;
      if (!bindingId) continue;
      const ok = yield* Effect.tryPromise({
        try: () => transport!.sendManagedTerminalPrompt(bindingId, payload),
        catch: () => false as const,
      }).pipe(Effect.catchAll(() => Effect.succeed(false)));
      if (!ok) continue;
      accepted.add(deliveryId);
      sent += 1;
    }
    return sent;
  }).pipe(Effect.catchAll(() => Effect.succeed(0)));
