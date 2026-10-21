/**
 * The mail an applied task ruling owes (pty P4, plan 0.10 03 and 04): each
 * `TaskEffect` that tells a seat something becomes one subject notice in the
 * task's thread, appended to that seat's mailbox as the actor's mail. The
 * actor's own machine runs this when the ruling applies; the notice id is
 * derived from (installation, opId, kind, seat), so a ruling delivered twice
 * writes each row once.
 */
import { Effect, Option } from "effect";
import type { Canvas } from "@shared/model";
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
import { actorMailOf } from "./actor-mail";
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

/**
 * Append every notice the ruling owes, as the actor's mail (actor-mail.ts):
 * a seat's as the seat, the operator's as operator mail, an automation's as
 * its own node, never as the operator.
 */
export const deliverTaskEffects = (delivery: TaskDelivery): Effect.Effect<void, WorkErrorBody> =>
  Effect.gen(function* () {
    const { actor } = delivery;
    const mail = actorMailOf(delivery.canvas, delivery.canvasName, actor);
    if (mail === undefined) {
      return yield* Effect.fail({
        type: "InputError",
        message: "an automation is told from its own node, never the operator's",
        details: { path: "actor", retryable: false },
      } satisfies WorkErrorBody);
    }
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
      sender: mail.stamp,
      ...(actor.kind === "seat" ? { actor: actor.nodeId as SeatNodeId } : {}),
      effects: delivery.effects,
      nameOf,
    });
    for (const notice of notices) {
      const row = subjectNoticeRow(notice);
      const appended = yield* work.value.workSubjectNotice(
        delivery.canvasName,
        notice.recipient,
        makeUserMessage({ messageId: row.messageId, text: row.text, contextId: delivery.canvasName, metadata: row.metadata }),
        mail.sentBy,
      );
      if (!appended.ok) {
        return yield* Effect.fail({ type: "RuntimeDown", message: appended.message, details: { retryable: true } } satisfies WorkErrorBody);
      }
    }
  });
