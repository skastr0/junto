/**
 * Permanent operator-attention surface model (RTS notify strip pills).
 *
 * Distinct from the rising-edge alert queue (SFX + Space cycle): this is the
 * always-on set of blocked / needs-input nodes that must stay visible even when
 * the subject is off-canvas.
 *
 * Kind is always `notifyItem(seatFacts)` — region rollups are a member list
 * and labels, never a severity oracle. Working is not notify.
 *
 * SFX is a separate opt-in product surface; this strip must work with audio off.
 */

import type { RegionRollup } from "@shared/region-rollup";
import {
  notifyItem,
  type SeatFacts,
} from "./seat-projections";

export type OperatorAttentionKind = "blocked" | "attention";

export interface OperatorAttentionItem {
  readonly id: string;
  readonly nodeId: string;
  readonly kind: OperatorAttentionKind;
  readonly label: string;
  readonly reasons: ReadonlyArray<string>;
}

const KIND_RANK: Readonly<Record<OperatorAttentionKind, number>> = {
  blocked: 0,
  attention: 1,
};

export const OPERATOR_ATTENTION_HEADLINE: Readonly<
  Record<OperatorAttentionKind, string>
> = {
  blocked: "BLOCKED — operator resolve",
  attention: "NEEDS OPERATOR INPUT",
};

const putItem = (
  byNode: Map<string, OperatorAttentionItem>,
  item: OperatorAttentionItem,
): void => {
  const prev = byNode.get(item.nodeId);
  if (prev && KIND_RANK[prev.kind] <= KIND_RANK[item.kind]) return;
  byNode.set(item.nodeId, item);
};

const reasonsFromFacts = (
  facts: SeatFacts,
  kind: OperatorAttentionKind,
): ReadonlyArray<string> => {
  if (kind === "blocked") return ["graph:blocked"];
  return [
    ...(facts.seatState === "attention" ? (["activity:attention"] as const) : []),
    ...(facts.attentionReasons ?? []),
  ];
};

/** One notify pill from assembled seat facts, or null when working/idle. */
export const attentionItemFromFacts = (
  facts: SeatFacts,
  label: string,
  blockedReasons?: ReadonlyArray<string>,
): OperatorAttentionItem | null => {
  const kind = notifyItem(facts);
  if (!kind) return null;
  return {
    id: `op-attn:${facts.nodeId}`,
    nodeId: facts.nodeId,
    kind,
    label: label.trim() || facts.nodeId,
    reasons:
      kind === "blocked"
        ? [...(blockedReasons && blockedReasons.length > 0
            ? blockedReasons
            : ["graph:blocked"])]
        : [...reasonsFromFacts(facts, kind)],
  };
};

/**
 * Stable permanent items. Rollups enumerate members and supply labels;
 * kind is `notifyItem` on the caller's facts map. Extra items must already
 * come from `notifyItem` / `attentionItemFromFacts`.
 */
export const collectOperatorAttention = (
  rollups: ReadonlyArray<RegionRollup>,
  factsByNodeId: ReadonlyMap<string, SeatFacts> = new Map(),
  extra: ReadonlyArray<OperatorAttentionItem> = [],
): ReadonlyArray<OperatorAttentionItem> => {
  const byNode = new Map<string, OperatorAttentionItem>();

  for (const item of extra) {
    putItem(byNode, item);
  }

  for (const rollup of rollups) {
    for (const member of rollup.members) {
      if (byNode.has(member.nodeId)) continue;
      const facts = factsByNodeId.get(member.nodeId);
      if (!facts) continue;
      const item = attentionItemFromFacts(
        facts,
        member.label.trim() || member.nodeId,
      );
      if (item) putItem(byNode, item);
    }
  }

  return [...byNode.values()].sort((a, b) => {
    const kr = KIND_RANK[a.kind] - KIND_RANK[b.kind];
    if (kr !== 0) return kr;
    return a.label.localeCompare(b.label);
  });
};

export type CanvasAttentionNode = {
  readonly id: string;
  readonly label: string;
};

/**
 * Canvas-wide notify items from assembled facts. Decision is `notifyItem`
 * only — never rollup severity, never an already-covered skip.
 */
export const freestandingFromCanvasAttention = (
  nodes: ReadonlyArray<CanvasAttentionNode>,
  factsByNodeId: ReadonlyMap<string, SeatFacts>,
  blockedReasonsByNodeId?: ReadonlyMap<string, ReadonlyArray<string>>,
): ReadonlyArray<OperatorAttentionItem> => {
  const out: OperatorAttentionItem[] = [];
  for (const node of nodes) {
    const facts = factsByNodeId.get(node.id);
    if (!facts) continue;
    const item = attentionItemFromFacts(
      facts,
      node.label,
      blockedReasonsByNodeId?.get(node.id),
    );
    if (item) out.push(item);
  }
  return out;
};

/** Cap how many permanent pills show in the notify strip before "+N". */
export const OPERATOR_ATTENTION_STRIP_MAX = 4;
