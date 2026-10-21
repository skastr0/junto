import { productNodeKindEnabled } from "../features";
import type { ArtifactControlOp } from "../artifact-control";
import type { AutomationOp } from "../automation-control";
import type { WorkOpName } from "../work-control";
import type { Port, SinkKind } from "./schema";

// Exhaustive WorkOp → Port map for target-scoped work ops.
// Meta/seat-local ops (ping/doctor/capabilities/onboard/preamble, and the
// universal agent signals) are not
// ported — they are not edge-scoped host capabilities.

export type TargetWorkOpName = Exclude<
  WorkOpName,
  "ping" | "doctor" | "capabilities" | "onboard" | "offboard" | "preamble" | "overseer" | "overseer.live" | "msg.sent"
  | "signal.raise" | "signal.clear" | "signal.list" | "op.show" | "op.list" | "env.report" | "logs.read" | "references.list" | "references.read" | "content.stage"
  // Automations are not reached through an edge port (plan 07).
  | AutomationOp
  // Nor are artifacts (plan 05): an Artifacts node in reach admits.
  | ArtifactControlOp
>;

/**
 * One port per target work op. Adding a WorkOpName requires a row here
 * (`satisfies` fails closed).
 */
export const PortForWorkOp = {
  "task.list": "tasks.list",
  "task.wait": "tasks.list",
  "task.create": "tasks.create",
  "task.claim": "tasks.claim",
  "task.update": "tasks.update",
  // Task path reads ride the Tasks node's existing read grant; checks submit
  // through the same grant that moves the task, so no new capability appears.
  "task.show": "tasks.list",
  "task.rules": "tasks.list",
  "rulings": "tasks.list",
  "task.check": "tasks.update",
  // Content access is task-scoped read/materialization and reuses the task
  // sink's existing read grant; it never creates a second storage capability.
  "content.path": "tasks.list",
  "content.stat": "tasks.list",
  "content.materialize": "tasks.list",
  "msg.list": "msg.list",
  "msg.send": "msg.send",
  "msg.prompt": "msg.prompt",
  "seat.wait": "seat.wait",
  "seat.read": "terminal.read",
  "verdict.post": "verdict.post",
  // Read/reply reuse list/send edge ports — no new capability surface.
  "msg.read": "msg.list",
  "msg.reply": "msg.send",
  "msg.react": "msg.list",
  "artifact.publish": "artifact.publish",
  "board.list": "board.list",
  "board.create_topic": "board.create_topic",
  "board.post": "board.post",
  "board.mark_read": "board.mark_read",
  // Own tags is a board read — reuses list grant (no new capability surface).
  "board.tags": "board.list",
} as const satisfies Record<TargetWorkOpName, Port>;

export type PortForWorkOp = typeof PortForWorkOp;

export const portForWorkOp = (op: TargetWorkOpName): Port => PortForWorkOp[op];

export const isTargetWorkOp = (op: WorkOpName): op is TargetWorkOpName =>
  op in PortForWorkOp;

export const TARGET_WORK_OPS: ReadonlyArray<TargetWorkOpName> = [
  "task.list",
  "task.wait",
  "task.create",
  "task.claim",
  "task.update",
  "task.show",
  "task.rules",
  "task.check",
  "rulings",
  "content.path",
  "content.stat",
  "content.materialize",
  "msg.list",
  "msg.send",
  "msg.prompt",
  "seat.wait",
  "seat.read",
  "verdict.post",
  "msg.read",
  "msg.reply",
  "msg.react",
  "artifact.publish",
  "board.list",
  "board.create_topic",
  "board.post",
  "board.mark_read",
  "board.tags",
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
  task: [
    "task.list",
    "task.wait",
    "task.create",
    "task.claim",
    "task.update",
    "task.show",
    "task.rules",
    "task.check",
    "rulings",
    "content.path",
    "content.stat",
    "content.materialize",
    "msg.list",
    "msg.send",
    "msg.read",
    "msg.reply",
    "msg.react",
  ],
  requests: [
    "msg.list",
    "msg.send",
    "msg.read",
    "msg.reply",
    "msg.react",
  ],
  artifacts: ["artifact.publish"],
  automations: [],
  board: [
    "board.list",
    "board.create_topic",
    "board.post",
    "board.mark_read",
    "board.tags",
  ],
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
