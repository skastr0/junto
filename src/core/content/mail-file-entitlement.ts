/**
 * Whether a machine may pull a file attached to an operator mail (including
 * long text stored as `LONG_TEXT_FILE`).
 *
 * The machine that edits the canvas serves a file only under an operator mail
 * it holds, read by primary key from `work_messages` (`heldMailRow`), whose
 * immutable work fact names the operator as author (`sentBy.seatId`), whose
 * `metadata.attachments` (`operatorFilesOf`, closed decode) names that exact
 * digest and length, and whose receiving seat lives on the asking machine now
 * (`entitledTo`). A seat's mail, another machine, or a seat that left the
 * asking machine opens nothing.
 */
import { Effect } from "effect";
import type { SqlClient } from "effect/sql";
import type { InstallationId } from "@shared/installation-id";
import { operatorFilesOf } from "@shared/mail-threads";
import { OPERATOR_ATTACHMENT_MAX_BYTES } from "@shared/operator-attachments";
import { entitledTo, type CanvasPlacement } from "@shared/work-exchange";
import type { Message } from "@shared/work-model";
import { OPERATOR_SEAT_ID } from "@shared/work-reference";
import { heldMailRow } from "../work/repository";

export type MailFileOwner = {
  readonly canvasName: string;
  readonly nodeId: string;
  readonly recordId: string;
};

export const operatorMailFileEntitled = (
  reader: SqlClient.SqlClient,
  input: {
    /** The message owner the store holds the file under: the mail in the seat's mailbox. */
    readonly owner: MailFileOwner;
    readonly sha256: string;
    readonly byteLength: number;
    readonly machine: InstallationId;
    /** This machine; only the canvas's editing machine serves operator mail files. */
    readonly self: InstallationId;
    /** The canvas's placement now: a seat that left the asking machine opens nothing. */
    readonly placement: CanvasPlacement;
  },
) =>
  Effect.gen(function* () {
    const { owner, sha256, byteLength, machine, self, placement } = input;
    if (placement.editor !== self) return false;
    if (byteLength > OPERATOR_ATTACHMENT_MAX_BYTES) return false;
    const mail = yield* heldMailRow(reader, {
      canvasName: owner.canvasName,
      nodeId: owner.nodeId,
      messageId: owner.recordId,
    });
    if (mail === undefined) return false;
    // Judge author from the immutable work fact as well as operatorFilesOf on metadata.
    if (mail.fact.body.operation !== "message.append") return false;
    if (mail.fact.body.sentBy.seatId !== OPERATOR_SEAT_ID) return false;
    const files = operatorFilesOf({
      messageId: owner.recordId,
      role: "user",
      parts: [],
      metadata: mail.metadata,
    } as Message);
    if (!files.some((ref) => ref.sha256 === sha256 && ref.byteLength === byteLength)) return false;
    return entitledTo(machine, mail.fact, placement);
  });
