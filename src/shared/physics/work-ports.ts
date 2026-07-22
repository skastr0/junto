import type { WorkOpName } from "../work-control";
import type { Port } from "./schema";

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
  "tasks.claim": "tasks.claim",
  "tasks.update": "tasks.update",
  "msg.list": "msg.list",
  "msg.send": "msg.send",
  "request.create": "request.create",
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
  "artifact.publish",
];
