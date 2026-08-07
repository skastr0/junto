/**
 * Permanent operator-attention surface model (RTS notify strip pills).
 *
 * Distinct from the rising-edge alert queue (SFX + Space cycle): this is the
 * always-on set of blocked / needs-input nodes that must stay visible even when
 * the subject is off-canvas.
 *
 * Sources (worst severity wins per node):
 *  1. region rollups (members inside groups)
 *  2. freestanding canvas signals — graph-blocked seats, harness attention/
 *     blocked, and explicit `flag:attention` — including nodes **outside every
 *     region** (region rollups alone miss those)
 *
 * SFX is a separate opt-in product surface; this strip must work with audio off.
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

export type CanvasAttentionNode = {
  readonly id: string;
  readonly label: string;
  /** Authorial flags (e.g. attention, blocker). */
  readonly flags?: ReadonlyArray<string>;
};

/**
 * Canvas-wide freestanding attention for the notify strip.
 *
 * Region rollups only enumerate group members — operators still need pills for
 * graph-blocked / needs-input seats that sit outside every region (or when live
 * IPC rollups lag). Graph blocked > harness blocked > harness/flag attention.
 */
export const freestandingFromCanvasAttention = (
  nodes: ReadonlyArray<CanvasAttentionNode>,
  input: {
    readonly blockedNodeIds: ReadonlySet<string>;
    /** Optional short reasons keyed by node id (first reason wins for chrome). */
    readonly blockedReasonsByNodeId?: ReadonlyMap<
      string,
      ReadonlyArray<string>
    >;
    readonly terminalStatusByNodeId?: ReadonlyMap<
      string,
      { readonly harness?: string | null | undefined }
    >;
    readonly alreadyCovered?: ReadonlySet<string>;
  },
): ReadonlyArray<OperatorAttentionItem> => {
  const covered = input.alreadyCovered ?? new Set<string>();
  const terminal = input.terminalStatusByNodeId;
  const out: OperatorAttentionItem[] = [];

  for (const node of nodes) {
    if (covered.has(node.id)) continue;
    const label = node.label.trim() || node.id;
    const harness = terminal?.get(node.id)?.harness;
    const graphBlocked = input.blockedNodeIds.has(node.id);
    const harnessBlocked = harness === "blocked";
    const harnessAttention = harness === "attention";
    const flagAttention = node.flags?.includes("attention") === true;

    if (graphBlocked || harnessBlocked) {
      const reasons =
        input.blockedReasonsByNodeId?.get(node.id) ??
        (harnessBlocked ? ["activity:blocked"] : ["graph:blocked"]);
      out.push({
        id: `op-attn:${node.id}`,
        nodeId: node.id,
        kind: "blocked",
        label,
        reasons: [...reasons],
      });
      continue;
    }

    if (harnessAttention || flagAttention) {
      out.push({
        id: `op-attn:${node.id}`,
        nodeId: node.id,
        kind: "attention",
        label,
        reasons: [
          ...(harnessAttention ? (["activity:attention"] as const) : []),
          ...(flagAttention ? (["flag:attention"] as const) : []),
        ],
      });
    }
  }

  return out;
};

/** Cap how many permanent pills show in the notify strip before "+N". */
export const OPERATOR_ATTENTION_STRIP_MAX = 4;
