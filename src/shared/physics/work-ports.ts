import type { WorkOpName } from "../work-control";
import type { Port, SinkKind } from "./schema";

// Exhaustive WorkOp → Port map for target-scoped work ops.
// Meta ops (ping/doctor/capabilities/onboard) are not ported — they are not
// edge-scoped host capabilities.

export type TargetWorkOpName = Exclude<
  WorkOpName,
  "ping" | "doctor" | "capabilities" | "onboard"
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
  "msg.list": "msg.list",
  "msg.send": "msg.send",
  // Read/reply reuse list/send edge ports — no new capability surface.
  "msg.read": "msg.list",
  "msg.reply": "msg.send",
  "request.escalate": "request.escalate",
  "artifact.publish": "artifact.publish",
  "board.list": "board.list",
  "board.create_topic": "board.create_topic",
  "board.post": "board.post",
  "board.mark_read": "board.mark_read",
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
  "msg.list",
  "msg.send",
  "msg.read",
  "msg.reply",
  "request.escalate",
  "artifact.publish",
  "board.list",
  "board.create_topic",
  "board.post",
  "board.mark_read",
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
    "msg.list",
    "msg.send",
    "msg.read",
    "msg.reply",
  ],
  requests: [
    "request.escalate",
    "msg.list",
    "msg.send",
    "msg.read",
    "msg.reply",
  ],
  artifacts: ["artifact.publish"],
  board: [
    "board.list",
    "board.create_topic",
    "board.post",
    "board.mark_read",
  ],
  page: [],
} as const satisfies Record<SinkKind, ReadonlyArray<TargetWorkOpName>>;

export const opsForSink = (kind: SinkKind): ReadonlyArray<TargetWorkOpName> =>
  OPS_BY_SINK[kind];
