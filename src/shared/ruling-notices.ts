/**
 * The notices an applied ruling owes, as one machine writes them (plan 0.10,
 * 02 "What happens only at ruling"). Each is a resource's notice
 * (`noticeActorRef` from the task's node) in the recipient seat's own
 * mailbox, and only the machine that seat lives on writes it
 * (`authorWritesOn`), as it commits or folds the ruling. Every machine takes
 * every ruling, so each recipient is told once, by its own machine, and a
 * notice whose task node holds a seat is written by none. The id is derived
 * from (writing machine, opId, kind, seat): a ruling folded again on one
 * machine writes nothing, and a seat that moves between two folds gets one
 * notice from each machine, never one id under two writers, which a peer
 * would refuse and close the link on.
 *
 * Pure: no I/O, no clock.
 */
import type { RulingAppliedResult } from "./command-row";
import { mailAuthorOf, noticeActorRef } from "./mail-author";
import { noticeSenderStamp } from "./mail-sender";
import type { InstallationId } from "./installation-id";
import { subjectNoticeRow } from "./subject-notice";
import { decodeTaskFacts } from "./task-fact-wire";
import type { SeatNodeId } from "./task-model";
import { taskRulingNotices } from "./task-notices";
import { authorWritesOn, type CanvasPlacement } from "./work-exchange";
import type { Message } from "./work-model";
import type { ActorRef } from "./work-reference";

/** One notice as the repository commits it: where, from whom, and the message. */
export type RulingNoticeWrite = {
  readonly sink: { readonly canvasName: string; readonly nodeId: string };
  readonly sentBy: ActorRef;
  readonly message: Message;
};

/** The notices of this ruling that `self` writes: none for a domain that owes no mail, or facts that do not decode. */
export const rulingNoticesHere = (input: {
  readonly self: InstallationId;
  readonly canvasName: string;
  readonly ruling: RulingAppliedResult;
  readonly placement: CanvasPlacement;
}): ReadonlyArray<RulingNoticeWrite> => {
  const { ruling, placement, canvasName } = input;
  if (ruling.kind !== "task") return [];
  const facts = decodeTaskFacts(ruling.facts);
  const last = facts?.[facts.length - 1];
  if (facts === undefined || last === undefined) return [];
  const task = last.task;
  const nameOf = (nodeId: string): string => placement.nameOf?.(nodeId) ?? nodeId;
  const { actor } = ruling;
  const sentBy = noticeActorRef(canvasName, task.node);
  const notices = taskRulingNotices({
    installationId: input.self,
    opId: ruling.opId,
    task: {
      node: task.node,
      taskId: task.id,
      number: task.number,
      title: task.title,
      ...(task.assignee === undefined ? {} : { assignee: task.assignee }),
    },
    sender: noticeSenderStamp(task.node, nameOf(task.node)),
    by: actor.kind === "operator" ? "the operator" : nameOf(actor.nodeId),
    ...(actor.kind === "seat" ? { actor: actor.nodeId as SeatNodeId } : {}),
    effects: facts.flatMap((fact) => fact.effects),
    nameOf,
  });
  return notices.flatMap((notice) => {
    if (authorWritesOn(mailAuthorOf(sentBy, notice.recipient), placement) !== input.self) return [];
    const row = subjectNoticeRow(notice);
    return [{
      sink: { canvasName, nodeId: notice.recipient },
      sentBy,
      message: { messageId: row.messageId, role: "user", parts: [{ kind: "text", text: row.text }], metadata: row.metadata },
    }];
  });
};
