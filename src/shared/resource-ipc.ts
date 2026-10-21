/**
 * The renderer's resource source over IPC (plan 0.10/04 and 05): tasks and
 * artifacts read from main's stores and written through main's ruler, the
 * same path the CLI takes. One pattern for both domains, so a pane's source
 * swaps its local stand-in for main's without changing shape.
 *
 * Every write is the operator's. The renderer mints the item id on create and
 * the opId for each command, so a resend after a lost answer is the same
 * command and the ruler answers it from its stored ruling. Main builds the
 * `ResourceCommand` (actor operator, no basis, no after) and submits it.
 *
 * Channels are named here; payloads are decoded in main against the schemas
 * below, with excess keys refused. A task command travels as the model's own
 * `TaskCommandWire` and main narrows it with `checkTaskCommand` against the
 * canvas, as the ruler does for every writer.
 */
import { Schema } from "effect";
import { ArtifactOp, ArtifactVersion, type ArtifactBody, type ArtifactVersionRecord } from "./artifact";
import type { ArtifactEntry, ArtifactFact } from "./artifact-domain";
import type { OpOverlay } from "./op-control";
import { NodeId } from "./physics/schema";
import { RefusalReason } from "./resource-command";
import type { TaskDomainEnv } from "./task-machine";
import {
  TASK_REFUSAL_REASON,
  TaskCommandWire,
  type SeatNodeId,
  type StampPolicy,
  type TaskCommand,
  type TaskId,
  type TaskNodeId,
  type TaskRefusal,
  type TaskRefusalDetail,
  type TaskView,
} from "./task-model";
import type { WorkErrorBody } from "./work-control";
import { ItemId, OpId } from "./work-ids";

// ── channels ───────────────────────────────────────────────────────────────

export { RESOURCE_IPC_CHANNELS, type ResourceIpcDomain } from "./resource-ipc-channels";

// ── outcomes ───────────────────────────────────────────────────────────────

/**
 * What one write comes back as. `queued` is a success: the command is durable
 * and will be ruled (02); the pane shows it pending. A refusal is the
 * ruler's own `WorkErrorBody`, `details.reason` its closed `RefusalReason`.
 */
export type ResourceApplyOutcome<Applied extends object = {}> =
  | ({ readonly kind: "applied"; readonly opId: OpId } & Applied)
  | { readonly kind: "refused"; readonly opId: OpId; readonly error: WorkErrorBody }
  | { readonly kind: "queued"; readonly opId: OpId };

/**
 * `deliveryError`: the write was ruled and stands, but the mail it owes (an
 * assignment, a stamp request) did not go. A resend is answered as a replay
 * and sends nothing, so the pane says so instead of retrying.
 */
export type TaskApplyOutcome = ResourceApplyOutcome<{ readonly deliveryError?: WorkErrorBody }>;
/** `facts` is empty when a resend is answered from the stored ruling: nothing changed again. */
export type ArtifactApplyOutcome = ResourceApplyOutcome<{ readonly facts: ReadonlyArray<ArtifactFact> }>;

/**
 * One of this machine's writes to a node's items that the editing machine
 * has not ruled yet, in queue order: every seat's and the operator's, never
 * another machine's. `overlay` is what `op list` reads of it over the ruled
 * state (02 read-your-writes); absent when the build has no overlay reader
 * for the domain, which today is every task write.
 */
export type ArtifactPendingWrite = {
  readonly opId: OpId;
  readonly artifactId: ItemId;
  readonly op: ArtifactOp;
  readonly overlay?: OpOverlay;
};
export type TaskPendingWrite = {
  readonly opId: OpId;
  readonly taskId: TaskId;
  readonly command: TaskCommandWire;
  readonly overlay?: OpOverlay;
};

/**
 * Said to every window after a write to a canvas's tasks or artifacts, by
 * anyone, and when one of this machine's queued writes is ruled.
 */
export type ResourceChanged = { readonly canvasName: string };

const isTaskRefusalKind = (kind: unknown): kind is TaskRefusalDetail["kind"] =>
  typeof kind === "string" && Object.hasOwn(TASK_REFUSAL_REASON, kind);

/**
 * A refused task write as the task domain worded it: the ruler carries the
 * detail as `details.expected` (`toRefusal`, task-machine.ts), so a pane reads
 * `detail.kind` exactly as the local machine gives it. Undefined for a
 * refusal before the domain (reach, an unknown target, a full queue).
 */
export const taskRefusalOf = (error: WorkErrorBody): TaskRefusal | undefined => {
  const reason = error.details?.reason;
  const expected = error.details?.expected as { readonly kind?: unknown } | undefined;
  if (!Schema.is(RefusalReason)(reason) || typeof expected !== "object" || expected === null) return undefined;
  if (!isTaskRefusalKind(expected.kind) || TASK_REFUSAL_REASON[expected.kind] !== reason) return undefined;
  return { reason, detail: expected as TaskRefusalDetail };
};

// ── task inputs ────────────────────────────────────────────────────────────

const CanvasNameInput = Schema.String.pipe(Schema.check(Schema.isMinLength(1)), Schema.check(Schema.isMaxLength(128)));
const strict = { parseOptions: { onExcessProperty: "error" as const } };

export const TaskListInput = Schema.Struct({ canvasName: CanvasNameInput, nodeId: NodeId }).annotate(strict);
export const TaskAllInput = Schema.Struct({ canvasName: CanvasNameInput }).annotate(strict);
export const TaskContextInput = TaskAllInput;
export const TaskPendingInput = TaskListInput;
export const TaskApplyInput = Schema.Struct({
  canvasName: CanvasNameInput,
  nodeId: NodeId,
  taskId: ItemId,
  opId: OpId,
  command: TaskCommandWire,
}).annotate(strict);
export { TaskCommandWire };

// ── task ruling context ────────────────────────────────────────────────────

/**
 * What the task domain consults besides the tasks, as data: the flows out of
 * each task node, each node's stamp default, and every seat's reach to each
 * task node (region-reach). A pane builds its `TaskDomainEnv` from it
 * (`taskEnvOf`) to check a command before it sends it; main rules again.
 */
export type TaskCanvasFacts = {
  readonly downstream: Readonly<Record<TaskNodeId, ReadonlyArray<TaskNodeId>>>;
  readonly stampDefaults: Readonly<Record<TaskNodeId, StampPolicy>>;
  /** Per seat, the task nodes it reaches. */
  readonly seatReach: Readonly<Record<SeatNodeId, ReadonlyArray<TaskNodeId>>>;
};

export const taskEnvOf = (facts: TaskCanvasFacts): Omit<TaskDomainEnv, "at"> => ({
  downstream: (node) => facts.downstream[node] ?? [],
  stampDefaultOf: (node) => facts.stampDefaults[node] ?? { required: 0 },
  seatReaches: (seat, node) => facts.seatReach[seat]?.includes(node) ?? false,
});

/** The facts of the task nodes and seats given, read through an env: main's side of `taskEnvOf`. */
export const taskCanvasFactsOf = (
  env: Omit<TaskDomainEnv, "at">,
  taskNodes: ReadonlyArray<TaskNodeId>,
  seats: ReadonlyArray<SeatNodeId>,
): TaskCanvasFacts => ({
  downstream: Object.fromEntries(taskNodes.map((node) => [node, env.downstream(node)])),
  stampDefaults: Object.fromEntries(taskNodes.map((node) => [node, env.stampDefaultOf(node)])),
  seatReach: Object.fromEntries(seats.map((seat) => [seat, taskNodes.filter((node) => env.seatReaches(seat, node))])),
});

// ── artifact inputs ────────────────────────────────────────────────────────

export const ArtifactListInput = TaskListInput;
export const ArtifactPendingInput = TaskListInput;
export const ArtifactHistoryInput = Schema.Struct({ canvasName: CanvasNameInput, artifactId: ItemId }).annotate(strict);
/** One version's body, for an entry whose body is not loaded. */
export const ArtifactBodyInput = Schema.Struct({
  canvasName: CanvasNameInput,
  artifactId: ItemId,
  version: ArtifactVersion,
}).annotate(strict);
export const ArtifactApplyInput = Schema.Struct({
  canvasName: CanvasNameInput,
  nodeId: NodeId,
  artifactId: ItemId,
  opId: OpId,
  op: ArtifactOp,
}).annotate(strict);

/** An artifact as listed: the head, its body when loaded (else null), and the body's ref. */
export type ArtifactHead = Pick<ArtifactEntry, "artifact" | "body" | "bodyRef">;

/** At most this many versions in one history read, newest first. */
export const ARTIFACT_HISTORY_PAGE = 50;

// ── the renderer's API ─────────────────────────────────────────────────────

export type TaskResourceApi = {
  /** The tasks on this node now, oldest first. */
  readonly list: (canvasName: string, nodeId: TaskNodeId) => Promise<ReadonlyArray<TaskView>>;
  /** Every task of the canvas but archived ones: the one open task rule reads them all. */
  readonly all: (canvasName: string) => Promise<ReadonlyArray<TaskView>>;
  readonly context: (canvasName: string) => Promise<TaskCanvasFacts>;
  /** Rule one command; on create the caller mints `taskId` and names it in the command. */
  readonly apply: (
    canvasName: string,
    nodeId: TaskNodeId,
    taskId: TaskId,
    opId: OpId,
    command: TaskCommand,
  ) => Promise<TaskApplyOutcome>;
  /** This machine's unruled writes to the node's tasks, in queue order. */
  readonly pending: (canvasName: string, nodeId: TaskNodeId) => Promise<ReadonlyArray<TaskPendingWrite>>;
  readonly onChanged: (listener: (changed: ResourceChanged) => void) => () => void;
};

export type ArtifactResourceApi = {
  /** The artifacts on this node, newest change first. */
  readonly list: (canvasName: string, nodeId: NodeId) => Promise<ReadonlyArray<ArtifactHead>>;
  /** The last `ARTIFACT_HISTORY_PAGE` versions, newest first, each with its body. */
  readonly history: (canvasName: string, artifactId: ItemId) => Promise<ReadonlyArray<ArtifactVersionRecord>>;
  /** One version's body; null when the store does not hold it. */
  readonly body: (canvasName: string, artifactId: ItemId, version: ArtifactVersion) => Promise<ArtifactBody | null>;
  /** Rule one op; on create the caller mints `artifactId`. */
  readonly apply: (
    canvasName: string,
    nodeId: NodeId,
    artifactId: ItemId,
    opId: OpId,
    op: ArtifactOp,
  ) => Promise<ArtifactApplyOutcome>;
  /** This machine's unruled writes to the node's artifacts, in queue order. */
  readonly pending: (canvasName: string, nodeId: NodeId) => Promise<ReadonlyArray<ArtifactPendingWrite>>;
  readonly onChanged: (listener: (changed: ResourceChanged) => void) => () => void;
};

export type ResourceIpcApi = {
  readonly task: TaskResourceApi;
  readonly artifact: ArtifactResourceApi;
};
