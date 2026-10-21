// The renderer's tasks and artifacts over IPC (`resource-ipc.ts` in shared).
// Reads come from the task store and the ArtifactRepository through the same
// ports the CLI verbs use; a write is one ResourceCommand from the operator,
// submitted to the same ruler. There is no second write path: this file only
// builds the command and turns what the ruler made into an outcome.

import type { IpcMain } from "electron";
import { Effect, Option, Result, Schema } from "effect";
import { decodeArtifactOp, type ArtifactBody, type ArtifactOp, type ArtifactVersion, type ArtifactVersionRecord } from "@shared/artifact";
import type { Canvas } from "@shared/model";
import type { ContentRef } from "@shared/content";
import { operatorReachesResource } from "@shared/content-pull";
import type { OpOverlay } from "@shared/op-control";
import type { NodeId } from "@shared/physics/schema";
import { refusalError, type ResourceCommand } from "@shared/resource-command";
import { rulingContextOf } from "@shared/ruling-context";
import {
  ARTIFACT_HISTORY_PAGE,
  ArtifactApplyInput,
  ArtifactBodyInput,
  ArtifactHistoryInput,
  ArtifactListInput,
  ArtifactPendingInput,
  RESOURCE_IPC_CHANNELS,
  TaskAllInput,
  TaskApplyInput,
  TaskContextInput,
  TaskListInput,
  TaskPendingInput,
  taskCanvasFactsOf,
  type ResourceChanged,
  type ArtifactApplyOutcome,
  type ArtifactHead,
  type ArtifactPendingWrite,
  type TaskApplyOutcome,
  type TaskCanvasFacts,
  type TaskPendingWrite,
} from "@shared/resource-ipc";
import { taskRefusalMessage } from "@shared/task-machine";
import {
  checkTaskCommand,
  seatNodeId,
  taskNodeId,
  TASK_STATES,
  TaskCommandWire,
  type TaskId,
  type TaskView,
} from "@shared/task-model";
import type { WorkErrorBody } from "@shared/work-control";
import type { ItemId, OpId } from "@shared/work-ids";
import { liveArtifactPorts, type ArtifactPorts } from "./artifact-control";
import { queuedOverlays, type QueuedOverlays } from "./op-control";
import { OpRepository } from "./op-repository";
import { onResourceChanged } from "./resource-changes";
import { liveTaskPorts, taskCanvasEnv, taskRulingContext, type TaskPorts } from "./task-control";

/** What the handlers read and write through. Live: the CLI's own ports and the work topology. */
export type ResourceIpcPorts = {
  readonly topology: (canvasName: string) => Effect.Effect<Canvas, WorkErrorBody>;
  readonly tasks: Pick<TaskPorts, "list" | "submit" | "deliver">;
  readonly artifacts: Pick<ArtifactPorts, "list" | "head" | "body" | "history" | "submit" | "pull">;
  /** This machine's unruled queue with its overlays: `op list`'s own read (`queuedOverlays`). */
  readonly queue: (canvasName: string, canvas: Canvas) => Effect.Effect<QueuedOverlays | undefined, WorkErrorBody>;
};

const SCAN_LIMIT = 10_000;
const operator = { kind: "operator" } as const;

const commandOf = <Op>(
  canvasName: string,
  kind: "task" | "artifact",
  nodeId: NodeId,
  itemId: ItemId,
  opId: OpId,
  op: Op,
): ResourceCommand<Op> => ({
  opId,
  canvasName,
  actor: operator,
  target: { kind, nodeId, itemId },
  basis: null,
  after: [],
  op,
});

const byCreated = (a: TaskView, b: TaskView): number => a.createdAt - b.createdAt;

/**
 * The node a write names holds that domain's items: a task on a task node,
 * an artifact on an Artifacts node. The ruler's reach only asks that the
 * canvas holds the node.
 */
const targetRefusal = (canvas: Canvas, nodeId: NodeId, kind: "task" | "artifacts"): WorkErrorBody | undefined => {
  const node = canvas.nodes.get(nodeId);
  if (node === undefined) return refusalError({ reason: "unknown_target", message: `no node ${nodeId} on this canvas` });
  return node.kind === kind
    ? undefined
    : refusalError({ reason: "invalid_input", message: `${nodeId} is not ${kind === "task" ? "a task node" : "an Artifacts node"}` });
};

// ── tasks ──────────────────────────────────────────────────────────────────

/** The tasks on one node, archived ones too, oldest first. */
export const listTasks = (ports: ResourceIpcPorts, canvasName: string, nodeId: NodeId) =>
  ports.tasks
    .list(canvasName, { nodeIds: [taskNodeId(nodeId)], states: TASK_STATES, limit: SCAN_LIMIT })
    .pipe(Effect.map(({ tasks }) => [...tasks].sort(byCreated)));

/** Every task on the canvas's task nodes but archived ones, oldest first. */
export const allTasks = (ports: ResourceIpcPorts, canvasName: string) =>
  Effect.gen(function* () {
    const canvas = yield* ports.topology(canvasName);
    const nodeIds = [...canvas.nodes.values()].filter((node) => node.kind === "task").map((node) => taskNodeId(node.id));
    if (nodeIds.length === 0) return [];
    const { tasks } = yield* ports.tasks.list(canvasName, { nodeIds, limit: SCAN_LIMIT });
    return [...tasks].sort(byCreated);
  });

/** The ruler's view of the canvas as data: the same `taskCanvasEnv` a ruling reads. */
export const taskContext = (ports: ResourceIpcPorts, canvasName: string): Effect.Effect<TaskCanvasFacts, WorkErrorBody> =>
  Effect.map(ports.topology(canvasName), (canvas) => {
    const nodes = [...canvas.nodes.values()];
    return taskCanvasFactsOf(
      taskCanvasEnv(canvas),
      nodes.filter((node) => node.kind === "task").map((node) => taskNodeId(node.id)),
      nodes.filter((node) => node.kind === "agent").map((node) => seatNodeId(node.id)),
    );
  });

/**
 * One operator command, ruled as the CLI's are, its mail delivered once. The
 * target must be a task node, and the wire command is narrowed against the
 * canvas (`checkTaskCommand`): a seat it names is an agent and a next node a
 * task node, or it is refused. Once ruled applied it stays applied: a mail
 * that fails to go is reported beside it, never as a refusal.
 */
export const applyTask = (
  ports: ResourceIpcPorts,
  canvasName: string,
  nodeId: NodeId,
  taskId: TaskId,
  opId: OpId,
  wire: TaskCommandWire,
): Effect.Effect<TaskApplyOutcome> =>
  Effect.gen(function* () {
    const canvas = yield* ports.topology(canvasName);
    const wrongTarget = targetRefusal(canvas, nodeId, "task");
    if (wrongTarget !== undefined) return { kind: "refused" as const, opId, error: wrongTarget };
    const checked = checkTaskCommand(wire, (id) => canvas.nodes.get(id)?.kind);
    if (!checked.ok) {
      const { reason, detail } = checked.refusal;
      return { kind: "refused" as const, opId, error: refusalError({ reason, message: taskRefusalMessage(detail), expected: detail }) };
    }
    const command = commandOf(canvasName, "task", nodeId, taskId, opId, checked.command);
    const outcome = yield* ports.tasks.submit(command, taskRulingContext(canvas), taskCanvasEnv(canvas));
    if (outcome.kind === "refused") return { kind: "refused" as const, opId, error: outcome.error };
    // Queued for the machine that edits the canvas: `junto op show` reads what became of it.
    if (outcome.kind === "queued") return { kind: "queued" as const, opId };
    // The store port says it changed (resource-changes.ts), for every writer alike.
    if (outcome.replay) return { kind: "applied" as const, opId };
    const delivered = yield* Effect.result(
      ports.tasks.deliver({ canvas, canvasName, actor: operator, opId, task: outcome.task, effects: outcome.effects }),
    );
    return delivered._tag === "Failure"
      ? { kind: "applied" as const, opId, deliveryError: delivered.failure }
      : { kind: "applied" as const, opId };
  }).pipe(Effect.catch((error: WorkErrorBody) => Effect.succeed({ kind: "refused" as const, opId, error })));

// ── artifacts ──────────────────────────────────────────────────────────────

/** The artifacts on one node, archived ones too, newest change first, each with its head body. */
/**
 * A body the window found pending: start pulling it from the machine that
 * edits the canvas. Every resource is in the operator's reach; the next read
 * finds it in the store. A list asks again for every head still pending, which
 * costs nothing: pullBody runs one transfer per object and joins the rest.
 */
const pullForOperator = (
  ports: ResourceIpcPorts,
  canvasName: string,
  nodeId: NodeId,
  artifactId: ItemId,
  version: ArtifactVersion,
  ref: ContentRef,
) =>
  ports.artifacts.pull({
    ref,
    reached: operatorReachesResource(canvasName, nodeId),
    owner: { kind: "artifact", canvasName, nodeId, recordId: `${artifactId}@${version}` },
  });

export const listArtifacts = (ports: ResourceIpcPorts, canvasName: string, nodeId: NodeId) =>
  Effect.gen(function* () {
    const lists = yield* Effect.forEach([false, true], (archived) =>
      ports.artifacts.list(canvasName, { nodeIds: [nodeId], archived, limit: SCAN_LIMIT }),
    );
    const items = lists.flatMap((list) => list.artifacts).sort((a, b) => b.updatedAt - a.updatedAt);
    const heads = yield* Effect.forEach(items, (item) => ports.artifacts.head(canvasName, item.artifactId));
    for (const head of heads) {
      if (Option.isSome(head) && head.value.body === null) {
        const { artifact } = head.value;
        yield* pullForOperator(ports, canvasName, nodeId, artifact.artifactId, artifact.version, head.value.bodyRef);
      }
    }
    return heads.flatMap((head): ReadonlyArray<ArtifactHead> =>
      Option.isNone(head) ? [] : [{ artifact: head.value.artifact, body: head.value.body, bodyRef: head.value.bodyRef }],
    );
  });

/** The last page of versions, newest first, each with its body; a version whose body the store lacks is left out. */
export const artifactHistory = (ports: ResourceIpcPorts, canvasName: string, artifactId: ItemId) =>
  Effect.gen(function* () {
    const { versions } = yield* ports.artifacts.history(canvasName, artifactId, { limit: ARTIFACT_HISTORY_PAGE });
    const records = yield* Effect.forEach(versions, (version) =>
      Effect.map(ports.artifacts.body(canvasName, artifactId, version.version), (read) =>
        Option.isNone(read) || read.value.body === null
          ? []
          : [{ artifactId, version: version.version, author: version.author, at: version.at, body: read.value.body }],
      ),
    );
    return records.flat() as ReadonlyArray<ArtifactVersionRecord>;
  });

export const artifactBody = (
  ports: ResourceIpcPorts,
  canvasName: string,
  artifactId: ItemId,
  version: ArtifactVersion,
): Effect.Effect<ArtifactBody | null, WorkErrorBody> =>
  Effect.gen(function* () {
    const read = yield* ports.artifacts.body(canvasName, artifactId, version);
    if (Option.isNone(read)) return null;
    if (read.value.body === null) {
      const head = yield* ports.artifacts.head(canvasName, artifactId);
      if (Option.isSome(head)) yield* pullForOperator(ports, canvasName, head.value.artifact.nodeId, artifactId, version, read.value.bodyRef);
    }
    return read.value.body;
  });

export const applyArtifact = (
  ports: ResourceIpcPorts,
  canvasName: string,
  nodeId: NodeId,
  artifactId: ItemId,
  opId: OpId,
  op: ArtifactOp,
): Effect.Effect<ArtifactApplyOutcome> =>
  Effect.gen(function* () {
    const canvas = yield* ports.topology(canvasName);
    const wrongTarget = targetRefusal(canvas, nodeId, "artifacts");
    if (wrongTarget !== undefined) return { kind: "refused" as const, opId, error: wrongTarget };
    const command = commandOf(canvasName, "artifact", nodeId, artifactId, opId, op);
    // The operator writes no automation, so no automation author is known.
    const outcome = yield* ports.artifacts.submit(command, rulingContextOf(canvas, () => undefined));
    if (outcome.kind === "refused") return { kind: "refused" as const, opId, error: outcome.error };
    // Queued for the machine that edits the canvas: `junto op show` reads what became of it.
    if (outcome.kind === "queued") return { kind: "queued" as const, opId };
    return { kind: "applied" as const, opId, facts: outcome.facts };
  }).pipe(Effect.catch((error: WorkErrorBody) => Effect.succeed({ kind: "refused" as const, opId, error })));

// ── registration ───────────────────────────────────────────────────────────

/** Runs a handler in the app runtime, which holds the stores. */
export type ResourceIpcRun = <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;

const decodeTaskCommand = Schema.decodeUnknownResult(TaskCommandWire);

/** The node's unruled writes of one domain, in queue order, each with its overlay when it has one. */
const pendingOn = <W extends object>(
  ports: ResourceIpcPorts,
  canvasName: string,
  kind: "task" | "artifact",
  nodeId: NodeId,
  write: (opId: OpId, itemId: ItemId, op: unknown) => W | undefined,
): Effect.Effect<ReadonlyArray<W & { readonly overlay?: OpOverlay }>, WorkErrorBody> =>
  Effect.gen(function* () {
    const queued = yield* ports.queue(canvasName, yield* ports.topology(canvasName));
    if (queued === undefined) return [];
    return queued.commands.flatMap(({ opId, target, op }) => {
      if (target.kind !== kind || target.nodeId !== nodeId || target.itemId === undefined) return [];
      const pending = write(opId, target.itemId, op);
      if (pending === undefined) return [];
      const overlay = queued.overlays.get(opId);
      return [overlay === undefined ? pending : { ...pending, overlay }];
    });
  });

export const pendingArtifacts = (ports: ResourceIpcPorts, canvasName: string, nodeId: NodeId) =>
  pendingOn(ports, canvasName, "artifact", nodeId, (opId, artifactId, op): ArtifactPendingWrite | undefined => {
    const decoded = decodeArtifactOp(op);
    return Result.isSuccess(decoded) ? { opId, artifactId, op: decoded.success } : undefined;
  });

export const pendingTasks = (ports: ResourceIpcPorts, canvasName: string, nodeId: NodeId) =>
  pendingOn(ports, canvasName, "task", nodeId, (opId, taskId, op): TaskPendingWrite | undefined => {
    const decoded = decodeTaskCommand(op);
    return Result.isSuccess(decoded) ? { opId, taskId, command: decoded.success } : undefined;
  });

/**
 * The running core's ports: the CLI verbs' own, and the canvas as ipc.ts
 * reads it from the work plane (this file reaches no WorkService).
 */
export const liveResourceIpcPorts = (topology: ResourceIpcPorts["topology"]): ResourceIpcPorts => ({
  topology,
  tasks: liveTaskPorts,
  artifacts: liveArtifactPorts,
  // A build without the record of resource writes queues nothing: no write waits.
  queue: (canvasName, canvas) =>
    Effect.flatMap(Effect.serviceOption(OpRepository), (repository) =>
      Option.isNone(repository)
        ? Effect.succeed(undefined)
        : queuedOverlays(canvasName, canvas).pipe(Effect.provideService(OpRepository, repository.value))),
});

const decoded = <S extends Schema.Top>(schema: S, input: unknown) =>
  Schema.decodeUnknownEffect(schema as never)(input, { onExcessProperty: "error" }) as Effect.Effect<S["Type"], Schema.SchemaError>;

/** A read that fails rejects with the store's own message. */
const asError = (error: WorkErrorBody | Schema.SchemaError): Error => new Error(error.message);

/** A write under its main authoring label (`runMainAuthoring` in ipc.ts), so shutdown drains it. */
export type ResourceAuthoring = <A>(operation: () => Promise<A>) => Promise<A>;

/**
 * The handlers on their channels, each domain behind its feature. Every
 * payload is decoded strictly. A write runs under its authoring label and
 * answers refused rather than rejecting, except when the app is closing.
 * Every applied write, whoever made it, is told to the windows as
 * `<domain>-changed`. Returns the unsubscribe from those notices.
 */
export const registerResourceIpc = (
  ipc: Pick<IpcMain, "handle">,
  run: ResourceIpcRun,
  ports: ResourceIpcPorts,
  broadcast: (channel: string, payload: ResourceChanged) => void,
  enabled: { readonly task: boolean; readonly artifact: boolean },
  authoring: { readonly task: ResourceAuthoring; readonly artifact: ResourceAuthoring },
): (() => void) => {
  const on = <S extends Schema.Top, A>(
    channel: string,
    schema: S,
    handle: (input: S["Type"]) => Effect.Effect<A, WorkErrorBody>,
    authored?: ResourceAuthoring,
  ) =>
    ipc.handle(channel, (_event, input: unknown) => {
      const operation = () => run(Effect.flatMap(decoded(schema, input), handle).pipe(Effect.mapError(asError)));
      return authored === undefined ? operation() : authored(operation);
    });
  const task = RESOURCE_IPC_CHANNELS.task;
  if (enabled.task) {
    on(task.list, TaskListInput, (input) => listTasks(ports, input.canvasName, input.nodeId));
    on(task.all, TaskAllInput, (input) => allTasks(ports, input.canvasName));
    on(task.context, TaskContextInput, (input) => taskContext(ports, input.canvasName));
    on(task.apply, TaskApplyInput, (input) =>
      applyTask(ports, input.canvasName, input.nodeId, input.taskId, input.opId, input.command), authoring.task);
    on(task.pending, TaskPendingInput, (input) => pendingTasks(ports, input.canvasName, input.nodeId));
  }
  const artifact = RESOURCE_IPC_CHANNELS.artifact;
  if (enabled.artifact) {
    on(artifact.list, ArtifactListInput, (input) => listArtifacts(ports, input.canvasName, input.nodeId));
    on(artifact.history, ArtifactHistoryInput, (input) => artifactHistory(ports, input.canvasName, input.artifactId));
    on(artifact.body, ArtifactBodyInput, (input) => artifactBody(ports, input.canvasName, input.artifactId, input.version));
    on(artifact.apply, ArtifactApplyInput, (input) =>
      applyArtifact(ports, input.canvasName, input.nodeId, input.artifactId, input.opId, input.op), authoring.artifact);
    on(artifact.pending, ArtifactPendingInput, (input) => pendingArtifacts(ports, input.canvasName, input.nodeId));
  }
  return onResourceChanged((domain, canvasName) => {
    if (enabled[domain]) broadcast(RESOURCE_IPC_CHANNELS[domain].changed, { canvasName });
  });
};
