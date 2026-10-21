import type { MailMessageId, MailSenderStamp } from "./crew";
import type { NodeId } from "./physics/schema";
import { REFUSAL } from "./resource-command";
import { refusalText, subjectNoticeRecipients, type SubjectNoticeInput } from "./subject-notice";
import {
  formatTaskNumber,
  type Reviewer,
  type SeatNodeId,
  type TaskCommandKind,
  type TaskEffect,
  type TaskId,
  type TaskNodeId,
  type TaskNumber,
  type TaskRefusal,
  type TaskRefusalDetail,
} from "./task-model";
import type { ResourceSubject } from "./thread-subject";
import type { OpId } from "./work-ids";

/**
 * The mail a ruled task command owes (`TaskEffect`, task-model.ts), as
 * subject notices in the task's thread. The actor's own machine runs this
 * when its cursor covers the applied ruling and appends each row; a refused
 * command gets one refusal notice in the actor seat's own mailbox. Pure.
 *
 * A task has one thread, and its id is the task's: a task id is a ULID, so
 * every comment and notice on the task groups under it with no lookup, on
 * every node the task is sent on to.
 */

/** The task a ruling was about, as its notices name it. */
export type NoticedTask = {
  readonly node: TaskNodeId;
  readonly taskId: TaskId;
  /** Absent while the task is pending: the editing machine mints it. */
  readonly number?: TaskNumber;
  readonly title: string;
  /** The assignee, who hears a reviewer's defect. */
  readonly assignee?: SeatNodeId;
};

export const taskSubjectOf = (task: Pick<NoticedTask, "node" | "taskId">): ResourceSubject => ({
  kind: "task",
  nodeId: task.node,
  taskId: task.taskId,
});

/** The task's one thread. */
export const taskThreadOf = (task: Pick<NoticedTask, "taskId">): MailMessageId => task.taskId as string as MailMessageId;

/** `T-42 fix tabs`, or the title alone while the task has no number. */
export const taskName = (task: Pick<NoticedTask, "number" | "title">): string =>
  task.number === undefined ? task.title : `${formatTaskNumber(task.number)} ${task.title}`;

const reviewerName = (reviewer: Reviewer, nameOf: (seat: SeatNodeId) => string): string =>
  reviewer.kind === "operator" ? "the operator" : nameOf(reviewer.seat);

export type AppliedTaskRuling = {
  readonly installationId: string;
  readonly opId: OpId;
  readonly task: NoticedTask;
  /** The seat or operator who sent the command, stamped as the notices' sender. */
  readonly sender: MailSenderStamp;
  /** The actor's node, which is never told about its own act. Absent for the operator and automations. */
  readonly actor?: SeatNodeId;
  readonly effects: ReadonlyArray<TaskEffect>;
  readonly nameOf: (seat: SeatNodeId) => string;
};

type OpNotice = Extract<SubjectNoticeInput, { readonly kind: "assignment" | "stamp-request" | "defect" }>;

/**
 * One effect's recipients and text. Only seats get mail: the operator reads
 * stamp requests on the needs-you feed. `number-minted` and `sent-on` are
 * records, not mail.
 */
const mailOf = (
  effect: TaskEffect,
  ruling: AppliedTaskRuling,
): { readonly kind: OpNotice["kind"]; readonly to: SeatNodeId; readonly text: string } | undefined => {
  const by = ruling.sender.senderName ?? "a seat";
  const name = taskName(ruling.task);
  switch (effect.kind) {
    case "assignment-notice":
      return { kind: "assignment", to: effect.seat, text: `${by} assigned you ${name}` };
    case "stamp-request":
      return effect.reviewer.kind === "seat"
        ? { kind: "stamp-request", to: effect.reviewer.seat, text: `${by} asks for your stamp on ${name}` }
        : undefined;
    case "defect":
      return ruling.task.assignee === undefined
        ? undefined
        : {
            kind: "defect",
            to: ruling.task.assignee,
            text: [`${reviewerName(effect.by, ruling.nameOf)} asked for changes on ${name}`, ...(effect.text === undefined ? [] : [effect.text])].join("\n"),
          };
    case "number-minted":
    case "sent-on":
      return undefined;
  }
};

/** Every notice an applied ruling owes, one per (effect, seat), never to the actor. */
export const taskRulingNotices = (ruling: AppliedTaskRuling): ReadonlyArray<OpNotice> =>
  ruling.effects.flatMap((effect): ReadonlyArray<OpNotice> => {
    const mail = mailOf(effect, ruling);
    if (mail === undefined || subjectNoticeRecipients([mail.to], ruling.actor).length === 0) return [];
    return [{
      kind: mail.kind,
      installationId: ruling.installationId,
      sourceId: ruling.opId,
      subject: taskSubjectOf(ruling.task),
      threadId: taskThreadOf(ruling.task),
      recipient: mail.to as NodeId,
      text: mail.text,
      sender: ruling.sender,
    }];
  });

/** What a refusal lost to, in words. */
export const taskRefusalLostTo = (detail: TaskRefusalDetail, nameOf: (seat: SeatNodeId) => string): string | undefined => {
  switch (detail.kind) {
    case "illegal-transition":
      return `the task is ${detail.from}, where ${detail.command} does not apply`;
    case "not-assignee":
      return detail.assignee === undefined ? "the task has no assignee" : `${nameOf(detail.assignee)} holds the task`;
    case "already-assigned":
      return `${nameOf(detail.assignee)} already holds the task`;
    case "seat-busy":
      return `${nameOf(detail.seat)} already works task ${detail.taskId}`;
    case "not-reviewer":
      return `${reviewerName(detail.reviewer, nameOf)} is not a reviewer of the task`;
    case "own-task":
      return `${nameOf(detail.seat)} cannot review its own task`;
    case "stale-epoch":
      return `the task moved on to epoch ${String(detail.expected)}`;
    case "next-required":
      return `finishing needs a next node: ${detail.choices.join(", ")}`;
    case "next-not-downstream":
      return `${detail.next} is not downstream; choices: ${detail.choices.join(", ")}`;
    case "invalid-policy":
      return `a stamp policy of ${String(detail.required)} is not allowed`;
    case "dependency-cycle":
      return `it would close a dependency cycle through ${detail.through.join(", ")}`;
    case "unknown-task":
      return `there is no task ${detail.taskId}`;
    case "task-exists":
      return `task ${detail.taskId} already exists`;
  }
};

export type RefusedTaskRuling = {
  readonly installationId: string;
  readonly opId: OpId;
  readonly task: NoticedTask;
  readonly command: TaskCommandKind;
  readonly refusal: TaskRefusal;
  /** The seat whose command was refused, told in its own mailbox. */
  readonly actor: SeatNodeId;
  /** The task node, which the notice is written from. */
  readonly nodeName: string;
  readonly dependents?: ReadonlyArray<OpId>;
  readonly nextStep?: string;
  readonly nameOf: (seat: SeatNodeId) => string;
};

/** The one notice a refused task command owes its actor: from the task node, no reply. */
export const taskRefusalNotice = (ruling: RefusedTaskRuling): Extract<SubjectNoticeInput, { readonly kind: "refusal" }> => {
  const family = REFUSAL[ruling.refusal.reason];
  const lostTo = taskRefusalLostTo(ruling.refusal.detail, ruling.nameOf);
  return {
    kind: "refusal",
    installationId: ruling.installationId,
    sourceId: ruling.opId,
    subject: taskSubjectOf(ruling.task),
    threadId: taskThreadOf(ruling.task),
    recipient: ruling.actor,
    from: { nodeId: ruling.task.node, name: ruling.nodeName },
    text: refusalText({
      command: `task ${ruling.command} on ${taskName(ruling.task)}`,
      error: {
        type: family.type,
        message: ruling.refusal.reason,
        details: { retryable: family.retryable, ...(ruling.nextStep === undefined ? {} : { next_step: ruling.nextStep }) },
      },
      ...(lostTo === undefined ? {} : { lostTo }),
      ...(ruling.dependents === undefined ? {} : { dependents: ruling.dependents }),
    }),
  };
};
