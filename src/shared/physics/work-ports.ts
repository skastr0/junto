import type { WorkOpName } from "../work-control";
import type { Port, SinkKind } from "./schema";

// Exhaustive WorkOp → Port map for target-scoped work ops.
// Meta/seat-local ops (ping/doctor/capabilities/onboard/preamble) are not
// ported — they are not edge-scoped host capabilities.

export type TargetWorkOpName = Exclude<
  WorkOpName,
  "ping" | "doctor" | "capabilities" | "onboard" | "preamble"
>;

/**
 * One port per target work op. Adding a WorkOpName requires a row here
 * (`satisfies` fails closed).
 */
export const PortForWorkOp = {
  "tasks.list": "tasks.list",
  "tasks.create": "tasks.create",
  "tasks.claim": "tasks.claim",
  "tasks.update": "tasks.update",
  // Task path reads ride the Tasks node's existing read grant; checks submit
  // through the same grant that moves the task, so no new capability appears.
  "tasks.show": "tasks.list",
  "tasks.rules": "tasks.list",
  "rulings": "tasks.list",
  "tasks.check": "tasks.update",
  // Content access is task-scoped read/materialization and reuses the task
  // sink's existing read grant; it never creates a second storage capability.
  "content.path": "tasks.list",
  "content.stat": "tasks.list",
  "content.materialize": "tasks.list",
  "msg.list": "msg.list",
  "msg.send": "msg.send",
  // Read/reply reuse list/send edge ports — no new capability surface.
  "msg.read": "msg.list",
  "msg.reply": "msg.send",
  "msg.react": "msg.list",
  "request.escalate": "request.escalate",
  "artifact.publish": "artifact.publish",
  "board.list": "board.list",
  "board.create_topic": "board.create_topic",
  "board.post": "board.post",
  "board.mark_read": "board.mark_read",
  // Own tags is a board read — reuses list grant (no new capability surface).
  "board.tags": "board.list",
  "pad.read": "pad.read",
  "pad.patch": "pad.patch",
  "sheet.read": "sheet.read",
  "relay.trigger": "relay.trigger",
} as const satisfies Record<TargetWorkOpName, Port>;

export type PortForWorkOp = typeof PortForWorkOp;

export const portForWorkOp = (op: TargetWorkOpName): Port => PortForWorkOp[op];

export const isTargetWorkOp = (op: WorkOpName): op is TargetWorkOpName =>
  op in PortForWorkOp;

export const TARGET_WORK_OPS: ReadonlyArray<TargetWorkOpName> = [
  "tasks.list",
  "tasks.create",
  "tasks.claim",
  "tasks.update",
  "tasks.show",
  "tasks.rules",
  "tasks.check",
  "rulings",
  "content.path",
  "content.stat",
  "content.materialize",
  "msg.list",
  "msg.send",
  "msg.read",
  "msg.reply",
  "msg.react",
  "request.escalate",
  "artifact.publish",
  "board.list",
  "board.create_topic",
  "board.post",
  "board.mark_read",
  "board.tags",
  "pad.read",
  "pad.patch",
  "sheet.read",
  "relay.trigger",
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
    "tasks.list",
    "tasks.create",
    "tasks.claim",
    "tasks.update",
    "tasks.show",
    "tasks.rules",
    "tasks.check",
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
    "request.escalate",
    "msg.list",
    "msg.send",
    "msg.read",
    "msg.reply",
    "msg.react",
  ],
  artifacts: ["artifact.publish"],
  board: [
    "board.list",
    "board.create_topic",
    "board.post",
    "board.mark_read",
    "board.tags",
  ],
  pad: ["pad.read", "pad.patch"],
  sheet: ["sheet.read"],
  page: [],
  terminal: [],
} as const satisfies Record<SinkKind, ReadonlyArray<TargetWorkOpName>>;

export const opsForSink = (kind: SinkKind): ReadonlyArray<TargetWorkOpName> =>
  OPS_BY_SINK[kind];
