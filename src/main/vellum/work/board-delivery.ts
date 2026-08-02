// Operator megaphone for bulletin boards.
// Agent posts never call this path. Best-effort inject; process-local at-most-once.

import { Effect } from "effect";
import { ulid } from "ulid";
import type { CanvasDoc } from "@shared/canvas";
import {
  boardWakeInjectId,
  composeBoardInjectEnvelope,
  resolveBoardWakeSet,
  type BoardWakeSeat,
  type BoardWakeEvent,
  type BoardWakeKind,
} from "@shared/board-wake";
import { CanvasesService } from "../canvases";

export type BoardDeliveryTransport = {
  /** Start a local lazy managed seat before the board prompt is queued. */
  readonly wakeManagedSeat?: (
    canvas: string,
    nodeId: string,
  ) => boolean | Promise<boolean>;
  readonly sendManagedTerminalPrompt: (
    bindingId: string,
    text: string,
    options?: { readonly ready?: boolean },
  ) => Promise<boolean>;
};

let transport: BoardDeliveryTransport | undefined;
const accepted = new Set<string>();

export const configureBoardDelivery = (next: BoardDeliveryTransport): void => {
  transport = next;
};

/** Deliver one already-composed wake to its resolved actor seats. */
export const deliverBoardWakeSeats = async (input: {
  readonly canvas: string;
  readonly wake: BoardWakeEvent;
  readonly payload: string;
  readonly seats: ReadonlyArray<BoardWakeSeat>;
  readonly transport: BoardDeliveryTransport;
}): Promise<number> => {
  let sent = 0;
  for (const seat of input.seats) {
    const deliveryId = boardWakeInjectId(
      input.canvas,
      seat.nodeId,
      input.wake.wakeEventId,
    );
    if (accepted.has(deliveryId)) continue;
    const bindingId = seat.target.bindingId;
    if (!bindingId) continue;
    if (input.transport.wakeManagedSeat) {
      let woke = false;
      try {
        woke = await input.transport.wakeManagedSeat(input.canvas, seat.nodeId);
      } catch {
        woke = false;
      }
      if (!woke) continue;
    }
    let ok = false;
    try {
      ok = await input.transport.sendManagedTerminalPrompt(
        bindingId,
        input.payload,
        input.transport.wakeManagedSeat ? { ready: true } : undefined,
      );
    } catch {
      ok = false;
    }
    if (!ok) continue;
    accepted.add(deliveryId);
    sent += 1;
  }
  return sent;
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
      .pipe(Effect.catch(() => Effect.succeed(undefined)));
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
    return yield* Effect.promise(() =>
      deliverBoardWakeSeats({
        canvas: input.canvas,
        wake,
        payload,
        seats,
        transport: transport!,
      }),
    );
  }).pipe(Effect.catch(() => Effect.succeed(0)));
