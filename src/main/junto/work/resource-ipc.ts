// The renderer's tasks and artifacts over IPC (`resource-ipc.ts` in shared).
// Reads come from the task store and the ArtifactRepository through the same
// ports the CLI verbs use; a write is one ResourceCommand from the operator,
// submitted to the same ruler. There is no second write path: this file only
// builds the command and turns what the ruler made into an outcome.

import type { IpcMain } from "electron";
import { Effect, Option, Schema } from "effect";
import type { ArtifactBody, ArtifactOp, ArtifactVersion, ArtifactVersionRecord } from "@shared/artifact";
import type { Canvas } from "@shared/model";
import type { NodeId } from "@shared/physics/schema";
import { refusalError, type ResourceCommand } from "@shared/resource-command";
import {
  ARTIFACT_HISTORY_PAGE,
  ArtifactApplyInput,
  ArtifactBodyInput,
  ArtifactHistoryInput,
  ArtifactListInput,
  RESOURCE_IPC_CHANNELS,
  TaskAllInput,
  TaskApplyInput,
  TaskContextInput,
  TaskListInput,
  taskCanvasFactsOf,
  type ResourceChanged,
  type ArtifactApplyOutcome,
  type ArtifactHead,
  type ResourceIpcDomain,
  type TaskApplyOutcome,
  type TaskCanvasFacts,
} from "@shared/resource-ipc";
import { taskRefusalMessage } from "@shared/task-machine";
import {
  checkTaskCommand,
  seatNodeId,
  taskNodeId,
  TASK_STATES,
  type TaskCommandWire,
  type TaskId,
  type TaskView,
} from "@shared/task-model";
import type { WorkErrorBody } from "@shared/work-control";
import type { ItemId, OpId } from "@shared/work-ids";
import { liveArtifactPorts, type ArtifactPorts } from "./artifact-control";
import { WorkService } from "./service";
import { liveTaskPorts, taskCanvasEnv, taskRulingContext, type TaskPorts } from "./task-control";

/** What the handlers read and write through. Live: the CLI's own ports and the work topology. */
export type ResourceIpcPorts = {
  readonly topology: (canvasName: string) => Effect.Effect<Canvas, WorkErrorBody>;
  readonly tasks: Pick<TaskPorts, "list" | "submit" | "deliver">;
  readonly artifacts: Pick<ArtifactPorts, "list" | "head" | "body" | "history" | "submit">;
  /** Told after every applied write, so windows read again. */
  readonly changed: (domain: ResourceIpcDomain, canvasName: string) => void;
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
 * wire command is narrowed against the canvas first (`checkTaskCommand`): a
 * seat it names is an agent and a next node a task node, or it is refused.
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
    const checked = checkTaskCommand(wire, (id) => canvas.nodes.get(id)?.kind);
    if (!checked.ok) {
      const { reason, detail } = checked.refusal;
      return { kind: "refused" as const, opId, error: refusalError({ reason, message: taskRefusalMessage(detail), expected: detail }) };
    }
    const command = commandOf(canvasName, "task", nodeId, taskId, opId, checked.command);
    const outcome = yield* ports.tasks.submit(command, taskRulingContext(canvas), taskCanvasEnv(canvas));
    if (outcome.kind === "refused") return { kind: "refused" as const, opId, error: outcome.error };
    if (!outcome.replay) {
      yield* ports.tasks.deliver({ canvas, canvasName, actor: operator, opId, task: outcome.task, effects: outcome.effects });
      ports.changed("task", canvasName);
    }
    return { kind: "applied" as const, opId };
  }).pipe(Effect.catch((error: WorkErrorBody) => Effect.succeed({ kind: "refused" as const, opId, error })));

// ── artifacts ──────────────────────────────────────────────────────────────

/** The artifacts on one node, archived ones too, newest change first, each with its head body. */
export const listArtifacts = (ports: ResourceIpcPorts, canvasName: string, nodeId: NodeId) =>
  Effect.gen(function* () {
    const lists = yield* Effect.forEach([false, true], (archived) =>
      ports.artifacts.list(canvasName, { nodeIds: [nodeId], archived, limit: SCAN_LIMIT }),
    );
    const items = lists.flatMap((list) => list.artifacts).sort((a, b) => b.updatedAt - a.updatedAt);
    const heads = yield* Effect.forEach(items, (item) => ports.artifacts.head(canvasName, item.artifactId));
    return heads.flatMap((head): ReadonlyArray<ArtifactHead> =>
      Option.isNone(head) ? [] : [{ artifact: head.value.artifact, body: head.value.body, bodyRef: head.value.bodyRef }],
    );
  });

/** The last page of versions, newest first, each with its body; a version whose body the store lacks is left out. */
export const artifactHistory = (ports: ResourceIpcPorts, canvasName: string, artifactId: ItemId) =>
  Effect.gen(function* () {
    const { versions } = yield* ports.artifacts.history(canvasName, artifactId, { limit: ARTIFACT_HISTORY_PAGE });
    const records = yield* Effect.forEach(versions, (version) =>
      Effect.map(ports.artifacts.body(canvasName, artifactId, version.version), (body) =>
        Option.isNone(body)
          ? []
          : [{ artifactId, version: version.version, author: version.author, at: version.at, body: body.value.body }],
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
  Effect.map(ports.artifacts.body(canvasName, artifactId, version), (read) => (Option.isNone(read) ? null : read.value.body));

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
    const command = commandOf(canvasName, "artifact", nodeId, artifactId, opId, op);
    const outcome = yield* ports.artifacts.submit(command, taskRulingContext(canvas));
    if (outcome.kind === "refused") return { kind: "refused" as const, opId, error: outcome.error };
    // A retry is answered from the stored ruling with no facts: nothing changed.
    if (outcome.facts.length > 0) ports.changed("artifact", canvasName);
    return { kind: "applied" as const, opId, facts: outcome.facts };
  }).pipe(Effect.catch((error: WorkErrorBody) => Effect.succeed({ kind: "refused" as const, opId, error })));

// ── registration ───────────────────────────────────────────────────────────

/** Runs a handler in the app runtime; the work topology needs WorkService. */
export type ResourceIpcRun = <A, E>(effect: Effect.Effect<A, E, WorkService>) => Promise<A>;

/** The running core's ports: the CLI verbs' own, and the canvas as the work plane reads it. */
export const liveResourceIpcPorts = (broadcast: (channel: string, payload: ResourceChanged) => void): ResourceIpcPorts => ({
  topology: (canvasName) =>
    Effect.flatMap(WorkService, (work) => work.readTopology(canvasName)).pipe(
      Effect.map((read) => read.canvas),
      Effect.mapError((error): WorkErrorBody => ({ type: "InternalError", message: error.message, details: { retryable: true } })),
    ) as Effect.Effect<Canvas, WorkErrorBody>,
  tasks: liveTaskPorts,
  artifacts: liveArtifactPorts,
  changed: (domain, canvasName) => broadcast(RESOURCE_IPC_CHANNELS[domain].changed, { canvasName }),
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
 */
export const registerResourceIpc = (
  ipc: Pick<IpcMain, "handle">,
  run: ResourceIpcRun,
  ports: ResourceIpcPorts,
  enabled: { readonly task: boolean; readonly artifact: boolean },
  authoring: { readonly task: ResourceAuthoring; readonly artifact: ResourceAuthoring },
): void => {
  const on = <S extends Schema.Top, A>(
    channel: string,
    schema: S,
    handle: (input: S["Type"]) => Effect.Effect<A, WorkErrorBody, WorkService>,
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
  }
  const artifact = RESOURCE_IPC_CHANNELS.artifact;
  if (enabled.artifact) {
    on(artifact.list, ArtifactListInput, (input) => listArtifacts(ports, input.canvasName, input.nodeId));
    on(artifact.history, ArtifactHistoryInput, (input) => artifactHistory(ports, input.canvasName, input.artifactId));
    on(artifact.body, ArtifactBodyInput, (input) => artifactBody(ports, input.canvasName, input.artifactId, input.version));
    on(artifact.apply, ArtifactApplyInput, (input) =>
      applyArtifact(ports, input.canvasName, input.nodeId, input.artifactId, input.opId, input.op), authoring.artifact);
  }
};
