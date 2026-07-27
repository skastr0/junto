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
/**
 * Target work op → edge Port. Escalate reuses the request.create capability
 * (same edge + requests sink); the block/stop is work-plane seat state.
 */
export const PortForWorkOp = {
  "tasks.list": "tasks.list",
  "tasks.claim": "tasks.claim",
  "tasks.update": "tasks.update",
  "msg.list": "msg.list",
  "msg.send": "msg.send",
  "request.create": "request.create",
  "request.escalate": "request.create",
  "artifact.publish": "artifact.publish",
} as const satisfies Record<TargetWorkOpName, Port>;

export type PortForWorkOp = typeof PortForWorkOp;

export const portForWorkOp = (op: TargetWorkOpName): Port => PortForWorkOp[op];

export const isTargetWorkOp = (op: WorkOpName): op is TargetWorkOpName =>
  op in PortForWorkOp;

export const TARGET_WORK_OPS: ReadonlyArray<TargetWorkOpName> = [
  "tasks.list",
  "tasks.claim",
  "tasks.update",
  "msg.list",
  "msg.send",
  "request.create",
  "request.escalate",
  "artifact.publish",
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
  task: ["tasks.list", "tasks.claim", "tasks.update", "msg.list", "msg.send"],
  requests: ["request.create", "request.escalate", "msg.list", "msg.send"],
  artifacts: ["artifact.publish"],
  page: [],
} as const satisfies Record<SinkKind, ReadonlyArray<TargetWorkOpName>>;

export const opsForSink = (kind: SinkKind): ReadonlyArray<TargetWorkOpName> =>
  OPS_BY_SINK[kind];
