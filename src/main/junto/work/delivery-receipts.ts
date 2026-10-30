import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { CanvasFactBasis } from "@shared/work-protocol";
import { ModelActorRefs } from "../model/actor-refs";
import { ModelNotFound } from "../model/records";
import { ModelService } from "../model/service";
import { recordSystemLog } from "../observability/logger";
import { WorkRepository } from "./repository";

/** A receipt names the current canvas sequence, never a retired document hash. */
export const canvasReceiptBasis = (current: { readonly canvasName: string; readonly seq: number }): CanvasFactBasis =>
  Schema.decodeUnknownSync(CanvasFactBasis)({ kind: "canvas", canvasName: current.canvasName, seq: current.seq });

export const recordDeliveryReceiptRefusal = (canvas: string, node: string, cause: unknown): void => {
  const reason = cause instanceof Error ? cause.message : String(cause);
  recordSystemLog(`Delivery receipt refused ${JSON.stringify({ canvas, node, reason })}`, "error");
};

/**
 * The receipt that a mail was typed into its seat. With `readId`, the read
 * receipt too, in the same transaction: mail typed whole is read, by the seat
 * whose mailbox it is, as `junto msg read` would mark it.
 */
export const stampMailboxDeliveryReceipt = Effect.fn("Work.stampMailboxDeliveryReceipt")(function* (
  input: {
    readonly deliveryId: string;
    readonly canvas: string;
    readonly nodeId: string;
    readonly messageId: string;
    readonly readId?: string;
  },
) {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* WorkRepository;
  const model = yield* ModelService;
  const refs = yield* ModelActorRefs;
  return yield* sql.withTransaction(Effect.gen(function* () {
    const sink = { canvasName: input.canvas, nodeId: input.nodeId };
    const receipts = [input.deliveryId, ...(input.readId === undefined ? [] : [input.readId])];
    const accepted = new Set(yield* repo.acceptedDeliveries(sink, receipts));
    const missing = receipts.filter((deliveryId) => !accepted.has(deliveryId));
    if (missing.length === 0) return true;
    // One actor by its own key, and the count alone: a mail typed into a seat
    // never loads the canvas or every reference on it.
    const actor = yield* refs.seat(input.canvas, input.nodeId);
    if (actor === undefined) return yield* new ModelNotFound({ what: "delivery actor", id: input.nodeId });
    const basis = canvasReceiptBasis({ canvasName: input.canvas, seq: yield* model.seq(input.canvas) });
    const acceptedAt = new Date().toISOString();
    for (const deliveryId of missing) {
      yield* repo.acceptDelivery({
        sink,
        basis,
        receipt: {
          deliveryId,
          deliveredItem: { kind: "message", itemId: input.messageId, sink },
          actor,
          acceptedAt,
        },
      });
    }
    return true;
  }));
});
