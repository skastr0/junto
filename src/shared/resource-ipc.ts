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
 * below, with excess keys refused.
 */
import { Schema } from "effect";
import { ArtifactOp, ArtifactVersion, type ArtifactBody, type ArtifactVersionRecord } from "./artifact";
import type { ArtifactEntry, ArtifactFact } from "./artifact-domain";
import { NodeId } from "./physics/schema";
import { RefusalReason } from "./resource-command";
import type { TaskDomainEnv } from "./task-machine";
import {
  TASK_REFUSAL_REASON,
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

export const RESOURCE_IPC_CHANNELS = {
  task: {
    list: "junto:resource-task-list",
    all: "junto:resource-task-all",
    context: "junto:resource-task-context",
    apply: "junto:resource-task-apply",
    changed: "junto:resource-task-changed",
  },
  artifact: {
    list: "junto:resource-artifact-list",
    history: "junto:resource-artifact-history",
    body: "junto:resource-artifact-body",
    apply: "junto:resource-artifact-apply",
    changed: "junto:resource-artifact-changed",
  },
} as const;

export type ResourceIpcDomain = keyof typeof RESOURCE_IPC_CHANNELS;

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

export type TaskApplyOutcome = ResourceApplyOutcome;
export type ArtifactApplyOutcome = ResourceApplyOutcome<{ readonly facts: readonly [ArtifactFact, ...ArtifactFact[]] }>;

/** Said to every window after a write to a canvas's tasks or artifacts, by anyone. */
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

const ReviewerWire = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("seat"), seat: NodeId }).annotate(strict),
  Schema.Struct({ kind: Schema.Literal("operator") }).annotate(strict),
]);

/**
 * `TaskCommand` on the wire. Node ids arrive unbranded; the brands are
 * phantom, so the decoded value is the command (`taskCommandOf`).
 */
export const TaskCommandWire = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("create"),
    taskId: ItemId,
    title: Schema.String,
    body: Schema.optionalKey(Schema.String),
    stampPolicy: Schema.optionalKey(Schema.Struct({ required: Schema.Number }).annotate(strict)),
  }).annotate(strict),
  Schema.Struct({ kind: Schema.Literal("edit"), title: Schema.optionalKey(Schema.String), body: Schema.optionalKey(Schema.String) }).annotate(strict),
  Schema.Struct({ kind: Schema.Literal("assign"), seat: NodeId }).annotate(strict),
  ...(["unassign", "start", "pause", "resume", "cancel", "archive"] as const).map((kind) =>
    Schema.Struct({ kind: Schema.Literal(kind) }).annotate(strict),
  ),
  Schema.Struct({ kind: Schema.Literal("finish"), next: Schema.optionalKey(NodeId) }).annotate(strict),
  Schema.Struct({ kind: Schema.Literal("depend"), on: ItemId }).annotate(strict),
  Schema.Struct({ kind: Schema.Literal("undepend"), on: ItemId }).annotate(strict),
  Schema.Struct({ kind: Schema.Literal("reviewer-add"), reviewer: ReviewerWire }).annotate(strict),
  Schema.Struct({ kind: Schema.Literal("reviewer-remove"), reviewer: ReviewerWire }).annotate(strict),
  Schema.Struct({ kind: Schema.Literal("stamp-policy"), required: Schema.Number }).annotate(strict),
  Schema.Struct({
    kind: Schema.Literal("stamp"),
    verdict: Schema.Literals(["approve", "changes"]),
    subjectHash: Schema.optionalKey(Schema.String),
    text: Schema.optionalKey(Schema.String),
  }).annotate(strict),
]);
export type TaskCommandWire = typeof TaskCommandWire.Type;

/** The decoded wire command as the domain's: its node ids take their brands. */
export const taskCommandOf = (wire: TaskCommandWire): TaskCommand => wire as unknown as TaskCommand;

export const TaskListInput = Schema.Struct({ canvasName: CanvasNameInput, nodeId: NodeId }).annotate(strict);
export const TaskAllInput = Schema.Struct({ canvasName: CanvasNameInput }).annotate(strict);
export const TaskContextInput = TaskAllInput;
export const TaskApplyInput = Schema.Struct({
  canvasName: CanvasNameInput,
  nodeId: NodeId,
  taskId: ItemId,
  opId: OpId,
  command: TaskCommandWire,
}).annotate(strict);

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
  readonly onChanged: (listener: (changed: ResourceChanged) => void) => () => void;
};

export type ResourceIpcApi = {
  readonly task: TaskResourceApi;
  readonly artifact: ArtifactResourceApi;
};
