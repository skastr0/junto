/**
 * The mail an applied task ruling owes (pty P4, plan 0.10 03 and 04): each
 * `TaskEffect` that tells a seat something becomes one subject notice in the
 * task's thread, appended to that seat's mailbox as the actor's mail. The
 * actor's own machine runs this when the ruling applies; the notice id is
 * derived from (installation, opId, kind, seat), so a ruling delivered twice
 * writes each row once.
 */
import { Effect, Option } from "effect";
import type { MailSenderStamp } from "@shared/crew";
import type { Canvas } from "@shared/model";
import { asNodeId, mailSenderRegions } from "@shared/model";
import { titleOf } from "@shared/model/title";
import type { ResourceActor } from "@shared/resource-command";
import { subjectNoticeRow } from "@shared/subject-notice";
import { makeUserMessage } from "@shared/task";
import type { TaskRecord } from "@shared/task-machine";
import type { SeatNodeId, TaskEffect } from "@shared/task-model";
import { taskRulingNotices } from "@shared/task-notices";
import type { WorkErrorBody } from "@shared/work-control";
import type { OpId } from "@shared/work-ids";
import { MachineRepository } from "../machines/repository";
import { WorkService } from "./service";

export type TaskDelivery = {
  readonly canvas: Canvas;
  readonly canvasName: string;
  readonly actor: ResourceActor;
  readonly opId: OpId;
  readonly task: TaskRecord;
  readonly effects: ReadonlyArray<TaskEffect>;
};

const notBuilt = (what: string): WorkErrorBody => ({
  type: "RuntimeDown",
  message: `${what} is not running in this process`,
  details: { retryable: true },
});

/** The actor as its notices name it: the seat's canvas name and regions. */
const senderOf = (canvas: Canvas, actor: Extract<ResourceActor, { readonly kind: "seat" }>): MailSenderStamp => {
  const node = canvas.nodes.get(asNodeId(actor.nodeId));
  return {
    fromSeat: actor.seatId,
    senderNodeId: actor.nodeId,
    senderName: node === undefined ? actor.nodeId : titleOf(node),
    senderRegions: mailSenderRegions(canvas, actor.nodeId),
    senderGeneration: "ruling",
    senderHarness: node?.kind === "agent" ? (node.harness ?? "unknown") : "unknown",
  };
};

/**
 * Append every notice the ruling owes. Only a seat's command is told this
 * way: the operator and automations have no seat to stamp the mail as, and
 * their notices wait on a Junto sender (pty-inject review, 94792dcf6).
 */
export const deliverTaskEffects = (delivery: TaskDelivery): Effect.Effect<void, WorkErrorBody> =>
  Effect.gen(function* () {
    const { actor } = delivery;
    if (actor.kind !== "seat") return;
    const machines = yield* Effect.serviceOption(MachineRepository);
    const work = yield* Effect.serviceOption(WorkService);
    if (Option.isNone(machines)) return yield* Effect.fail(notBuilt("this machine's installation id"));
    if (Option.isNone(work)) return yield* Effect.fail(notBuilt("the work service"));
    const installationId = yield* machines.value.installationId.pipe(
      Effect.mapError((error): WorkErrorBody => ({ type: "RuntimeDown", message: String(error), details: { retryable: true } })),
    );
    const nameOf = (seat: SeatNodeId): string => {
      const node = delivery.canvas.nodes.get(seat);
      return node === undefined ? seat : titleOf(node);
    };
    const notices = taskRulingNotices({
      installationId,
      opId: delivery.opId,
      task: {
        node: delivery.task.node,
        taskId: delivery.task.id,
        number: delivery.task.number,
        title: delivery.task.title,
        ...(delivery.task.assignee === undefined ? {} : { assignee: delivery.task.assignee }),
      },
      sender: senderOf(delivery.canvas, actor),
      actor: actor.nodeId as SeatNodeId,
      effects: delivery.effects,
      nameOf,
    });
    const sentBy = { seatId: actor.seatId, canvasName: delivery.canvasName, nodeId: actor.nodeId };
    for (const notice of notices) {
      const row = subjectNoticeRow(notice);
      const appended = yield* work.value.workSubjectNotice(
        delivery.canvasName,
        notice.recipient,
        makeUserMessage({ messageId: row.messageId, text: row.text, contextId: delivery.canvasName, metadata: row.metadata }),
        sentBy,
      );
      if (!appended.ok) {
        return yield* Effect.fail({ type: "RuntimeDown", message: appended.message, details: { retryable: true } } satisfies WorkErrorBody);
      }
    }
  });
