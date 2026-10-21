/**
 * The automation runner in the running app (plan 0.10/07). One runner for
 * every canvas this machine edits: a loop considers each schedule and poll
 * whose slot came due, and the pane's Run hands its applied run here.
 *
 * Actions run as the automation, never as the operator. Mail goes from the
 * automation's own node (`automationActorRef`) into the seat's mailbox, with
 * no reply command; its id is derived from the firing, so a firing retried
 * after a crash writes the same row once. A comment posts on the whole
 * resource as the automation, through the one comment write path. A task
 * action is ruled here as the automation, with its author's reach. An action
 * whose port has not landed yet is ruled refused `not_available` in the
 * firing's history, so a firing never reads as done when it did nothing. A
 * `when` condition holds only once the seat-state and task-state ports land;
 * until then it never holds and the firing is skipped `condition_unmet`.
 */
import { createHash } from "node:crypto";
import { Context, Duration, Effect, Layer, Option, Schedule, Schema } from "effect";
import { ulid } from "ulid";
import type { Action, ActionRuling, Automation, AutomationId, Firing } from "@shared/automation";
import { FiringId } from "@shared/automation";
import { mailExtensionMetadata } from "@shared/crew";
import { automationActorRef, AutomationNodeId } from "@shared/mail-author";
import { automationSenderStamp } from "@shared/mail-sender";
import type { Canvas } from "@shared/model";
import { makeUserMessage } from "@shared/task";
import { ModelRecords } from "../model/records";
import { ModelService } from "../model/service";
import { WorkService, type WorkServiceShape } from "../work/service";
import { postSubjectComment } from "../work/subject-comment";
import type { SubjectCommentInput } from "@shared/subject-comment";
import { RefusalReason as RefusalReasonSchema, type RefusalReason } from "@shared/resource-command";
import type { WorkErrorBody } from "@shared/work-control";
import { ItemId, OpId } from "@shared/work-ids";
import type { InstallationId } from "@shared/installation-id";
import type { NodeId } from "@shared/physics/schema";
import { rulingContextOf } from "@shared/ruling-context";
import { checkTaskCommand, type TaskCommandWire } from "@shared/task-model";
import { noteResourceChanged } from "../work/resource-changes";
import { taskCanvasEnv } from "../work/task-control";
import { deliverTaskEffects, type TaskDelivery } from "../work/task-delivery";
import { TaskRepository } from "../work/task-repository";
import { MachineRepository } from "../machines/repository";
import { type AutomationPersistenceError, AutomationRepository } from "./repository";
import { makeAutomationRunner, type RunnerPorts } from "./runner";

/** How often the loop looks for due slots: cron and poll slots are minutes apart. */
export const AUTOMATION_TICK = Duration.seconds(15);

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/**
 * An id derived from a firing, its action and a part of that action: a ULID
 * with the firing's time and hashed random bits, so a retried firing writes
 * each row and each op once.
 */
export const automationMailId = (firingId: FiringId, index: number, part?: string): string => {
  const digest = createHash("sha256").update(part === undefined ? `${firingId}:${index}` : `${firingId}:${index}:${part}`).digest();
  let random = "";
  for (let i = 0; i < 16; i += 1) random += CROCKFORD[digest[i]! % 32];
  return `${firingId.slice(0, 10)}${random}`;
};

const decodeAutomationNode = Schema.decodeUnknownOption(AutomationNodeId);

const notAvailable = (index: number): ActionRuling => ({ index, ruling: "refused", reason: "not_available" });

/** A comment on the whole task, artifact or page a comment action names; each arm is checked against its own input. */
const commentOn = (
  on: Extract<Action, { readonly kind: "comment" }>["on"],
  rest: Pick<SubjectCommentInput, "text" | "actor" | "opId">,
): SubjectCommentInput => {
  switch (on.kind) {
    case "task":
      return { ...rest, subject: { kind: "task", nodeId: on.nodeId, taskId: on.taskId } };
    case "artifact":
      return { ...rest, subject: { kind: "artifact", nodeId: on.nodeId, artifactId: on.artifactId } };
    case "page":
      return { ...rest, subject: { kind: "page", nodeId: on.nodeId } };
  }
};

/** The refusal a failed write names, or invalid input when it names none. */
const refusalReasonOf = (error: WorkErrorBody): RefusalReason => {
  const reason = (error.details as { readonly reason?: unknown } | undefined)?.reason;
  if (Schema.is(RefusalReasonSchema)(reason)) return reason;
  return error.type === "UnknownTarget" ? "unknown_target" : "invalid_input";
};

/** What a task action needs: the task store, this machine as the writer, and the notices a ruling owes. */
export type TaskPort = {
  readonly repository: TaskRepository["Service"];
  readonly writer: Effect.Effect<InstallationId, unknown>;
  readonly deliver: (delivery: TaskDelivery) => Effect.Effect<void, unknown>;
};

type TaskWrite = { readonly opId: OpId; readonly nodeId: NodeId; readonly taskId: ItemId; readonly wire: TaskCommandWire };

/**
 * One task command as the automation, ruled here on the editing machine with
 * the automation's own reach (its author's). Undefined when it applied; the
 * refusal's reason otherwise.
 */
const submitTask = (port: TaskPort, canvas: Canvas, canvasName: string, automation: Automation, write: TaskWrite) =>
  Effect.gen(function* () {
    const checked = checkTaskCommand(write.wire, (id) => canvas.nodes.get(id)?.kind);
    if (!checked.ok) return checked.refusal.reason;
    const author = (node: NodeId) => (node === automation.nodeId ? automation.author : undefined);
    const actor = { kind: "automation", nodeId: automation.nodeId, automationId: automation.automationId } as const;
    const outcome = yield* port.repository.submit(
      yield* port.writer,
      {
        opId: write.opId,
        canvasName,
        actor,
        target: { kind: "task", nodeId: write.nodeId, itemId: write.taskId },
        basis: null,
        after: [],
        op: checked.command,
      },
      rulingContextOf(canvas, author),
      taskCanvasEnv(canvas, author),
    );
    if (outcome.kind === "refused") return refusalReasonOf(outcome.error);
    if (!outcome.replay) {
      noteResourceChanged("task", canvasName);
      // The ruling is committed: a lost notice never turns it into a refusal.
      yield* port.deliver({ canvas, canvasName, actor, opId: write.opId, task: outcome.task, effects: outcome.effects }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("automation task notices were not delivered", cause)),
      );
    }
    return undefined as RefusalReason | undefined;
  });

/** An action's ruling from the refusal reason of its last write, if any. */
const ruledAs = (index: number, reason: RefusalReason | undefined): ActionRuling =>
  reason === undefined ? { index, ruling: "applied" } : { index, ruling: "refused", reason };

/** One action, performed as the automation. Never fails: a refusal is a ruling. */
export const performAction = (
  work: Option.Option<WorkServiceShape>,
  tasks: Option.Option<TaskPort>,
  canvas: Canvas | undefined,
  canvasName: string,
  automation: Automation,
  action: Action,
  index: number,
  firingId: FiringId,
) =>
  Effect.gen(function* () {
    switch (action.kind) {
      case "mail": {
        const from = decodeAutomationNode(automation.nodeId);
        if (Option.isNone(work) || Option.isNone(from)) return notAvailable(index);
        const written = yield* work.value.workSubjectNotice(
          canvasName,
          action.to.nodeId,
          makeUserMessage({
            messageId: automationMailId(firingId, index),
            text: action.text,
            contextId: canvasName,
            metadata: {
              factoryMail: true,
              ...mailExtensionMetadata({ ...automationSenderStamp(from.value, automation.name), mailKind: "notice" }),
            },
          }),
          automationActorRef(canvasName, from.value),
        );
        return written.ok ? ({ index, ruling: "applied" } as const) : ({ index, ruling: "refused", reason: "invalid_input" } as const);
      }
      case "comment": {
        // A comment on the whole resource; a place on it waits for the plan 03 anchors.
        if (canvas === undefined || (action.anchor !== undefined && action.anchor.kind !== "whole")) return notAvailable(index);
        const posted = yield* Effect.result(
          postSubjectComment(
            commentOn(action.on, {
              text: action.text,
              actor: { kind: "automation", nodeId: automation.nodeId, automationId: automation.automationId },
              // Derived from the firing, so a retried firing posts the comment once.
              opId: OpId.make(automationMailId(firingId, index)),
            }),
            { canvas, canvasName, people: [] },
          ),
        );
        return posted._tag === "Success"
          ? ({ index, ruling: "applied" } as const)
          : ({ index, ruling: "refused", reason: refusalReasonOf(posted.failure) } as const);
      }
      case "create-task": {
        if (canvas === undefined || Option.isNone(tasks)) return notAvailable(index);
        const taskId = ItemId.make(automationMailId(firingId, index, "task"));
        const created = yield* submitTask(tasks.value, canvas, canvasName, automation, {
          opId: OpId.make(automationMailId(firingId, index, "create")),
          nodeId: action.node,
          taskId,
          wire: { kind: "create", taskId, title: action.title },
        });
        if (created !== undefined || action.assign === undefined) return ruledAs(index, created);
        // The task stands; an assign it could not make is this action's refusal.
        if (action.assign.kind !== "seat") return { index, ruling: "refused", reason: "invalid_input" } as const;
        const assigned = yield* submitTask(tasks.value, canvas, canvasName, automation, {
          opId: OpId.make(automationMailId(firingId, index, "assign")),
          nodeId: action.node,
          taskId,
          wire: { kind: "assign", seat: action.assign.nodeId },
        });
        return ruledAs(index, assigned);
      }
      case "assign-task": {
        if (canvas === undefined || Option.isNone(tasks)) return notAvailable(index);
        if (action.task.kind !== "task" || action.to.kind !== "seat") return { index, ruling: "refused", reason: "invalid_input" } as const;
        const assigned = yield* submitTask(tasks.value, canvas, canvasName, automation, {
          opId: OpId.make(automationMailId(firingId, index, "assign")),
          nodeId: action.task.nodeId,
          taskId: action.task.taskId,
          wire: { kind: "assign", seat: action.to.nodeId },
        });
        return ruledAs(index, assigned);
      }
    }
  });

export class AutomationRunnerService extends Context.Service<
  AutomationRunnerService,
  {
    /** Consider every due slot on every canvas this machine edits. */
    readonly tickAll: Effect.Effect<void, AutomationPersistenceError>;
    /** Fire an applied `run` now; undefined when the automation is gone. */
    readonly onRun: (canvasName: string, automationId: AutomationId) => Effect.Effect<Firing | undefined, AutomationPersistenceError>;
  }
>()("@junto/AutomationRunnerService") {}

export const AutomationRunnerLive = Layer.effect(
  AutomationRunnerService,
  Effect.gen(function* () {
    const repository = yield* AutomationRepository;
    const model = yield* ModelService;
    const records = yield* ModelRecords;
    const work = yield* Effect.serviceOption(WorkService);
    const machines = yield* Effect.serviceOption(MachineRepository);
    const taskStore = yield* Effect.serviceOption(TaskRepository);
    const tasks: Option.Option<TaskPort> = Option.isSome(taskStore) && Option.isSome(machines)
      ? Option.some({
          repository: taskStore.value,
          writer: machines.value.installationId,
          deliver: (delivery) =>
            deliverTaskEffects(delivery).pipe(
              Effect.provideService(MachineRepository, machines.value),
              Option.isSome(work) ? Effect.provideService(WorkService, work.value) : (effect) => effect,
            ),
        })
      : Option.none();
    // The canvas as it stood when this pass began; the ports read it synchronously.
    const canvases = new Map<string, Canvas>();
    const ports: RunnerPorts = {
      canvas: (canvasName) => canvases.get(canvasName),
      holds: () => false,
      perform: (canvasName, automation, action, index, firingId) =>
        performAction(work, tasks, canvases.get(canvasName), canvasName, automation, action, index, firingId).pipe(
          Effect.catchCause(() => Effect.succeed(notAvailable(index))),
        ),
      mintFiringId: () => FiringId.make(ulid()),
      now: () => Date.now(),
    };
    const runner = makeAutomationRunner(ports);
    const load = (canvasName: string) =>
      model.canvas(canvasName).pipe(
        Effect.tap((canvas) => Effect.sync(() => canvases.set(canvasName, canvas))),
        Effect.asVoid,
        Effect.catchCause(() => Effect.sync(() => canvases.delete(canvasName))),
      );
    const withRepository = <A, E>(effect: Effect.Effect<A, E, AutomationRepository>) =>
      Effect.provideService(effect, AutomationRepository, repository);

    const tickAll = Effect.gen(function* () {
      const names = yield* model.listCanvases().pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
      for (const name of names) {
        // Only the editing machine runs a canvas's automations, so none fires twice.
        if (!(yield* records.editsCanvas(name).pipe(Effect.orElseSucceed(() => false)))) continue;
        yield* load(name);
        yield* withRepository(runner.tick(name));
      }
    });

    const onRun = (canvasName: string, automationId: AutomationId) =>
      Effect.gen(function* () {
        yield* load(canvasName);
        return yield* withRepository(runner.onRun(canvasName, automationId));
      });

    return AutomationRunnerService.of({ tickAll, onRun });
  }),
);

/** The loop: one pass every AUTOMATION_TICK while the app runs; a failed pass is logged and the next one runs. */
export const AutomationRunnerLoopLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const runner = yield* AutomationRunnerService;
    yield* runner.tickAll.pipe(
      Effect.catchCause((cause) => Effect.logWarning("automation runner pass failed", cause)),
      Effect.repeat(Schedule.spaced(AUTOMATION_TICK)),
      Effect.forkScoped,
    );
  }),
);
