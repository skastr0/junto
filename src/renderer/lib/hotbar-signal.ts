/**
 * Hotbar chip signal for any slotted node (region or free node).
 * Reuses MemberSeverity + attentionOf — does not re-derive execution graph.
 */

import type { AgentSeatState } from "@shared/agent-seat-state";
import type { WorkSinkGlance } from "@shared/work-attention";
import type { Task } from "@shared/work-model";
import type { CanvasNode } from "@shared/canvas";
import type { MemberSeverity } from "@shared/region-rollup";

const SEVERITY_RANK: Readonly<Record<MemberSeverity, number>> = {
  blocked: 0,
  attention: 1,
  working: 2,
  ready: 3,
  idle: 4,
};

/** Worse operational tier wins (blocked > attention > working > ready > idle). */
export const worseMemberSeverity = (
  a: MemberSeverity,
  b: MemberSeverity,
): MemberSeverity => (SEVERITY_RANK[a] <= SEVERITY_RANK[b] ? a : b);

/**
 * Map live managed-seat status → chip severity.
 *
 * Idle is an **authoritative quiet** for harness activity — return "idle" so
 * hotbar can demote lagging rollup attention/working (seat is truth for that
 * plane). A seat that finished a turn nobody has read (seat idle + needsLook)
 * is "ready": green on the chip, never chip attention.
 */
export function liveActivitySeverity(input: {
  readonly seatState?: AgentSeatState;
  /** Seat settled after work and the operator has not looked yet. */
  readonly seatNeedsLook?: boolean;
}): MemberSeverity | undefined {
  if (input.seatState === "attention") return "attention";
  if (input.seatState === "working") return "working";
  if (input.seatState === "idle") return input.seatNeedsLook === true ? "ready" : "idle";
  if (input.seatState === "gone") return "idle";
  return undefined;
}

/**
 * Severity for a hotbar chip.
 * Priority merge: region rollup / member map / sinks / live seat, worst wins.
 *
 * `liveSeverity` is the freestanding managed-terminal seat plane so
 * chips stay synchronized with canvas ActivityMark even when the node is
 * outside every region or rollup lags inventory joins.
 */
export function hotbarNodeSeverity(
  node: CanvasNode,
  options: {
    readonly regionSeverity?: MemberSeverity;
    readonly memberSeverity?: MemberSeverity;
    readonly liveSeverity?: MemberSeverity;
    readonly work?: WorkSinkGlance;
    readonly items?: ReadonlyArray<Task>;
  } = {},
): MemberSeverity {
  if (node.type === "group") {
    return options.regionSeverity ?? "idle";
  }

  let severity: MemberSeverity | undefined = options.memberSeverity;

  if (severity === undefined) {
    if (options.work?.needsHuman) severity = "attention";
    else if (options.items?.some((item) => item.state === "working")) severity = "working";
  }

  if (options.liveSeverity !== undefined) {
    if (options.liveSeverity === "idle") {
      // Seat is quiet — drop harness-tier lag from rollups (attention/working).
      // Keep blocked (graph stoppage), which is not a seat wave.
      if (
        severity === undefined ||
        severity === "attention" ||
        severity === "working" ||
        severity === "ready" ||
        severity === "idle"
      ) {
        severity = "idle";
      }
    } else {
      severity =
        severity === undefined
          ? options.liveSeverity
          : worseMemberSeverity(severity, options.liveSeverity);
    }
  }

  return severity ?? "idle";
}
