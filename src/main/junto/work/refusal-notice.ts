/**
 * The seat's machine tells a seat its command was refused (plan 0.10, 02
 * "Refusal and rollback" point 4). When this machine takes a `ruling.refused`
 * for one of its own commands, it reads its own command row and queue and
 * builds the one notice (`refusalNoticeOf`). The repository writes it, in the
 * same transaction, as a local `message.append` into the actor seat's own
 * mailbox under the resource's notice author (`noticeActorRef`), so the stored
 * row is from the refused node. Only main writes it, and only from a ruling.
 */
import { Effect, Option, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { CommandQueuedResult, type RulingRefusedResult } from "@shared/command-row";
import { mailAuthorOf, noticeActorRef } from "@shared/mail-author";
import { refusalNoticeOf, type QueuedLink } from "@shared/refusal-notice";
import type { ActorRef } from "@shared/work-protocol";
import type { Message } from "@shared/work-model";
import { authorWritesOn, type CanvasPlacement } from "@shared/work-exchange";

const decodeCommandRow = Schema.decodeUnknownOption(Schema.fromJsonString(CommandQueuedResult));

/** The notice as the repository commits it: where, from whom, and the message. */
export type RefusalNoticeWrite = {
  readonly sink: { readonly canvasName: string; readonly nodeId: string };
  readonly sentBy: ActorRef;
  readonly message: Message;
};

/**
 * The notice to write for a refusal this machine just took, or none: a ruling
 * for another machine's command, a dependent, an actor that is no seat, a
 * command row this machine does not hold, a notice already written, or one
 * this machine may not write: a command aimed at a seat's node, or at the
 * actor's own, would give a row the editing machine refuses, and main never
 * writes a row its own admission would refuse.
 */
export const refusalNoticeWrite = Effect.fn("work.refusalNoticeWrite")(function* (
  reader: SqlClient.SqlClient,
  self: string,
  canvasName: string,
  ruling: RulingRefusedResult,
  placement: CanvasPlacement,
) {
  if (ruling.writer !== self || ruling.root !== ruling.opId || ruling.actor.kind !== "seat") return undefined;
  const rows = yield* reader.unsafe<{ item_id: string; result_json: string }>(
    `
      SELECT event.item_id, fact.result_json
      FROM work_events AS event
      JOIN work_facts AS fact USING (event_home, entity_home, seq)
      WHERE event.event_home = ?
        AND event.entity_home = ?
        AND event.item_canvas_name = ?
        AND event.item_kind = 'command'
        AND event.operation = 'command.queued'
      ORDER BY length(event.seq), event.seq
    `,
    [self, self, canvasName],
  );
  const queue: QueuedLink[] = [];
  let command: CommandQueuedResult["command"] | undefined;
  for (const row of rows) {
    const held = Option.getOrUndefined(decodeCommandRow(row.result_json));
    if (held === undefined) continue;
    queue.push({ opId: held.command.opId, after: held.command.after });
    if (held.command.opId === ruling.opId) command = held.command;
  }
  if (command === undefined) return undefined;
  const notice = refusalNoticeOf({ installationId: self, ruling, command, queue });
  if (notice === undefined) return undefined;
  const sentBy = noticeActorRef(canvasName, command.target.nodeId);
  if (authorWritesOn(mailAuthorOf(sentBy, notice.recipient), placement) !== self) return undefined;
  const written = yield* reader.unsafe<{ found: number }>(
    "SELECT 1 AS found FROM work_messages WHERE canvas_name = ? AND node_id = ? AND message_id = ? LIMIT 1",
    [canvasName, notice.recipient, notice.row.messageId],
  );
  if (written.length > 0) return undefined;
  return {
    sink: { canvasName, nodeId: notice.recipient },
    sentBy,
    message: {
      messageId: notice.row.messageId,
      role: "user",
      parts: [{ kind: "text", text: notice.row.text }],
      metadata: notice.row.metadata,
    },
  } satisfies RefusalNoticeWrite;
});

/**
 * The domain of one of this machine's own commands a refusal just ruled, read
 * from its command row: its panes read their pending writes again. Undefined
 * for another machine's command or a row this machine does not hold.
 */
export const refusedKindOf = Effect.fn("work.refusedKindOf")(function* (
  reader: SqlClient.SqlClient,
  self: string,
  canvasName: string,
  ruling: RulingRefusedResult,
) {
  if (ruling.writer !== self) return undefined;
  const rows = yield* reader.unsafe<{ result_json: string }>(
    `
      SELECT fact.result_json
      FROM work_events AS event
      JOIN work_facts AS fact USING (event_home, entity_home, seq)
      WHERE event.event_home = ? AND event.entity_home = ? AND event.item_canvas_name = ?
        AND event.item_kind = 'command' AND event.operation = 'command.queued' AND event.item_id = ?
      LIMIT 1
    `,
    [self, self, canvasName, ruling.opId],
  );
  const held = rows[0] === undefined ? undefined : Option.getOrUndefined(decodeCommandRow(rows[0].result_json));
  return held?.command.target.kind;
});
