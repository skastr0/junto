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

export const stampMailboxDeliveryReceipt = Effect.fn("Work.stampMailboxDeliveryReceipt")(function* (
  input: { readonly deliveryId: string; readonly canvas: string; readonly nodeId: string; readonly messageId: string },
) {
  const sql = yield* SqlClient.SqlClient;
  const repo = yield* WorkRepository;
  const model = yield* ModelService;
  const refs = yield* ModelActorRefs;
  return yield* sql.withTransaction(Effect.gen(function* () {
    const sink = { canvasName: input.canvas, nodeId: input.nodeId };
    if (yield* repo.hasAcceptedDelivery(sink, input.deliveryId)) return true;
    const current = yield* model.canvas(input.canvas);
    const actor = (yield* refs.read(input.canvas)).find((ref) => ref.nodeId === input.nodeId);
    if (!actor) return yield* new ModelNotFound({ what: "delivery actor", id: input.nodeId });
    yield* repo.acceptDelivery({
      sink,
      basis: canvasReceiptBasis({ canvasName: current.name, seq: current.seq }),
      receipt: {
        deliveryId: input.deliveryId,
        deliveredItem: { kind: "message", itemId: input.messageId, sink },
        actor,
        acceptedAt: new Date().toISOString(),
      },
    });
    return true;
  }));
});
