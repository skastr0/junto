/**
 * Hotbar chip signal for any slotted node (region or free node).
 * Reuses MemberSeverity + attentionOf — does not re-derive execution graph.
 */

import type { AgentSeatState } from "@shared/agent-seat-state";
import { attentionOf } from "@shared/attention";
import type { CanvasNode } from "@shared/canvas";
import { isBlockableNode } from "@shared/execution-graph";
import type { MemberSeverity } from "@shared/region-rollup";

const SEVERITY_RANK: Readonly<Record<MemberSeverity, number>> = {
  blocked: 0,
  attention: 1,
  working: 2,
  parked: 3,
  idle: 4,
};

/** Worse operational tier wins (blocked > attention > working > parked > idle). */
export const worseMemberSeverity = (
  a: MemberSeverity,
  b: MemberSeverity,
): MemberSeverity => (SEVERITY_RANK[a] <= SEVERITY_RANK[b] ? a : b);

/**
 * Map live managed-seat / herdr agent status → chip severity.
 *
 * Idle is an **authoritative quiet** for harness activity — return "idle" so
 * hotbar can demote lagging rollup attention/working (seat is truth for that
 * plane). Herdr done is ready/complete green on the card, not chip attention.
 */
export function liveActivitySeverity(input: {
  readonly seatState?: AgentSeatState;
  readonly herdrAgentStatus?: string | null;
}): MemberSeverity | undefined {
  if (input.seatState === "attention") return "attention";
  if (input.seatState === "working") return "working";
  if (input.seatState === "idle" || input.seatState === "gone") return "idle";
  const herdr = input.herdrAgentStatus ?? undefined;
  if (herdr === "blocked") return "blocked";
  if (herdr === "working") return "working";
  if (herdr === "idle" || herdr === "done") return "idle";
  return undefined;
}

/**
 * Severity for a hotbar chip.
 * Priority merge: region rollup / member map / flags / sinks / live seat, worst wins.
 *
 * `liveSeverity` is the freestanding seat plane (managed terminal / herdr) so
 * chips stay synchronized with canvas ActivityMark even when the node is
 * outside every region or rollup lags inventory joins.
 */
export function hotbarNodeSeverity(
  node: CanvasNode,
  options: {
    readonly regionSeverity?: MemberSeverity;
    readonly memberSeverity?: MemberSeverity;
    readonly liveSeverity?: MemberSeverity;
  } = {},
): MemberSeverity {
  if (node.type === "group") {
    return options.regionSeverity ?? "idle";
  }

  let severity: MemberSeverity | undefined = options.memberSeverity;

  if (severity === undefined) {
    const flags = node.ether?.flags ?? [];
    // Seat stoppage only — stray flag:blocker on relay/page is not blocked.
    if (flags.includes("blocker") && isBlockableNode(node)) severity = "blocked";
    else if (flags.includes("attention")) severity = "attention";
    else if (flags.includes("parked")) severity = "parked";
    else {
      const kind = node.ether?.entity?.kind;
      if (kind === "task") {
        const items = node.ether?.tasks?.items ?? [];
        if (items.some((t) => t.state === "input-required" || t.state === "auth-required")) {
          severity = "attention";
        } else if (items.some((t) => t.state === "working")) {
          severity = "working";
        }
      } else if (kind === "requests") {
        const items = node.ether?.requests?.items ?? [];
        if (items.some((t) => t.state === "input-required" || t.state === "auth-required")) {
          severity = "attention";
        }
      }
    }

    if (severity === undefined) {
      // Document+graph glance — graph omitted (chip does not own execution tick).
      const attention = attentionOf(node, undefined);
      if (attention === "fire") severity = "attention";
    }
  }

  if (options.liveSeverity !== undefined) {
    if (options.liveSeverity === "idle") {
      // Seat is quiet — drop harness-tier lag from rollups (attention/working).
      // Keep blocked/parked (graph stoppage / flags), which are not seat waves.
      if (
        severity === undefined ||
        severity === "attention" ||
        severity === "working" ||
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
