/**
 * Permanent operator-attention surface model (RTS notify strip pills).
 *
 * Distinct from the rising-edge alert queue (SFX + Space cycle): this is the
 * always-on set of blocked / needs-input nodes that must stay visible even when
 * the subject is off-canvas. Collect from region rollups + freestanding seats;
 * worst severity wins.
 */

import type { MemberSeverity, RegionRollup } from "@shared/region-rollup";

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

const severityToKind = (severity: MemberSeverity): OperatorAttentionKind | null => {
  if (severity === "blocked") return "blocked";
  if (severity === "attention") return "attention";
  return null;
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

/**
 * Stable permanent items from live region rollups (+ optional freestanding).
 * Dedupes overlapping membership by worst severity, then label.
 *
 * `freestanding` covers seats not inside any region (same severity grammar).
 */
export const collectOperatorAttention = (
  rollups: ReadonlyArray<RegionRollup>,
  freestanding: ReadonlyArray<OperatorAttentionItem> = [],
): ReadonlyArray<OperatorAttentionItem> => {
  const byNode = new Map<string, OperatorAttentionItem>();

  for (const rollup of rollups) {
    for (const member of rollup.members) {
      const kind = severityToKind(member.severity);
      if (!kind) continue;
      putItem(byNode, {
        id: `op-attn:${member.nodeId}`,
        nodeId: member.nodeId,
        kind,
        label: member.label.trim() || member.nodeId,
        reasons: member.reasons,
      });
    }
  }

  for (const item of freestanding) {
    putItem(byNode, item);
  }

  return [...byNode.values()].sort((a, b) => {
    const kr = KIND_RANK[a.kind] - KIND_RANK[b.kind];
    if (kr !== 0) return kr;
    return a.label.localeCompare(b.label);
  });
};

/** Build freestanding items from harness activity keyed by canvas node id. */
export const freestandingFromTerminalStatus = (
  nodes: ReadonlyArray<{ readonly id: string; readonly label: string }>,
  terminalStatusByNodeId: ReadonlyMap<
    string,
    { readonly harness?: string | null | undefined }
  >,
  alreadyCovered: ReadonlySet<string> = new Set(),
): ReadonlyArray<OperatorAttentionItem> => {
  const out: OperatorAttentionItem[] = [];
  for (const node of nodes) {
    if (alreadyCovered.has(node.id)) continue;
    const harness = terminalStatusByNodeId.get(node.id)?.harness;
    if (harness !== "attention" && harness !== "blocked") continue;
    out.push({
      id: `op-attn:${node.id}`,
      nodeId: node.id,
      kind: harness,
      label: node.label.trim() || node.id,
      reasons: [`activity:${harness}`],
    });
  }
  return out;
};

/** Cap how many permanent pills show in the notify strip before "+N". */
export const OPERATOR_ATTENTION_STRIP_MAX = 4;
