/**
 * The automation runner in the running app (plan 0.10/07). One runner for
 * every canvas this machine edits: a loop considers each schedule and poll
 * whose slot came due, and the pane's Run hands its applied run here.
 *
 * Actions run as the automation, never as the operator. Mail goes from the
 * automation's own node (`automationActorRef`) into the seat's mailbox, with
 * no reply command; its id is derived from the firing, so a firing retried
 * after a crash writes the same row once. A comment posts on the whole
 * resource as the automation, through the one comment write path. An action
 * whose port has not landed yet is ruled refused `not_available` in the firing's history, so a
 * firing never reads as done when it did nothing. A `when` condition holds
 * only once the seat-state and task-state ports land; until then it never
 * holds and the firing is skipped `condition_unmet`.
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
import type { OpId } from "@shared/work-ids";
import { type AutomationPersistenceError, AutomationRepository } from "./repository";
import { makeAutomationRunner, type RunnerPorts } from "./runner";

/** How often the loop looks for due slots: cron and poll slots are minutes apart. */
export const AUTOMATION_TICK = Duration.seconds(15);

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** A mail row's id from its firing and action: a ULID with the firing's time and hashed random bits. */
export const automationMailId = (firingId: FiringId, index: number): string => {
  const digest = createHash("sha256").update(`${firingId}:${index}`).digest();
  let random = "";
  for (let i = 0; i < 16; i += 1) random += CROCKFORD[digest[i]! % 32];
  return `${firingId.slice(0, 10)}${random}`;
};

const decodeAutomationNode = Schema.decodeUnknownOption(AutomationNodeId);

const notAvailable = (index: number): ActionRuling => ({ index, ruling: "refused", reason: "not_available" });

/** The thread subject a comment action names: the whole task, artifact or page. */
const subjectOf = (on: Extract<Action, { readonly kind: "comment" }>["on"]) => {
  switch (on.kind) {
    case "task":
      return { kind: "task", nodeId: on.nodeId, taskId: on.taskId };
    case "artifact":
      return { kind: "artifact", nodeId: on.nodeId, artifactId: on.artifactId };
    case "page":
      return { kind: "page", nodeId: on.nodeId };
  }
};

/** The refusal a failed write names, or invalid input when it names none. */
const refusalReasonOf = (error: WorkErrorBody): RefusalReason => {
  const reason = (error.details as { readonly reason?: unknown } | undefined)?.reason;
  if (Schema.is(RefusalReasonSchema)(reason)) return reason;
  return error.type === "UnknownTarget" ? "unknown_target" : "invalid_input";
};

/** One action, performed as the automation. Never fails: a refusal is a ruling. */
export const performAction = (
  work: Option.Option<WorkServiceShape>,
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
            {
              subject: subjectOf(action.on),
              text: action.text,
              actor: { kind: "automation", nodeId: automation.nodeId, automationId: automation.automationId },
              // Derived from the firing, so a retried firing posts the comment once.
              opId: automationMailId(firingId, index) as OpId,
            } as SubjectCommentInput,
            { canvas, canvasName, people: [] },
          ),
        );
        return posted._tag === "Success"
          ? ({ index, ruling: "applied" } as const)
          : ({ index, ruling: "refused", reason: refusalReasonOf(posted.failure) } as const);
      }
      case "create-task":
      case "assign-task":
        return notAvailable(index);
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
    // The canvas as it stood when this pass began; the ports read it synchronously.
    const canvases = new Map<string, Canvas>();
    const ports: RunnerPorts = {
      canvas: (canvasName) => canvases.get(canvasName),
      holds: () => false,
      perform: (canvasName, automation, action, index, firingId) =>
        performAction(work, canvases.get(canvasName), canvasName, automation, action, index, firingId).pipe(
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
