/**
 * The store mail delivery reads and stamps, over this machine's own model and
 * work log. Either shell hands it to `messageDelivery.configure` beside its
 * transport, so a core without a window delivers mail the way one with a
 * window does.
 */
import { Effect, Option } from "effect";
import type { SqlClient } from "effect/sql";
import type { Message } from "@shared/work-model";
import { BodyPuller } from "../content/body-puller";
import { deliverOperatorAttachmentLines } from "../content/mail-files-pull";
import { ContentService } from "../content/service";
import { MachineRepository } from "../machines/repository";
import { ModelActorRefs } from "../model/actor-refs";
import { ModelRecords } from "../model/records";
import { ModelService } from "../model/service";
import { recordDeliveryReceiptRefusal, stampMailboxDeliveryReceipt } from "./delivery-receipts";
import type { Log } from "../../node/observability/logger";
import { mailboxMessageDeliveryId, mailboxMessageReadId } from "./mailbox-receipts";
import type { MessageDeliveryStore } from "./message-delivery";
import { WorkRepository } from "./repository";

export const makeMessageDeliveryStore = (
  log?: Log,
  options?: { readonly onFilesReady?: (canvas: string, nodeId: string, message: Message) => void },
): Effect.Effect<
  MessageDeliveryStore,
  never,
  SqlClient.SqlClient | WorkRepository | ModelService | ModelActorRefs | ContentService | ModelRecords | MachineRepository
> => Effect.gen(function* () {
  const model = yield* ModelService;
  const repository = yield* WorkRepository;
  const content = yield* ContentService;
  const puller = yield* Effect.serviceOption(BodyPuller);
  const records = yield* ModelRecords;
  const machines = yield* MachineRepository;
  const context = yield* Effect.context<SqlClient.SqlClient | WorkRepository | ModelService | ModelActorRefs>();
  const run = Effect.runPromiseWith(context);
  return {
    listCanvasNames: () => run(model.listCanvases()),
    readModel: (name) => run(model.canvas(name).pipe(Effect.catch(() => Effect.succeed(undefined)))),
    readMessage: (canvas, nodeId, messageId) => run(repository.mailMessage(canvas, nodeId, messageId)),
    listMail: (canvas, nodeId) => run(repository.mailbox(canvas, nodeId)),
    attachmentLines: (canvas, nodeId, message) =>
      run(
        Effect.gen(function* () {
          const doc = yield* model.canvas(canvas).pipe(Effect.orElseSucceed(() => undefined));
          const read = deliverOperatorAttachmentLines({
            content,
            canvasName: canvas,
            canvas: doc,
            nodeId,
            message,
            ...(options?.onFilesReady === undefined ? {} : { onReady: () => options.onFilesReady?.(canvas, nodeId, message) }),
          });
          return yield* Option.isSome(puller) ? read.pipe(Effect.provideService(BodyPuller, puller.value)) : read;
        }).pipe(Effect.orElseSucceed(() => undefined)),
      ),
    // This machine edits the canvas when its installation is the canvas's
    // editor, or the canvas names none; unknown reads as not.
    editsCanvas: (canvas) =>
      run(
        Effect.gen(function* () {
          const editor = yield* records.canvasEditor(canvas);
          return editor === undefined || editor === (yield* machines.installationId);
        }).pipe(Effect.orElseSucceed(() => false)),
      ),
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
        recordDeliveryReceiptRefusal(canvas, nodeId, cause, log);
        return false;
      }),
  };
});
