import { productNodeKindEnabled } from "../features";
import type { ArtifactControlOp } from "../artifact-control";
import type { TaskControlOp } from "../task-control";
import type { AutomationReadOp } from "../automation-control";
import type { WorkOpName } from "../work-control";
import type { Port, SinkKind } from "./schema";

// Exhaustive WorkOp → Port map for target-scoped work ops.
// Meta/seat-local ops (ping/doctor/capabilities/onboard/since/preamble, and the
// universal agent signals) are not
// ported — they are not edge-scoped host capabilities.

export type TargetWorkOpName = Exclude<
  WorkOpName,
  "ping" | "doctor" | "capabilities" | "onboard" | "since" | "offboard" | "preamble" | "overseer" | "overseer.live" | "msg.sent"
  | "signal.raise" | "signal.clear" | "signal.list" | "op.show" | "op.list" | "env.report" | "logs.read" | "references.list" | "references.read" | "content.stage"
  // Automations are not reached through an edge port (plan 07).
  | AutomationReadOp
  // Nor are artifacts (plan 05): an Artifacts node in reach admits.
  | ArtifactControlOp
  // Nor are tasks (plan 04): a task node in reach admits.
  | TaskControlOp
  | TaskReachOp
>;

/**
 * Writes of the old task store: the overseer's claim and update and
 * WorkService's own. They are no socket op. Gone when canvas deletes that store.
 */
export type OldTaskStoreOp = "task.claim" | "task.update";

/**
 * Task ops that keep their 0.9 handlers (rulings and a task's content;
 * plan 04 leaves their behavior as it is) and the old store's
 * writes. A task node in the caller's reach admits them, as it does the task
 * verbs; content is admitted by the reach of the task node it reads. No port.
 */
export const TASK_REACH_OPS = [
  "rulings",
  "content.path",
  "content.stat",
  "content.materialize",
  "task.claim",
  "task.update",
] as const;
export type TaskReachOp = (typeof TASK_REACH_OPS)[number];

export const isTaskReachOp = (op: string): op is TaskReachOp => (TASK_REACH_OPS as ReadonlyArray<string>).includes(op);

/**
 * One port per target work op. Adding a WorkOpName requires a row here
 * (`satisfies` fails closed).
 */
export const PortForWorkOp = {
  "msg.list": "msg.list",
  "msg.send": "msg.send",
  "msg.prompt": "msg.prompt",
  "seat.wait": "seat.wait",
  "seat.read": "terminal.read",
  // Read/reply reuse list/send edge ports — no new capability surface.
  "msg.read": "msg.list",
  "msg.reply": "msg.send",
  "msg.react": "msg.list",
} as const satisfies Record<TargetWorkOpName, Port>;

export type PortForWorkOp = typeof PortForWorkOp;

export const portForWorkOp = (op: TargetWorkOpName): Port => PortForWorkOp[op];

export const isTargetWorkOp = (op: WorkOpName | OldTaskStoreOp): op is TargetWorkOpName =>
  op in PortForWorkOp;

export const TARGET_WORK_OPS: ReadonlyArray<TargetWorkOpName> = [
  "msg.list",
  "msg.send",
  "msg.prompt",
  "seat.wait",
  "seat.read",
  "msg.read",
  "msg.reply",
  "msg.react",
];

// ---------------------------------------------------------------------------
// The work vocabulary: sink kinds × ops.

/**
 * Ops each sink offers on the work plane. Total over `SinkKind` — a new sink
 * kind with no row here does not compile (`satisfies` fails closed), so the
 * vocabulary cannot gain a kind that silently offers nothing.
 *
 * `page` offers no work op on purpose: `browser.automate` is an edge port
 * driven by the browser plane, not a work-control call.
 */
export const OPS_BY_SINK = {
  // The task ops admit by reach (TASK_REACH_OPS); a task node keeps its thread.
  task: [
    "msg.list",
    "msg.send",
    "msg.read",
    "msg.reply",
    "msg.react",
  ],
  // Artifacts admit by reach (plan 05); no work op checks a port.
  artifacts: [],
  automations: [],
  page: [],
  terminal: [],
} as const satisfies Record<SinkKind, ReadonlyArray<TargetWorkOpName>>;

/**
 * Ops a sink kind offers on the work plane. A feature-gated sink whose gate
 * is off offers none, so role admission, overseer admin, and scope errors all
 * report the same empty vocabulary the kind's empty offers grant.
 */
export const opsForSink = (kind: SinkKind): ReadonlyArray<TargetWorkOpName> =>
  productNodeKindEnabled(kind) ? OPS_BY_SINK[kind] : [];
