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
 * A task change is one applied task ruling that brought a task into a state,
 * read in the order rulings landed here since the canvas's ruling cursor, so
 * a task that went to working and on to done between two passes fires both.
 * A ruling on an automation's command fires nothing (`actor_kind`).
 * A `when` condition reads the task states and the seat task index fetched
 * with the canvas before the pass, on the editing machine.
 */
import { createHash } from "node:crypto";
import { Context, Duration, Effect, Layer, Option, Queue, Schedule, Schema, Semaphore, Stream } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { ulid } from "ulid";
import type { Action, ActionRuling, Automation, AutomationId, Condition, Firing, SeatBecomes } from "@shared/automation";
import { TASK_TITLE_MAX, type TaskId, type TaskState } from "@shared/task-model";
import type { SeatTask } from "@shared/seat-task-index";
import { automationValuesOf, FiringId, resolveValues, valueNamesIn } from "@shared/automation";
import { mailExtensionMetadata } from "@shared/crew";
import { automationActorRef, AutomationNodeId } from "@shared/mail-author";
import { automationSenderStamp } from "@shared/mail-sender";
import type { Canvas } from "@shared/model";
import { makeUserMessage } from "@shared/task";
import { ModelRecords } from "../model/records";
import { ModelService } from "../model/service";
import { WorkService, type WorkServiceShape } from "../work/service";
import { postSubjectComment } from "../work/subject-comment";
import { subjectPeopleAt } from "../work/subject-people";
import type { SubjectCommentInput } from "@shared/subject-comment";
import { RefusalReason as RefusalReasonSchema, refusalError, type RefusalReason } from "@shared/resource-command";
import type { WorkErrorBody } from "@shared/work-control";
import type { QueuedCommand } from "@shared/command-row";
import { ResourceSubmit, type QueuedOutcome } from "../work/resource-submit";
import { ItemId, OpId } from "@shared/work-ids";
import type { InstallationId } from "@shared/installation-id";
import type { NodeId } from "@shared/physics/schema";
import { rulingContextOf } from "@shared/ruling-context";
import { checkTaskCommand, type TaskCommandWire } from "@shared/task-model";
import { noteResourceChanged, onResourceChanged } from "../work/resource-changes";
import { onAgentSignalChanged } from "../signals/changes";
import { isSeatRaiseKind, type AgentSignal } from "@shared/wire/agent-signals";
import { threadSubjectOf } from "@shared/thread-subject";
import { taskCanvasEnv } from "../work/task-control";
import { TaskRepository } from "../work/task-repository";
import { ArtifactRepository } from "../work/artifact-repository";
import { readSeatTaskIndex } from "../work/seat-task-read";
import { MachineRepository } from "../machines/repository";
import { isThisMachine } from "@shared/machine-name";
import { type AutomationPersistenceError, AutomationRepository, RULINGS_START, type TaskRuling } from "./repository";
import { type ChangeEvent } from "./plan";
import { makeAutomationRunner, type RunnerPorts } from "./runner";
import { SeatStateSource } from "./seat-state-source";
import type { SeatStateFiring } from "@shared/seat-state-trigger";
import { type Fired, type FiredReads, firedValue } from "./values";
import { AutomationCodeRunner, runCodeStep } from "./code-step";
import { artifactsWrittenByAutomation } from "./artifact-writers";
import { type ArtifactPort, isArtifactAction, performArtifactAction } from "./artifact-actions";
import type { ArtifactLabel } from "@shared/artifact-labels";
import { WorkRepository } from "../work/repository";
import { PausePlane } from "../pause-plane";
import { ActorSeatOccupy } from "../term/actor-seat-occupy";
import { asCanvasName } from "@shared/model";
import { asNodeId } from "@shared/physics/schema";
import { startSeat, stopSeat } from "../term/seat-control";
import { canvasPlacement } from "../work/canvas-placement";
import { runSeatControl } from "../work/exchange/seat-controls";
import {
  SEAT_CONTROL_RATE_WINDOW_MS,
  SEAT_CONTROL_REFUSAL_TO_RULING,
  seatControlItemId,
  type SeatControlResult,
} from "@shared/seat-control-row";

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
  /** The open tasks each seat holds (seat-task-read.ts). */
  readonly seatTasks: Readonly<Record<string, Pick<SeatTask, "blocked" | "since"> | undefined>>;
  readonly seatOnCanvas: (seat: string) => boolean;
  /** Every seat on the canvas, for the changes between two passes. */
  readonly seats: ReadonlyArray<string>;
  /** Each artifact's head version, for the edits between two passes. */
  readonly artifacts?: ReadonlyArray<ArtifactVersionRow>;
  /** Every comment on an artifact, for the comments between two passes. */
  readonly comments?: ReadonlyArray<ArtifactCommentRow>;
};

/** A comment on an artifact, as its Artifacts node holds it. */
export type ArtifactCommentRow = {
  readonly messageId: string;
  readonly artifactId: string;
  readonly node: string;
  /** Posted by an automation (its sender stamp): it never triggers an automation. */
  readonly byAutomation: boolean;
};

/** An artifact as a change trigger reads it: its head, its labels, and whether an automation made it. */
export type ArtifactVersionRow = {
  readonly artifactId: string;
  readonly node: string;
  readonly version: number;
  readonly labels: ReadonlyArray<ArtifactLabel>;
  /** Moves with every write, labels included: it keys a label change. */
  readonly updatedAt: number;
  readonly createdByAutomation: boolean;
};

/** The artifacts whose head or labels moved between two passes: the ones whose last writer is asked (artifact-writers.ts). */
export const artifactsWritten = (before: ConditionView | undefined, after: ConditionView): ReadonlyArray<string> => {
  if (before === undefined) return [];
  const prior = new Map((before.artifacts ?? []).map((artifact) => [artifact.artifactId, artifact]));
  return (after.artifacts ?? []).flatMap((artifact) => {
    const was = prior.get(artifact.artifactId);
    return was !== undefined && (was.version !== artifact.version || was.updatedAt !== artifact.updatedAt) ? [artifact.artifactId] : [];
  });
};

/**
 * One task change per applied ruling, in the order they landed: a task that
 * came into a state, a new task too. Keyed by the ruling's op, so a pass
 * retried after a crash claims each once.
 */
export const taskChangesOf = (rulings: ReadonlyArray<TaskRuling>): ReadonlyArray<ChangeEvent> =>
  rulings.map((ruling) => ({
    kind: "task",
    key: `task:${ruling.taskId}:${ruling.became}:${ruling.opId}`,
    nodeId: ruling.node as NodeId,
    taskId: ruling.taskId as ItemId,
    becomes: ruling.became as TaskState,
    byAutomation: ruling.byAutomation,
  }));

/**
 * The changes between two passes' views besides tasks (those are rulings,
 * `taskChangesOf`): an artifact edit, a new comment, and a seat whose state
 * moved, gone included. The first pass has nothing before it and is a
 * baseline: it fires nothing.
 */
export const changesBetween = (
  before: ConditionView | undefined,
  after: ConditionView,
  /** False when the runtime seat-state source says seat changes: they are its, never the index's. */
  seatChanges = true,
  /** The artifacts an automation wrote last (`artifactsWrittenByAutomation`): their edits and labels fire nothing. */
  writtenByAutomation: ReadonlySet<string> = new Set(),
): ReadonlyArray<ChangeEvent> => {
  if (before === undefined) return [];
  const events: Array<ChangeEvent> = [];
  // An edit is a new head version of an artifact the pass before knew; a label is
  // gained when the set holds one it did not, or a new artifact arrives carrying it.
  const prior = new Map((before.artifacts ?? []).map((artifact) => [artifact.artifactId, artifact]));
  for (const artifact of after.artifacts ?? []) {
    const was = prior.get(artifact.artifactId);
    const byAutomation = was === undefined ? artifact.createdByAutomation : writtenByAutomation.has(artifact.artifactId);
    const about = { kind: "artifact", nodeId: artifact.node as NodeId, artifactId: artifact.artifactId as ItemId, labels: artifact.labels, byAutomation } as const;
    if (was !== undefined && was.version !== artifact.version) {
      events.push({ ...about, key: `artifact:${artifact.artifactId}:edited:${artifact.version}`, event: "edited", gained: [] });
    }
    const gained = artifact.labels.filter((label) => !(was?.labels ?? []).includes(label));
    if (gained.length > 0) {
      events.push({ ...about, key: `artifact:${artifact.artifactId}:labelled:${artifact.updatedAt}:${gained.join(",")}`, event: "labelled", gained });
    }
  }
  const labelsOf = new Map((after.artifacts ?? []).map((artifact) => [artifact.artifactId, artifact.labels]));
  // A comment the pass before did not hold. The first pass knows every comment, so old ones fire nothing.
  const heard = new Set((before.comments ?? []).map((comment) => comment.messageId));
  for (const comment of after.comments ?? []) {
    if (heard.has(comment.messageId)) continue;
    events.push({
      kind: "artifact",
      key: `artifact:${comment.artifactId}:commented:${comment.messageId}`,
      nodeId: comment.node as NodeId,
      artifactId: comment.artifactId as ItemId,
      event: "commented",
      labels: labelsOf.get(comment.artifactId) ?? [],
      gained: [],
      byAutomation: comment.byAutomation,
    });
  }
  for (const seat of seatChanges ? new Set([...before.seats, ...after.seats]) : []) {
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
 * attention when any open task it holds waits on someone else, working while
 * it holds an open task, idle when it holds none.
 *
 * Seat change triggers come from pty's runtime seat-state source when the
 * build has one (`SeatStateSource`, held and settled by its rules); this
 * index-derived state says them only without it. `when` conditions read this
 * state either way: the source gives firings, not a current state.
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

/** The task read for `when` conditions stops here, newest change first; so does one pass's read of rulings. */
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

/**
 * What a task action needs: the task store and this machine as the writer.
 * The notices a ruling owes are written with it. Off the machine that rules
 * the canvas, `queue` proposes the write as this machine's `command.queued`
 * row instead (S2), ruled there with the automation's author's reach.
 */
export type TaskPort = {
  readonly repository: TaskRepository["Service"];
  readonly writer: Effect.Effect<InstallationId, unknown>;
  readonly queue?: (command: QueuedCommand) => Effect.Effect<QueuedOutcome, WorkErrorBody>;
};

type TaskWrite = { readonly opId: OpId; readonly nodeId: NodeId; readonly taskId: ItemId; readonly wire: TaskCommandWire };

/**
 * One task command as the automation, ruled here on the editing machine with
 * the automation's own reach (its author's), or queued for that machine from
 * any other. Undefined when it applied, `queued` while it waits for its
 * ruling, the refusal's reason otherwise.
 */
const submitTask = (port: TaskPort, canvas: Canvas, canvasName: string, automation: Automation, write: TaskWrite) =>
  Effect.gen(function* () {
    const checked = checkTaskCommand(write.wire, (id) => canvas.nodes.get(id)?.kind);
    if (!checked.ok) return checked.refusal.reason;
    const author = (node: NodeId) => (node === automation.nodeId ? automation.author : undefined);
    const actor = { kind: "automation", nodeId: automation.nodeId, automationId: automation.automationId } as const;
    if (port.queue !== undefined) {
      const queued = yield* port.queue({
        opId: write.opId,
        canvasName,
        actor,
        target: { kind: "task", nodeId: write.nodeId, itemId: write.taskId },
        basis: null,
        after: [],
        op: write.wire as QueuedCommand["op"],
      }).pipe(Effect.result);
      if (queued._tag === "Failure") return refusalReasonOf(queued.failure);
      switch (queued.success.kind) {
        case "applied":
          return undefined as RefusalReason | "queued" | undefined;
        case "queued":
          return "queued" as const;
        case "refused":
          return refusalReasonOf(queued.success.error);
      }
    }
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
    if (!outcome.replay) noteResourceChanged("task", canvasName);
    return undefined as RefusalReason | "queued" | undefined;
  });

/** An action's ruling from its last write: applied, queued for the ruling machine, or the refusal's reason. */
const ruledAs = (index: number, reason: RefusalReason | "queued" | undefined): ActionRuling =>
  reason === undefined ? { index, ruling: "applied" } : reason === "queued" ? { index, ruling: "queued" } : { index, ruling: "refused", reason };

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
  /** The action's text with its `{{name}}` values said as this firing says them. */
  resolve: (text: string) => Effect.Effect<string> = Effect.succeed,
  /** Whether this machine rules the canvas; a comment is written only there until threads cross. */
  rules: boolean = true,
) =>
  Effect.gen(function* () {
    switch (action.kind) {
      case "mail":
      case "prompt": {
        // A prompt is mail the seat is asked to act on (`junto msg send --prompt`); mail only tells it.
        if (action.kind === "prompt" && action.to.kind !== "seat") return { index, ruling: "refused", reason: "invalid_input" } as const;
        const from = decodeAutomationNode(automation.nodeId);
        if (Option.isNone(work) || Option.isNone(from)) return notAvailable(index);
        const written = yield* work.value.workSubjectNotice(
          canvasName,
          action.to.nodeId,
          makeUserMessage({
            messageId: automationMailId(firingId, index),
            text: yield* resolve(action.text),
            contextId: canvasName,
            metadata: {
              factoryMail: true,
              ...mailExtensionMetadata({
                ...automationSenderStamp(from.value, automation.automationId, automation.name),
                mailKind: action.kind === "prompt" ? "prompt" : "notice",
              }),
            },
          }),
          automationActorRef(canvasName, from.value, automation.automationId),
        );
        return written.ok ? ({ index, ruling: "applied" } as const) : ({ index, ruling: "refused", reason: "invalid_input" } as const);
      }
      case "comment": {
        // A comment on the whole resource; a place on it waits for the plan 03 anchors.
        if (canvas === undefined || (action.anchor !== undefined && action.anchor.kind !== "whole")) return notAvailable(index);
        // Threads do not cross machines yet: off the ruling machine a comment is not available.
        if (!rules) return notAvailable(index);
        const input = commentOn(action.on, {
          text: yield* resolve(action.text),
          actor: { kind: "automation", nodeId: automation.nodeId, automationId: automation.automationId },
          // Derived from the firing, so a retried firing posts the comment once.
          opId: OpId.make(automationMailId(firingId, index)),
        });
        // A task's assignee and reviewers hear of it, as on the seat paths; a task not held at the node is refused.
        const posted = yield* Effect.result(
          Effect.flatMap(subjectPeopleAt(canvas, canvasName, input.subject), (people) =>
            postSubjectComment(input, { canvas, canvasName, people })),
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
          // A title its values made longer than a task title may be is cut to fit.
          wire: { kind: "create", taskId, title: [...(yield* resolve(action.title))].slice(0, TASK_TITLE_MAX).join("") },
        });
        // A queued create is followed by its assign, which builds on it (`after`) where both are ruled.
        if ((created !== undefined && created !== "queued") || action.assign === undefined) return ruledAs(index, created);
        // The task stands; an assign it could not make is this action's refusal.
        if (action.assign.kind !== "seat") return { index, ruling: "refused", reason: "invalid_input" } as const;
        const assigned = yield* submitTask(tasks.value, canvas, canvasName, automation, {
          opId: OpId.make(automationMailId(firingId, index, "assign")),
          nodeId: action.node,
          taskId,
          wire: { kind: "assign", seat: action.assign.nodeId },
        });
        return ruledAs(index, assigned === undefined && created === "queued" ? "queued" : assigned);
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
      // A code step, an artifact write and a seat control have the runner's own ports (performCode, performArtifactAction, performSeatControl).
      case "code":
      case "create-artifact":
      case "append-artifact":
      case "label-artifact":
      case "seat-control":
        return notAvailable(index);
      // Not available until the feed takes a signal an automation raised (0.11/07 N1).
      case "signal":
        return notAvailable(index);
    }
  });

export class AutomationRunnerService extends Context.Service<
  AutomationRunnerService,
  {
    /** Consider every due slot on every canvas this machine edits. */
    readonly tickAll: Effect.Effect<void, AutomationPersistenceError>;
    /** Fire every change trigger a canvas's tasks or seats moved through since the last pass. */
    readonly wake: (canvasName: string) => Effect.Effect<void, AutomationPersistenceError>;
    /** Fire the change triggers one heard change matches: a raised signal, a seat-state firing. */
    readonly heard: (canvasName: string, event: ChangeEvent) => Effect.Effect<void, AutomationPersistenceError>;
    /** Fire the change triggers a runtime seat-state firing matches, on the canvas holding its seat. */
    readonly seatFired: (firing: SeatStateFiring) => Effect.Effect<void, AutomationPersistenceError>;
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
    // With the runtime seat-state source, seat changes are its firings; without it, the task index says them.
    const seatStates = yield* Effect.serviceOption(SeatStateSource);
    const artifactStore = yield* Effect.serviceOption(ArtifactRepository);
    const codeRunner = yield* Effect.serviceOption(AutomationCodeRunner);
    const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
    const workRepository = yield* Effect.serviceOption(WorkRepository);
    const pause = yield* Effect.serviceOption(PausePlane);
    const occupy = yield* Effect.serviceOption(ActorSeatOccupy);
    // The comments each Artifacts node holds: rows whose thread subject is one
    // of its artifacts. A node whose mailbox could not be read is named in
    // `unread`, never taken as holding none.
    const readComments = (
      canvasName: string,
      canvas: Canvas,
    ): Effect.Effect<{ readonly comments: ReadonlyArray<ArtifactCommentRow>; readonly unread: ReadonlySet<string> }> => {
      const nodes = [...canvas.nodes.values()].filter((node) => node.kind === "artifacts");
      if (Option.isNone(work) || nodes.length === 0) return Effect.succeed({ comments: [], unread: new Set() });
      return Effect.forEach(nodes, (node) =>
        work.value.readMailbox(canvasName, node.id).pipe(
          Effect.map((rows) =>
            Option.some(rows.flatMap((row): ReadonlyArray<ArtifactCommentRow> => {
              const subject = threadSubjectOf(row);
              if (subject?.kind !== "artifact") return [];
              return [{
                messageId: row.messageId,
                artifactId: subject.artifactId,
                node: node.id,
                byAutomation: row.metadata?.senderGeneration === "automation",
              }];
            })),
          ),
          Effect.orElseSucceed(() => Option.none<ReadonlyArray<ArtifactCommentRow>>()),
        ),
      ).pipe(
        Effect.map((read) => ({
          comments: read.flatMap((rows) => Option.getOrElse(rows, () => [])),
          unread: new Set(nodes.flatMap((node, i) => (Option.isNone(read[i]!) ? [node.id as string] : []))),
        })),
      );
    };
    const readArtifacts = (canvasName: string, canvas: Canvas): Effect.Effect<ReadonlyArray<ArtifactVersionRow>> => {
      const nodeIds = [...canvas.nodes.values()].filter((node) => node.kind === "artifacts").map((node) => node.id);
      if (Option.isNone(artifactStore) || nodeIds.length === 0) return Effect.succeed([]);
      return artifactStore.value.list(canvasName, { nodeIds, archived: false, limit: TASK_STATES_READ_MAX }).pipe(
        Effect.map(({ artifacts }) =>
          artifacts.map((artifact) => ({
            artifactId: artifact.artifactId,
            node: artifact.nodeId,
            version: artifact.version,
            labels: artifact.labels,
            updatedAt: artifact.updatedAt,
            createdByAutomation: artifact.createdBy.kind === "automation",
          })),
        ),
        Effect.orElseSucceed(() => [] as ReadonlyArray<ArtifactVersionRow>),
      );
    };
    // Off the machine that rules the canvas, a task write is this machine's `command.queued` row.
    // With no queue here, or when this machine rules the canvas after all, it is not available this time.
    const notQueued = refusalError({ reason: "not_available", message: "This write cannot be proposed from this machine now" });
    const submit = yield* Effect.serviceOption(ResourceSubmit);
    const queueFor = (canvasName: string) => (command: QueuedCommand): Effect.Effect<QueuedOutcome, WorkErrorBody> =>
      Option.isNone(submit)
        ? Effect.fail(notQueued)
        : Effect.flatMap(submit.value.route(canvasName), (route) =>
            route.kind === "here" ? Effect.fail(notQueued) : submit.value.queue(command, route.editor));
    const artifactPort: ArtifactPort | undefined = Option.isSome(artifactStore) && Option.isSome(machines)
      ? { repository: artifactStore.value, writer: machines.value.installationId }
      : undefined;
    const tasks: Option.Option<TaskPort> = Option.isSome(taskStore) && Option.isSome(machines)
      ? Option.some({
          repository: taskStore.value,
          writer: machines.value.installationId,
        })
      : Option.none();
    // The canvas as it stood when this pass began; the ports read it synchronously.
    const canvases = new Map<string, Canvas>();
    const views = new Map<string, ConditionView>();
    // The Artifacts nodes of each canvas whose comments have had a good read.
    const commentsRead = new Map<string, Set<string>>();
    // The task or artifact a firing's change names, read once per text that names a value; a failed read says none.
    const firedReads = (canvasName: string, fired: Fired): Effect.Effect<FiredReads> => {
      const event = fired.event;
      if (event?.kind === "task" && Option.isSome(taskStore)) {
        return taskStore.value.get(canvasName, event.taskId as TaskId).pipe(
          Effect.map((task) => (Option.isSome(task) ? { task: task.value } : {})),
          Effect.orElseSucceed(() => ({})),
        );
      }
      if (event?.kind === "artifact" && Option.isSome(artifactStore)) {
        return artifactStore.value.head(canvasName, event.artifactId).pipe(
          Effect.map((head) => (Option.isSome(head) ? { artifact: head.value } : {})),
          Effect.orElseSucceed(() => ({})),
        );
      }
      return Effect.succeed({});
    };
    // Where this machine stands on each canvas, read as a gate opens: whether it
    // edits it, and its own short name, for the automations that name a machine.
    const here = new Map<string, { readonly edits: boolean; readonly machine: string | undefined }>();
    const runsHere = (canvasName: string, automation: Automation): boolean => {
      const stand = here.get(canvasName);
      if (stand === undefined) return false;
      return automation.machine === undefined
        ? stand.edits
        : stand.machine !== undefined && isThisMachine(automation.machine, stand.machine);
    };
    // Read where this machine stands, and whether any automation of the canvas runs here.
    const runsAny = (canvasName: string) =>
      Effect.gen(function* () {
        const edits = yield* records.editsCanvas(canvasName).pipe(Effect.orElseSucceed(() => false));
        const machine = Option.isSome(machines)
          ? yield* machines.value.machineName.pipe(Effect.orElseSucceed(() => undefined))
          : undefined;
        here.set(canvasName, { edits, machine });
        const state = yield* repository.loadState(canvasName).pipe(Effect.orElseSucceed(() => new Map()));
        return [...state.values()].some((entry) => !entry.archived && runsHere(canvasName, entry.automation));
      });
    // A code step's run: its values as text, and the region's environment here.
    const performCode = (canvasName: string, automation: Automation, step: Extract<Action, { readonly kind: "code" }>, index: number, firingId: FiringId, fired: Fired) =>
      Effect.gen(function* () {
        const canvas = canvases.get(canvasName);
        const reads = yield* firedReads(canvasName, fired);
        const values: Record<string, string> = {};
        for (const name of automationValuesOf(automation.trigger)) {
          const value = firedValue(name, fired, reads, canvas, canvasName);
          if (value !== undefined) values[name] = value;
        }
        for (const [field, value] of Object.entries(fired.code ?? {})) values[`code.${field}`] = String(value);
        const machine = here.get(canvasName)?.machine;
        if (canvas === undefined || machine === undefined) return notAvailable(index);
        const { resolveRegionEnvironment } = yield* Effect.promise(() => import("../region-env/live"));
        const { env } = yield* Effect.promise(() => resolveRegionEnvironment(canvas, automation.nodeId, machine));
        return yield* runCodeStep(Option.getOrUndefined(codeRunner), {
          canvasName,
          automation,
          step,
          index,
          firingId,
          at: fired.at,
          cause: fired.cause ?? "run",
          event: fired.event ?? null,
          values,
          ...(reads.artifact === undefined
            ? {}
            : {
                artifact: {
                  artifactId: reads.artifact.artifact.artifactId,
                  nodeId: reads.artifact.artifact.nodeId,
                  title: reads.artifact.artifact.title,
                  version: reads.artifact.artifact.version,
                  labels: reads.artifact.artifact.labels,
                  body: reads.artifact.body,
                },
              }),
          env,
        });
      }).pipe(Effect.catchCause(() => Effect.succeed(notAvailable(index))));
    /**
     * A seat control (0.11, 05 S4): a seat on this machine is judged by the
     * one judge and done here, recorded with no row; a seat on another
     * machine is asked of it with a `seat.control` row, held as mail is, and
     * the action waits `queued` for the settled row to resolve it.
     */
    const performSeatControl = (
      canvasName: string,
      automation: Automation,
      action: Extract<Action, { readonly kind: "seat-control" }>,
      index: number,
      firingId: FiringId,
    ): Effect.Effect<ActionRuling> =>
      Effect.gen(function* () {
        const canvas = canvases.get(canvasName);
        const store = Option.getOrUndefined(workRepository);
        const from = decodeAutomationNode(automation.nodeId);
        if (canvas === undefined || store === undefined || Option.isNone(machines) || Option.isNone(from) || action.seat.kind !== "seat") {
          return notAvailable(index);
        }
        const placement = yield* canvasPlacement(canvasName).pipe(
          Effect.provideService(MachineRepository, machines.value),
          Effect.provideService(ModelRecords, records),
          Effect.provideService(AutomationRepository, repository),
          Effect.orElseSucceed(() => undefined),
        );
        const self = yield* machines.value.installationId.pipe(Effect.orElseSucceed(() => undefined));
        const home = placement?.seatOf(action.seat.nodeId);
        const controlId = seatControlItemId({ firingId, actionIndex: index });
        const nowEpochMs = Date.now();
        // A seat this copy puts on this machine: the one judge runs here, the
        // outcome is recorded, and no row crosses a wire.
        if (self !== undefined && home !== undefined && home.machine === self && Option.isSome(pause) && Option.isSome(occupy)) {
          const folded = (yield* repository.loadState(canvasName).pipe(Effect.orElseSucceed(() => new Map()))).get(
            automation.automationId,
          );
          const outcome = yield* runSeatControl({
            judge: {
              canvas,
              automation:
                folded === undefined
                  ? undefined
                  : { nodeId: folded.automation.nodeId, author: folded.automation.author, archived: folded.archived },
              playing: pause.value.stateFor(canvasName).playing,
              recentForSeat: yield* store.seatControlRows.recentForSeat(
                canvasName,
                action.seat.nodeId,
                nowEpochMs - SEAT_CONTROL_RATE_WINDOW_MS,
              ),
              recordedOutcome: yield* store.seatControlRows.outcome(canvasName, firingId, index),
              originAtEpochMs: nowEpochMs,
              firstSeenEpochMs: nowEpochMs,
              nowEpochMs,
            },
            control: { seat: action.seat.nodeId, automationNode: from.value, automationId: automation.automationId },
            act:
              action.op === "start"
                ? startSeat({
                    canvas: asCanvasName(canvasName),
                    seatId: asNodeId(action.seat.nodeId),
                    operationId: controlId,
                  }).pipe(
                    Effect.provideService(ModelService, model),
                    Effect.provideService(ActorSeatOccupy, occupy.value),
                  )
                : stopSeat({
                    canvas: asCanvasName(canvasName),
                    seatId: asNodeId(action.seat.nodeId),
                    operationId: controlId,
                  }).pipe(
                    Effect.provideService(ModelService, model),
                    Effect.provideService(ActorSeatOccupy, occupy.value),
                  ),
            commit: (settled) =>
              store.seatControlRows.record({
                canvasName,
                controlId,
                seat: action.seat.nodeId,
                op: action.op,
                automationNode: from.value,
                automationId: automation.automationId,
                firingId,
                actionIndex: index,
                ...settled,
              }),
          }).pipe(Effect.orElseSucceed(() => ({ outcome: "refused", reason: "failed" }) as const));
          // Nothing on this machine waits: a control it cannot judge now is
          // one whose automation is already gone — refused, not held.
          if (outcome === "pending") return { index, ruling: "refused", reason: "not_permitted" } as const;
          return outcome.outcome === "applied"
            ? ({ index, ruling: "applied" } as const)
            : ({
                index,
                ruling: "refused",
                reason: outcome.reason === undefined ? "not_available" : SEAT_CONTROL_REFUSAL_TO_RULING[outcome.reason],
              } as const);
        }
        // Another machine's seat, or a seat this copy does not place: the row
        // goes to the seat's machine and is held until a path exists.
        const body: SeatControlResult = {
          operation: "seat.control",
          seat: action.seat.nodeId,
          automationNode: from.value,
          automationId: automation.automationId,
          firingId,
          actionIndex: index,
          op: action.op,
          actor: automationActorRef(canvasName, from.value, automation.automationId),
        };
        const written = yield* store.seatControlSubmit(canvasName, body).pipe(Effect.result);
        return written._tag === "Success"
          ? ({ index, ruling: "queued" } as const)
          : ({ index, ruling: "refused", reason: "not_available" } as const);
      }).pipe(Effect.catchCause(() => Effect.succeed(notAvailable(index))));
    // An action's text with its `{{name}}` values said as this firing says them; a value it lacks stays as written.
    const resolveFor = (canvasName: string, fired: Fired) => (text: string): Effect.Effect<string> =>
      valueNamesIn(text).length === 0
        ? Effect.succeed(text)
        : Effect.map(firedReads(canvasName, fired), (reads) =>
            resolveValues(text, (name) => firedValue(name, fired, reads, canvases.get(canvasName), canvasName) ?? `{{${name}}}`));
    const ports: RunnerPorts = {
      canvas: (canvasName) => canvases.get(canvasName),
      runsHere,
      holds: (canvasName, condition) => conditionHolds(condition, views.get(canvasName) ?? EMPTY_VIEW),
      // Until mail and commands are valid from an automation's own machine (S2), only the editing machine acts.
      // A code step runs on the automation's own machine, which is here: it writes nothing another machine judges.
      perform: (canvasName, automation, action, index, firingId, fired) =>
        action.kind === "code" ? performCode(canvasName, automation, action, index, firingId, fired)
        // A seat control acts here or writes its row (S4).
        : action.kind === "seat-control" ? performSeatControl(canvasName, automation, action, index, firingId)
        // An artifact write is ruled where the canvas is ruled; it does not queue yet (B1).
        : isArtifactAction(action) ? performArtifactAction(artifactPort, {
            canvas: canvases.get(canvasName),
            canvasName,
            automation,
            action,
            index,
            fired,
            resolve: resolveFor(canvasName, fired),
            idOf: (part) => automationMailId(firingId, index, part),
            rules: here.get(canvasName)?.edits === true,
          })
        // An automation acts from its own machine (S2): mail goes out from here, and a task write is
        // ruled here when this machine rules the canvas, or proposed to the machine that does.
        : performAction(work, here.get(canvasName)?.edits === true ? tasks : Option.map(tasks, (task) => ({ ...task, queue: queueFor(canvasName) })), canvases.get(canvasName), canvasName, automation, action, index, firingId, resolveFor(canvasName, fired), here.get(canvasName)?.edits === true).pipe(
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
    // The task rulings since the canvas's cursor, and the seq to move it to once they fired.
    // The first pass ever is a baseline: it fires nothing and starts the cursor at the newest ruling.
    const readTaskChanges = (canvasName: string) =>
      Effect.gen(function* () {
        const cursor = yield* repository.rulingCursor(canvasName);
        const read = yield* repository.taskRulingsSince(canvasName, cursor ?? RULINGS_START, TASK_STATES_READ_MAX);
        if (cursor === undefined) {
          // Past every ruling now, not only the first page.
          let through = read.through;
          for (let page = read; page.more; through = page.through) {
            page = yield* repository.taskRulingsSince(canvasName, page.through, TASK_STATES_READ_MAX);
          }
          return { changes: [] as ReadonlyArray<ChangeEvent>, through: Option.some(through) };
        }
        return { changes: taskChangesOf(read.rulings), through: Option.some(read.through) };
      }).pipe(
        // An unreadable store fires nothing and keeps the cursor, so the next pass reads the same rulings.
        Effect.orElseSucceed(() => ({ changes: [] as ReadonlyArray<ChangeEvent>, through: Option.none<string>() })),
      );
    // Read the canvas and its view for this pass, and say what changed since the last one.
    const load = (canvasName: string) =>
      model.canvas(canvasName).pipe(
        Effect.flatMap((canvas) =>
          Effect.flatMap(Effect.all([
            readConditionView(canvasName, canvas),
            readArtifacts(canvasName, canvas),
            readComments(canvasName, canvas),
          ]), ([read, artifacts, { comments: readNow, unread }]) => Effect.gen(function* () {
            const held = views.get(canvasName);
            // A node whose read failed keeps the comments it held, so the next good read finds only new ones.
            const comments = [...readNow, ...(held?.comments ?? []).filter((comment) => unread.has(comment.node))];
            const view: ConditionView = { ...read, artifacts, comments };
            // A node's first good read is its baseline: what it holds then fires nothing, as on a first pass.
            const baselined = commentsRead.get(canvasName) ?? new Set<string>();
            const baseline = readNow.filter((comment) => !baselined.has(comment.node));
            const before = held === undefined ? held : { ...held, comments: [...(held.comments ?? []), ...baseline] };
            for (const node of canvas.nodes.values()) {
              if (node.kind === "artifacts" && !unread.has(node.id)) baselined.add(node.id);
            }
            commentsRead.set(canvasName, baselined);
            const written = artifactsWritten(before, view);
            const automated = Option.isNone(sql) ? new Set<string>() : yield* artifactsWrittenByAutomation(sql.value, canvasName, written);
            const changes = changesBetween(before, view, Option.isNone(seatStates), automated);
            // Keep the artifacts this read left out, as they were, for the next diff.
            const seenArtifacts = new Set(artifacts.map((artifact) => artifact.artifactId));
            const keptArtifacts = (before?.artifacts ?? []).filter((artifact) => !seenArtifacts.has(artifact.artifactId));
            canvases.set(canvasName, canvas);
            views.set(canvasName, { ...view, artifacts: [...artifacts, ...keptArtifacts], comments });
            return changes;
          })),
        ),
        Effect.catchCause(() =>
          Effect.sync(() => {
            canvases.delete(canvasName);
            views.delete(canvasName);
            commentsRead.delete(canvasName);
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
    // Fire what moved since the last pass: the task rulings first, in the order they landed, then the rest.
    // The ruling cursor moves only once they fired; a canvas that could not be read fires nothing and keeps it.
    const pass = (canvasName: string) =>
      Effect.gen(function* () {
        const tasks = yield* readTaskChanges(canvasName);
        const rest = yield* load(canvasName);
        if (!canvases.has(canvasName)) return;
        yield* changed(canvasName, [...tasks.changes, ...rest]);
        if (Option.isSome(tasks.through)) yield* repository.setRulingCursor(canvasName, tasks.through.value);
      });

    const tickAll = turn.withPermits(1)(Effect.gen(function* () {
      const names = yield* model.listCanvases().pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
      for (const name of names) {
        if (!(yield* runsAny(name))) continue;
        yield* pass(name);
        yield* withRepository(runner.tick(name));
      }
    }));

    const wake = (canvasName: string) =>
      turn.withPermits(1)(Effect.gen(function* () {
        if (!(yield* runsAny(canvasName))) return;
        yield* pass(canvasName);
      }));

    const heard = (canvasName: string, event: ChangeEvent) =>
      turn.withPermits(1)(Effect.gen(function* () {
        if (!(yield* runsAny(canvasName))) return;
        // The canvas as it is now, for the reach the firing is checked against; what moved meanwhile goes first.
        yield* pass(canvasName);
        yield* withRepository(runner.onChange(canvasName, event));
      }));

    // A seat-state firing names its seat by binding id: the agent node holding it, on a canvas this machine edits.
    const seatFired = (firing: SeatStateFiring) =>
      Effect.gen(function* () {
        const names = yield* model.listCanvases().pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
        for (const name of names) {
          const canvas = yield* model.canvas(name).pipe(Effect.option);
          if (Option.isNone(canvas)) continue;
          const seat = [...canvas.value.nodes.values()].find((node) => node.kind === "agent" && (node.bindingId as string) === firing.seat);
          if (seat === undefined) continue;
          yield* heard(name, { kind: "seat", key: firing.key, seat: seat.id, becomes: firing.becomes });
        }
      });

    const onRun = (canvasName: string, automationId: AutomationId) =>
      turn.withPermits(1)(Effect.gen(function* () {
        if (!(yield* runsAny(canvasName))) return undefined;
        yield* pass(canvasName);
        return yield* withRepository(runner.onRun(canvasName, automationId));
      }));

    return AutomationRunnerService.of({ tickAll, wake, heard, seatFired, onRun });
  }),
);

/**
 * A signal as a change trigger hears it: only when raised, keyed by its id so
 * a claim dedupes it. A signal an automation can watch is a seat's own, so the
 * operator's notice and work never fire one.
 */
export const signalChange = (
  signal: Pick<AgentSignal, "signalId" | "nodeId" | "kind" | "state" | "text">,
): Extract<ChangeEvent, { readonly kind: "signal" }> | undefined =>
  signal.state === "open" && isSeatRaiseKind(signal.kind)
    ? { kind: "signal", key: `signal:${signal.signalId}`, seat: signal.nodeId as NodeId, signal: signal.kind, text: signal.text }
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
    // The runtime seat states, held and settled by pty's rules, when this build has them.
    const seatStates = yield* Effect.serviceOption(SeatStateSource);
    if (Option.isSome(seatStates)) {
      yield* seatStates.value.firings.pipe(
        Stream.runForEach((firing) =>
          runner.seatFired(firing).pipe(Effect.catchCause((cause) => Effect.logWarning("automation seat-state firing failed", cause))),
        ),
        Effect.forkScoped,
      );
    }
    yield* Queue.take(writes).pipe(
      Effect.flatMap((wake) => (wake.kind === "write" ? runner.wake(wake.canvasName) : runner.heard(wake.canvasName, wake.event))),
      Effect.catchCause((cause) => Effect.logWarning("automation change pass failed", cause)),
      Effect.forever,
      Effect.forkScoped,
    );
  }),
);
