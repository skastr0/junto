/**
 * The store mail delivery reads and stamps, over this machine's own model and
 * work log. Either shell hands it to `messageDelivery.configure` beside its
 * transport, so a core without a window delivers mail the way one with a
 * window does.
 */
import { Effect } from "effect";
import type { SqlClient } from "effect/unstable/sql";
import { attachmentsOf } from "@shared/mail-threads";
import { operatorAttachmentLines } from "../content/operator-attachments";
import { ContentService } from "../content/service";
import { ModelActorRefs } from "../model/actor-refs";
import { ModelService } from "../model/service";
import { recordDeliveryReceiptRefusal, stampMailboxDeliveryReceipt } from "./delivery-receipts";
import { mailboxMessageDeliveryId, mailboxMessageReadId } from "./mailbox-receipts";
import type { MessageDeliveryStore } from "./message-delivery";
import { WorkRepository } from "./repository";

export const makeMessageDeliveryStore: Effect.Effect<
  MessageDeliveryStore,
  never,
  SqlClient.SqlClient | WorkRepository | ModelService | ModelActorRefs | ContentService
> = Effect.gen(function* () {
  const model = yield* ModelService;
  const repository = yield* WorkRepository;
  const content = yield* ContentService;
  const context = yield* Effect.context<SqlClient.SqlClient | WorkRepository | ModelService | ModelActorRefs>();
  const run = Effect.runPromiseWith(context);
  return {
    listCanvasNames: () => run(model.listCanvases()),
    readModel: (name) => run(model.canvas(name).pipe(Effect.catch(() => Effect.succeed(undefined)))),
    readMessage: (canvas, nodeId, messageId) => run(repository.mailMessage(canvas, nodeId, messageId)),
    listMail: (canvas, nodeId) => run(repository.mailbox(canvas, nodeId)),
    attachmentLines: (canvas, nodeId, message) => {
      const refs = attachmentsOf(message);
      return run(
        operatorAttachmentLines(content, { canvasName: canvas, nodeId, messageId: message.messageId, refs }).pipe(
          // A file this store does not hold (its bytes are still on their way
          // from another machine) is not delivered with a path to nothing.
          Effect.map((lines) => (lines.length === refs.length && lines.every((line) => !line.endsWith(": ")) ? lines : undefined)),
          Effect.orElseSucceed(() => undefined),
        ),
      );
    },
    acceptMessageDelivery: (canvas, nodeId, messageId, read) =>
      run(
        stampMailboxDeliveryReceipt({
          deliveryId: mailboxMessageDeliveryId(canvas, nodeId, messageId),
          canvas,
          nodeId,
          messageId,
          ...(read ? { readId: mailboxMessageReadId(canvas, nodeId, messageId) } : {}),
        }),
      ).catch((cause: unknown) => {
        recordDeliveryReceiptRefusal(canvas, nodeId, cause);
        return false;
      }),
  };
});
