/**
 * The automation runner in the running app (plan 0.10/07). One runner for
 * every canvas this machine edits: a loop considers each schedule and poll
 * whose slot came due, every task or artifact write wakes a pass that fires
 * the change triggers its tasks, seats and artifacts moved through, a raised
 * signal fires its own, and the pane's Run hands its applied run here.
 *
 * Actions run as the automation, never as the operator. Mail goes from the
 * automation's own node (`automationActorRef`) into the seat's mailbox, with
 * no reply command; its id is derived from the firing, so a firing retried
 * after a crash writes the same row once. A comment posts on the whole
 * resource as the automation, through the one comment write path. A task
 * action is ruled here as the automation, with its author's reach. An action
 * whose port has not landed yet is ruled refused `not_available` in the
 * firing's history, so a firing never reads as done when it did nothing.
 * A `when` condition reads the task states and the seat task index fetched
 * with the canvas before the pass, on the editing machine.
 */
import { createHash } from "node:crypto";
import { Context, Duration, Effect, Layer, Option, Queue, Schedule, Schema, Semaphore } from "effect";
import { ulid } from "ulid";
import type { Action, ActionRuling, Automation, AutomationId, Condition, Firing, SeatBecomes } from "@shared/automation";
import type { TaskState } from "@shared/task-model";
import type { SeatTask } from "@shared/seat-task-index";
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
import { noteResourceChanged, onResourceChanged } from "../work/resource-changes";
import { onAgentSignalChanged } from "../signals/changes";
import type { AgentSignal } from "@shared/wire/agent-signals";
import { taskCanvasEnv } from "../work/task-control";
import { deliverTaskEffects, type TaskDelivery } from "../work/task-delivery";
import { TaskRepository } from "../work/task-repository";
import { ArtifactRepository } from "../work/artifact-repository";
import { readSeatTaskIndex } from "../work/seat-task-read";
import { MachineRepository } from "../machines/repository";
import { type AutomationPersistenceError, AutomationRepository } from "./repository";
import { type ChangeEvent } from "./plan";
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

/** A task as a `when` condition reads it. */
export type TaskStateRow = { readonly taskId: string; readonly node: string; readonly state: string; readonly since: number };

/** What a pass reads for its `when` conditions. */
export type ConditionView = {
  readonly tasks: ReadonlyArray<TaskStateRow>;
  /** The open task each seat holds (seat-task-read.ts). */
  readonly seatTasks: Readonly<Record<string, Pick<SeatTask, "blocked" | "since"> | undefined>>;
  readonly seatOnCanvas: (seat: string) => boolean;
  /** Every seat on the canvas, for the changes between two passes. */
  readonly seats: ReadonlyArray<string>;
  /** Each artifact's head version, for the edits between two passes. */
  readonly artifacts?: ReadonlyArray<ArtifactVersionRow>;
};

/** An artifact as a change trigger reads it. */
export type ArtifactVersionRow = { readonly artifactId: string; readonly node: string; readonly version: number };

/** A task state an automation wrote, so its change never triggers an automation. */
const writtenKey = (taskId: string, state: string) => `${taskId}:${state}`;

/**
 * The changes between two passes' views: a task that came into a state (a
 * new task too), and a seat whose state moved, gone included. The first pass
 * has nothing before it and is a baseline: it fires nothing. A task state an
 * automation wrote is marked `byAutomation`, so no automation fires on it.
 */
export const changesBetween = (
  before: ConditionView | undefined,
  after: ConditionView,
  automationWrote: (taskId: string, state: string) => boolean,
): ReadonlyArray<ChangeEvent> => {
  if (before === undefined) return [];
  const events: Array<ChangeEvent> = [];
  const was = new Map(before.tasks.map((task) => [task.taskId, task]));
  for (const task of after.tasks) {
    const prior = was.get(task.taskId);
    if (prior !== undefined && prior.state === task.state && prior.since === task.since) continue;
    events.push({
      kind: "task",
      key: `task:${task.taskId}:${task.state}:${task.since}`,
      nodeId: task.node as NodeId,
      taskId: task.taskId as ItemId,
      becomes: task.state as TaskState,
      byAutomation: automationWrote(task.taskId, task.state),
    });
  }
  // An edit is a new head version of an artifact the pass before knew. Automations write no artifacts.
  const versions = new Map((before.artifacts ?? []).map((artifact) => [artifact.artifactId, artifact.version]));
  for (const artifact of after.artifacts ?? []) {
    const prior = versions.get(artifact.artifactId);
    if (prior === undefined || prior === artifact.version) continue;
    events.push({
      kind: "artifact",
      key: `artifact:${artifact.artifactId}:edited:${artifact.version}`,
      nodeId: artifact.node as NodeId,
      artifactId: artifact.artifactId as ItemId,
      event: "edited",
      byAutomation: false,
    });
  }
  for (const seat of new Set([...before.seats, ...after.seats])) {
    const from = seatStateOf(before, seat);
    const to = seatStateOf(after, seat);
    if (from === to) continue;
    const since = after.seatTasks[seat]?.since;
    events.push({ kind: "seat", key: `seat:${seat}:${to}:${since ?? from}`, seat: seat as NodeId, becomes: to });
  }
  return events;
};

/**
 * A seat's state as its tasks tell it: gone when it left the canvas,
 * attention when its open task waits on someone else, working while it holds
 * an open task, idle when it holds none.
 */
export const seatStateOf = (view: ConditionView, seat: string): SeatBecomes => {
  if (!view.seatOnCanvas(seat)) return "gone";
  const task = view.seatTasks[seat];
  return task === undefined ? "idle" : task.blocked ? "attention" : "working";
};

/**
 * Whether a `when` condition holds over what this pass read: a seat in that
 * state, a named task in that state, or any task on the named node in it.
 */
export const conditionHolds = (condition: Condition, view: ConditionView): boolean => {
  const { tasks } = view;
  if (condition.kind === "seat") return condition.seat.kind === "seat" && seatStateOf(view, condition.seat.nodeId) === condition.becomes;
  const on = condition.task;
  if ("kind" in on) return on.kind === "task" && tasks.some((task) => task.taskId === on.taskId && task.state === condition.becomes);
  return tasks.some((task) => task.node === on.node && task.state === condition.becomes);
};

/**
 * The task read stops here, newest change first. A task that just changed
 * state is among the newest, so its change is seen; a task the cap leaves
 * out is kept from the pass before (`load`), so coming back into the read
 * on an edit is never taken for a new task.
 */
const TASK_STATES_READ_MAX = 1_000;

/** Nothing read: no task and no seat, so no condition holds. */
const EMPTY_VIEW: ConditionView = { tasks: [], seatTasks: {}, seatOnCanvas: () => false, seats: [] };

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
  /** Told each task state an automation wrote. */
  readonly wrote: (taskId: string, state: string) => void;
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
      port.wrote(outcome.task.id, outcome.task.state);
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
    /** Fire every change trigger a canvas's tasks or seats moved through since the last pass. */
    readonly wake: (canvasName: string) => Effect.Effect<void, AutomationPersistenceError>;
    /** Fire the change triggers a raised signal matches. */
    readonly signalled: (
      canvasName: string,
      event: Extract<ChangeEvent, { readonly kind: "signal" }>,
    ) => Effect.Effect<void, AutomationPersistenceError>;
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
    const artifactStore = yield* Effect.serviceOption(ArtifactRepository);
    const readArtifacts = (canvasName: string, canvas: Canvas): Effect.Effect<ReadonlyArray<ArtifactVersionRow>> => {
      const nodeIds = [...canvas.nodes.values()].filter((node) => node.kind === "artifacts").map((node) => node.id);
      if (Option.isNone(artifactStore) || nodeIds.length === 0) return Effect.succeed([]);
      return artifactStore.value.list(canvasName, { nodeIds, archived: false, limit: TASK_STATES_READ_MAX }).pipe(
        Effect.map(({ artifacts }) =>
          artifacts.map((artifact) => ({ artifactId: artifact.artifactId, node: artifact.nodeId, version: artifact.version })),
        ),
        Effect.orElseSucceed(() => [] as ReadonlyArray<ArtifactVersionRow>),
      );
    };
    const tasks: Option.Option<TaskPort> = Option.isSome(taskStore) && Option.isSome(machines)
      ? Option.some({
          repository: taskStore.value,
          writer: machines.value.installationId,
          deliver: (delivery) =>
            deliverTaskEffects(delivery).pipe(
              Effect.provideService(MachineRepository, machines.value),
              Option.isSome(work) ? Effect.provideService(WorkService, work.value) : (effect) => effect,
            ),
          wrote: (taskId, state) => {
            automationWrites.add(writtenKey(taskId, state));
          },
        })
      : Option.none();
    // The canvas as it stood when this pass began; the ports read it synchronously.
    const canvases = new Map<string, Canvas>();
    const views = new Map<string, ConditionView>();
    // Task states automations wrote, each told once to the diff that sees it.
    const automationWrites = new Set<string>();
    const automationWrote = (taskId: string, state: string) => automationWrites.delete(writtenKey(taskId, state));
    const ports: RunnerPorts = {
      canvas: (canvasName) => canvases.get(canvasName),
      holds: (canvasName, condition) => conditionHolds(condition, views.get(canvasName) ?? EMPTY_VIEW),
      perform: (canvasName, automation, action, index, firingId) =>
        performAction(work, tasks, canvases.get(canvasName), canvasName, automation, action, index, firingId).pipe(
          Effect.catchCause(() => Effect.succeed(notAvailable(index))),
        ),
      mintFiringId: () => FiringId.make(ulid()),
      now: () => Date.now(),
    };
    const runner = makeAutomationRunner(ports);
    // What a `when` reads: every task's state on the canvas's task nodes, and the seat task index.
    const readConditionView = (canvasName: string, canvas: Canvas): Effect.Effect<ConditionView> => {
      const seats = [...canvas.nodes.values()].filter((node) => node.kind === "agent").map((node) => node.id as string);
      const seatOnCanvas = (seat: string) => canvas.nodes.get(seat as never)?.kind === "agent";
      return Option.isNone(taskStore)
        ? Effect.succeed({ tasks: [], seatTasks: {}, seatOnCanvas, seats })
        : Effect.all({
            listed: taskStore.value.list(canvasName, {
              nodeIds: [...canvas.nodes.values()].filter((node) => node.kind === "task").map((node) => node.id),
              limit: TASK_STATES_READ_MAX,
            }),
            seatTasks: readSeatTaskIndex(taskStore.value, canvas),
          }).pipe(
            Effect.map(({ listed, seatTasks }): ConditionView => ({
              tasks: listed.tasks.map((task) => ({
                taskId: task.taskId,
                node: task.current.node,
                state: task.current.state,
                since: task.stateSince,
              })),
              seatTasks,
              seatOnCanvas,
              seats,
            })),
            // An unreadable store holds no condition: the firing is skipped, never fired.
            Effect.orElseSucceed(() => EMPTY_VIEW),
          );
    };
    // Read the canvas and its view for this pass, and say what changed since the last one.
    const load = (canvasName: string) =>
      model.canvas(canvasName).pipe(
        Effect.flatMap((canvas) =>
          Effect.map(Effect.zip(readConditionView(canvasName, canvas), readArtifacts(canvasName, canvas)), ([read, artifacts]) => {
            const view: ConditionView = { ...read, artifacts };
            const before = views.get(canvasName);
            const changes = changesBetween(before, view, automationWrote);
            // Keep the tasks and artifacts this read left out, as they were, for the next diff.
            const seen = new Set(view.tasks.map((task) => task.taskId));
            const kept = (before?.tasks ?? []).filter((task) => !seen.has(task.taskId));
            const seenArtifacts = new Set(artifacts.map((artifact) => artifact.artifactId));
            const keptArtifacts = (before?.artifacts ?? []).filter((artifact) => !seenArtifacts.has(artifact.artifactId));
            canvases.set(canvasName, canvas);
            views.set(canvasName, { ...view, tasks: [...view.tasks, ...kept], artifacts: [...artifacts, ...keptArtifacts] });
            return changes;
          }),
        ),
        Effect.catchCause(() =>
          Effect.sync(() => {
            canvases.delete(canvasName);
            views.delete(canvasName);
            return [] as ReadonlyArray<ChangeEvent>;
          }),
        ),
      );
    const withRepository = <A, E>(effect: Effect.Effect<A, E, AutomationRepository>) =>
      Effect.provideService(effect, AutomationRepository, repository);
    // One pass at a time, so two never diff against the same view.
    const turn = yield* Semaphore.make(1);
    const changed = (canvasName: string, changes: ReadonlyArray<ChangeEvent>) =>
      Effect.forEach(changes, (event) => withRepository(runner.onChange(canvasName, event)), { discard: true });

    const tickAll = turn.withPermits(1)(Effect.gen(function* () {
      const names = yield* model.listCanvases().pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
      for (const name of names) {
        // Only the editing machine runs a canvas's automations, so none fires twice.
        if (!(yield* records.editsCanvas(name).pipe(Effect.orElseSucceed(() => false)))) continue;
        yield* changed(name, yield* load(name));
        yield* withRepository(runner.tick(name));
      }
    }));

    const wake = (canvasName: string) =>
      turn.withPermits(1)(Effect.gen(function* () {
        if (!(yield* records.editsCanvas(canvasName).pipe(Effect.orElseSucceed(() => false)))) return;
        yield* changed(canvasName, yield* load(canvasName));
      }));

    const signalled = (canvasName: string, event: Extract<ChangeEvent, { readonly kind: "signal" }>) =>
      turn.withPermits(1)(Effect.gen(function* () {
        if (!(yield* records.editsCanvas(canvasName).pipe(Effect.orElseSucceed(() => false)))) return;
        yield* withRepository(runner.onChange(canvasName, event));
      }));

    const onRun = (canvasName: string, automationId: AutomationId) =>
      turn.withPermits(1)(Effect.gen(function* () {
        yield* changed(canvasName, yield* load(canvasName));
        return yield* withRepository(runner.onRun(canvasName, automationId));
      }));

    return AutomationRunnerService.of({ tickAll, wake, signalled, onRun });
  }),
);

/** A signal as a change trigger hears it: only when raised, keyed by its id so a claim dedupes it. */
export const signalChange = (
  signal: Pick<AgentSignal, "signalId" | "nodeId" | "kind" | "state">,
): Extract<ChangeEvent, { readonly kind: "signal" }> | undefined =>
  signal.state === "open"
    ? { kind: "signal", key: `signal:${signal.signalId}`, seat: signal.nodeId as NodeId, signal: signal.kind }
    : undefined;

/** What wakes a pass between ticks: a task or artifact write, or a raised signal. */
type Wake =
  | { readonly kind: "write"; readonly canvasName: string }
  | { readonly kind: "signal"; readonly canvasName: string; readonly event: Extract<ChangeEvent, { readonly kind: "signal" }> };

/**
 * The loop: one pass every AUTOMATION_TICK while the app runs, a wake on
 * every task or artifact write (resource-changes.ts), and one on every raised
 * signal (signals/changes.ts), so a change trigger fires within moments. A
 * failed pass is logged and the next one runs.
 */
export const AutomationRunnerLoopLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const runner = yield* AutomationRunnerService;
    yield* runner.tickAll.pipe(
      Effect.catchCause((cause) => Effect.logWarning("automation runner pass failed", cause)),
      Effect.repeat(Schedule.spaced(AUTOMATION_TICK)),
      Effect.forkScoped,
    );
    const writes = yield* Queue.unbounded<Wake>();
    const unsubscribe = onResourceChanged((_domain, canvasName) => {
      Queue.offerUnsafe(writes, { kind: "write", canvasName });
    });
    // A signal fires when it is raised, once: its id is the key a claim dedupes.
    const unsubscribeSignals = onAgentSignalChanged((signal) => {
      const event = signalChange(signal);
      if (event !== undefined) Queue.offerUnsafe(writes, { kind: "signal", canvasName: signal.canvasName, event });
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => {
      unsubscribe();
      unsubscribeSignals();
    }));
    yield* Queue.take(writes).pipe(
      Effect.flatMap((wake) => (wake.kind === "write" ? runner.wake(wake.canvasName) : runner.signalled(wake.canvasName, wake.event))),
      Effect.catchCause((cause) => Effect.logWarning("automation change pass failed", cause)),
      Effect.forever,
      Effect.forkScoped,
    );
  }),
);
