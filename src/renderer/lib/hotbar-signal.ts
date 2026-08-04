/**
 * Hotbar chip signal for any slotted node (region or free node).
 * Reuses MemberSeverity + attentionOf — does not re-derive execution graph.
 */

import { attentionOf } from "@shared/attention";
import type { CanvasNode } from "@shared/canvas";
import { isBlockableNode } from "@shared/execution-graph";
import type { MemberSeverity } from "@shared/region-rollup";

/**
 * Severity for a hotbar chip.
 * Priority: region rollup → member map → flags → sink attention → idle.
 */
export function hotbarNodeSeverity(
  node: CanvasNode,
  options: {
    readonly regionSeverity?: MemberSeverity;
    readonly memberSeverity?: MemberSeverity;
  } = {},
): MemberSeverity {
  if (node.type === "group") {
    return options.regionSeverity ?? "idle";
  }
  if (options.memberSeverity !== undefined) {
    return options.memberSeverity;
  }

  const flags = node.ether?.flags ?? [];
  // Seat stoppage only — stray flag:blocker on relay/page is not blocked.
  if (flags.includes("blocker") && isBlockableNode(node)) return "blocked";
  if (flags.includes("attention")) return "attention";
  if (flags.includes("parked")) return "parked";

  const kind = node.ether?.entity?.kind;
  if (kind === "task") {
    const items = node.ether?.tasks?.items ?? [];
    if (items.some((t) => t.state === "input-required" || t.state === "auth-required")) {
      return "attention";
    }
    if (items.some((t) => t.state === "working")) return "working";
  }
  if (kind === "requests") {
    const items = node.ether?.requests?.items ?? [];
    if (items.some((t) => t.state === "input-required" || t.state === "auth-required")) {
      return "attention";
    }
  }

  // Document+graph glance — graph omitted (chip does not own execution tick).
  const attention = attentionOf(node, undefined);
  if (attention === "fire") return "attention";

  return "idle";
}
