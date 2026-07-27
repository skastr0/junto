import type {
  Task,
  CanvasDoc,
  CanvasEdge,
  CanvasNode,
  EdgeCriteria,
  EdgePhase,
} from "./canvas";
import { claimedByOf, isTerminalTaskState, taskBrief } from "./task";
import { workerClaimId } from "./attention";
import { seatMayBeBlocked } from "./physics/phase-membership";
import {
  findApproval,
  findMatchingStamp,
  type ApprovalView,
  type ProofStamp,
  type StampView,
} from "./proof-stamps";

// Live execution graph: pure function of (document + live views).
// Derived state is never stored in the authored canvas document.
//
// Authorial edge model — criteria only:
//   - no criteria → soft "relates" (never generates stoppage)
//   - criteria tasks → a CLAIMED attention item (input-required | auth-required)
//     generates blocks on the claimant toNode actor only; unclaimed attention
//     is human inventory, never worker stoppage. Tasks are claimed by the
//     pulling worker; requests are claimed by their raiser at creation.
//   - criteria proof / approval → blocks until trust view clears
//   - retired: glyphs, wip, depends phase, dependency cascade/relay
//
// Propagation (no cascade):
//   - phase "blocks" + generates → mark toNode blocked (actors only)
//   - manual blocker flag marks that actor only (no outbound push)
//   - clear criteria → relates (never "depends")

export type GlyphRow = {
  readonly glyphId: string;
  readonly orbit: string;
  readonly title: string;
  readonly state: string;
};

/** Map project key → glyph rows. Optional; only for legacy callers / watchers. */
export type GlyphView = ReadonlyMap<string, ReadonlyArray<GlyphRow> | undefined>;

/** Optional live views for proof/approval criteria (runtime, not document). */
export type LiveTrustViews = {
  readonly stamps?: StampView;
  readonly approvals?: ApprovalView;
};

export type BlockedReason =
  | {
      readonly kind: "edge";
      readonly edgeId: string;
      readonly fromNodeId: string;
      readonly detail: string;
    }
  | {
      readonly kind: "seed";
      readonly detail: string;
    };

export type EdgeEval = {
  readonly phase: EdgePhase;
  readonly detail: string;
  /** True when this edge generates a block on toNode (phase === blocks). */
  readonly generates: boolean;
};

export type ExecutionGraph = {
  readonly phaseByEdgeId: ReadonlyMap<string, EdgePhase>;
  readonly detailByEdgeId: ReadonlyMap<string, string>;
  readonly edgeEvalById: ReadonlyMap<string, EdgeEval>;
  readonly blocked: ReadonlySet<string>;
  readonly blockedEdgeIds: ReadonlySet<string>;
  readonly reasonsByNodeId: ReadonlyMap<string, ReadonlyArray<BlockedReason>>;
  readonly seedNodeIds: ReadonlySet<string>;
};

const titleOf = (node: CanvasNode | undefined, fallback: string): string => {
  if (!node) return fallback;
  switch (node.type) {
    case "text":
      return (node.text.split("\n")[0] ?? "").trim() || fallback;
    case "file":
      return node.file.split(/[\\/]/).pop() ?? node.file;
    case "link":
      return node.url;
    case "group":
      return node.label ?? node.id;
  }
};

/**
 * Canvas adapter for physics phase membership.
 * Prefer seatMayBeBlocked / roleMayBeBlocked at pure physics call sites.
 */
export const isBlockableNode = (node: CanvasNode | undefined): boolean => {
  if (!node) return false;
  return seatMayBeBlocked({
    isGroup: node.type === "group",
    kind: node.ether?.entity?.kind,
  });
};

/** Kind-strict: only task/requests sinks hold work items. No tolerance reads. */
const workItemsOn = (node: CanvasNode | undefined): ReadonlyArray<Task> => {
  const kind = node?.ether?.entity?.kind;
  if (kind === "requests") return node?.ether?.requests?.items ?? [];
  if (kind === "task") return node?.ether?.tasks?.items ?? [];
  return [];
};

/** Attention states only — open queue (submitted/working) does not stop actors. */
const isAttentionTaskItem = (item: Task): boolean =>
  item.state === "input-required" || item.state === "auth-required";

const softRelates = (detail = "relates"): EdgeEval => ({
  phase: "relates",
  detail,
  generates: false,
});

const evalTasksCriteria = (
  criteria: Extract<EdgeCriteria, { mode: "tasks" }>,
  fromNode: CanvasNode | undefined,
  toNode: CanvasNode | undefined,
): EdgeEval => {
  const fromKind = fromNode?.ether?.entity?.kind;
  const items = workItemsOn(fromNode);
  const scoped =
    criteria.itemIds && criteria.itemIds.length > 0
      ? items.filter((item) => criteria.itemIds!.includes(item.id))
      : items;
  if (scoped.length === 0) {
    return softRelates(fromKind === "requests" ? "no pending requests" : "no open tasks");
  }
  const open = scoped.filter((item) => isAttentionTaskItem(item));
  // Blocking is worker-state for tasks AND requests: only an attention item
  // CLAIMED by this edge's toNode worker stops it. Tasks are claimed by the
  // worker that pulled them; requests are claimed by the actor that raised
  // them. Unclaimed attention is inventory for a human — it stops nobody.
  const held =
    toNode === undefined
      ? []
      : open.filter((item) => claimedByOf(item) === workerClaimId(toNode));
  const noun = fromKind === "requests" ? "pending" : "need input";
  if (held.length === 0) {
    if (open.length > 0) {
      return softRelates(`${open.length} ${noun} · not this worker's wait`);
    }
    return softRelates(
      fromKind === "requests"
        ? `${scoped.length}/${scoped.length} requests resolved`
        : `${scoped.length}/${scoped.length} tasks clear (no attention)`,
    );
  }
  const sample = held
    .slice(0, 3)
    .map((item) => taskBrief(item))
    .join(", ");
  return {
    phase: "blocks",
    detail: `${held.length} ${noun} · ${sample}`,
    generates: true,
  };
};

const evalProofCriteria = (
  criteria: Extract<EdgeCriteria, { mode: "proof" }>,
  fromNode: CanvasNode | undefined,
  stamps: StampView | undefined,
): EdgeEval => {
  const step = criteria.step.trim();
  if (!step) {
    return softRelates("proof criteria missing step");
  }
  const sinkId = fromNode?.id;
  const sinkStamps = sinkId && stamps ? stamps.get(sinkId) : undefined;
  const match = findMatchingStamp(sinkStamps, step, criteria.inputsHash);
  if (match) {
    return softRelates(`proof step "${step}" stamped`);
  }
  const hashHint =
    criteria.inputsHash !== undefined ? ` (inputsHash=${criteria.inputsHash})` : "";
  return {
    phase: "blocks",
    detail: `missing proof step "${step}"${hashHint}`,
    generates: true,
  };
};

const evalApprovalCriteria = (
  criteria: Extract<EdgeCriteria, { mode: "approval" }>,
  approvals: ApprovalView | undefined,
): EdgeEval => {
  const step = criteria.step.trim();
  if (!step) {
    return softRelates("approval criteria missing step");
  }
  const grant = findApproval(approvals, step);
  if (grant && grant.principal === "human") {
    return softRelates(`approval step "${step}" granted`);
  }
  return {
    phase: "blocks",
    detail: `missing human approval for step "${step}"`,
    generates: true,
  };
};

/** Glyph-project collection retired with glyphs/wip criteria — always empty. */
export const edgeGlyphProjects = (_doc: CanvasDoc): ReadonlySet<string> => new Set();

export const evaluateEdge = (
  edge: CanvasEdge,
  fromNode: CanvasNode | undefined,
  toNode: CanvasNode | undefined,
  trust: LiveTrustViews = {},
): EdgeEval => {
  const criteria = edge.ether?.criteria;
  if (!criteria) return softRelates();
  switch (criteria.mode) {
    case "tasks":
      return evalTasksCriteria(criteria, fromNode, toNode);
    case "proof":
      return evalProofCriteria(criteria, fromNode, trust.stamps);
    case "approval":
      return evalApprovalCriteria(criteria, trust.approvals);
  }
};

/**
 * List stamps that currently clear a proof edge (for digest completion).
 * Pure: document + StampView only.
 */
export const clearingStampsForDoc = (
  doc: CanvasDoc,
  stamps: StampView | undefined,
): ReadonlyArray<{ readonly edgeId: string; readonly stamp: ProofStamp }> => {
  if (!stamps) return [];
  const byId = new Map(doc.nodes.map((node) => [node.id, node] as const));
  const out: Array<{ edgeId: string; stamp: ProofStamp }> = [];
  for (const edge of doc.edges) {
    const criteria = edge.ether?.criteria;
    if (!criteria || criteria.mode !== "proof") continue;
    const from = byId.get(edge.fromNode);
    if (!from) continue;
    const match = findMatchingStamp(stamps.get(from.id), criteria.step, criteria.inputsHash);
    if (match) out.push({ edgeId: edge.id, stamp: match });
  }
  return out;
};

export const deriveExecutionGraph = (
  doc: CanvasDoc,
  glyphs: GlyphView = new Map(),
  trust: LiveTrustViews = {},
): ExecutionGraph => {
  const byId = new Map(doc.nodes.map((node) => [node.id, node] as const));

  const phaseByEdgeId = new Map<string, EdgePhase>();
  const detailByEdgeId = new Map<string, string>();
  const edgeEvalById = new Map<string, EdgeEval>();

  for (const edge of doc.edges) {
    const evaluation = evaluateEdge(edge, byId.get(edge.fromNode), byId.get(edge.toNode), trust);
    edgeEvalById.set(edge.id, evaluation);
    phaseByEdgeId.set(edge.id, evaluation.phase);
    detailByEdgeId.set(edge.id, evaluation.detail);
  }

  const blocked = new Set<string>();
  const reasonsByNodeId = new Map<string, BlockedReason[]>();
  const blockedEdgeIds = new Set<string>();
  const seedNodeIds = new Set<string>();

  const addReason = (nodeId: string, reason: BlockedReason): void => {
    const list = reasonsByNodeId.get(nodeId) ?? [];
    list.push(reason);
    reasonsByNodeId.set(nodeId, list);
  };

  const markBlocked = (nodeId: string, reason: BlockedReason, viaEdgeId?: string): void => {
    const node = byId.get(nodeId);
    if (!isBlockableNode(node)) return;
    blocked.add(nodeId);
    addReason(nodeId, reason);
    if (viaEdgeId) blockedEdgeIds.add(viaEdgeId);
  };

  // Manual blocker flag: self only (no outbound cascade).
  for (const node of doc.nodes) {
    if (node.ether?.flags?.includes("blocker") && isBlockableNode(node)) {
      seedNodeIds.add(node.id);
      markBlocked(node.id, { kind: "seed", detail: `blocker flag on ${titleOf(node, node.id)}` });
    }
  }

  // Generating edges only — no relay through other edges.
  for (const edge of doc.edges) {
    const evaluation = edgeEvalById.get(edge.id)!;
    if (!evaluation.generates) continue;
    markBlocked(
      edge.toNode,
      {
        kind: "edge",
        edgeId: edge.id,
        fromNodeId: edge.fromNode,
        detail: evaluation.detail,
      },
      edge.id,
    );
  }

  return {
    phaseByEdgeId,
    detailByEdgeId,
    edgeEvalById,
    blocked,
    blockedEdgeIds,
    reasonsByNodeId,
    seedNodeIds,
  };
};

/** Human-readable region execution context for agent pulses. Deterministic. */
export const composeRegionExecutionContext = (
  doc: CanvasDoc,
  _regionId: string,
  graph: ExecutionGraph,
  memberIds: ReadonlyArray<string>,
): string => {
  const byId = new Map(doc.nodes.map((node) => [node.id, node] as const));
  const memberSet = new Set(memberIds);
  const lines: string[] = ["execution"];

  const memberTitles = memberIds.map((id) => titleOf(byId.get(id), id));
  lines.push(`members :: ${memberTitles.join(", ") || "(none)"}`);

  const edgeLines: string[] = [];
  for (const edge of doc.edges) {
    if (!memberSet.has(edge.fromNode) && !memberSet.has(edge.toNode)) continue;
    const phase = graph.phaseByEdgeId.get(edge.id) ?? "relates";
    const detail = graph.detailByEdgeId.get(edge.id) ?? "";
    const from = titleOf(byId.get(edge.fromNode), edge.fromNode);
    const to = titleOf(byId.get(edge.toNode), edge.toNode);
    edgeLines.push(
      detail && phase !== "relates"
        ? `${from} --${phase}(${detail})--> ${to}`
        : `${from} --${phase}--> ${to}`,
    );
  }
  if (edgeLines.length > 0) {
    lines.push("edges");
    lines.push(...edgeLines);
  }

  const blockedMembers = memberIds.filter((id) => graph.blocked.has(id));
  if (blockedMembers.length > 0) {
    lines.push("blocked");
    for (const id of blockedMembers) {
      const reasons = graph.reasonsByNodeId.get(id) ?? [];
      const reasonText = reasons
        .slice(0, 3)
        .map((reason) => {
          if (reason.kind === "edge") return reason.detail;
          return reason.detail;
        })
        .join("; ");
      lines.push(
        reasonText
          ? `${titleOf(byId.get(id), id)} :: ${reasonText}`
          : titleOf(byId.get(id), id),
      );
    }
  }

  const taskLines: string[] = [];
  for (const id of memberIds) {
    const node = byId.get(id);
    const kind = node?.ether?.entity?.kind;
    if (!node || (kind !== "task" && kind !== "requests")) continue;
    const items =
      kind === "requests" ? (node.ether?.requests?.items ?? []) : (node.ether?.tasks?.items ?? []);
    if (items.length === 0) {
      taskLines.push(`${titleOf(node, id)} :: (empty)`);
      continue;
    }
    if (kind === "requests") {
      const pending = items.filter((item) => item.state === "input-required").length;
      const preview = items.map((item) => `${item.state}: ${taskBrief(item)}`).join("; ");
      taskLines.push(`${titleOf(node, id)} :: ${pending}/${items.length} pending · ${preview}`);
    } else {
      const open = items.filter((item) => !isTerminalTaskState(item.state)).length;
      const preview = items
        .map((item) => `${isTerminalTaskState(item.state) ? "[x]" : "[ ]"} ${taskBrief(item)}`)
        .join("; ");
      taskLines.push(
        `${titleOf(node, id)} :: ${items.length - open}/${items.length} settled · ${preview}`,
      );
    }
  }
  if (taskLines.length > 0) {
    lines.push("tasks");
    lines.push(...taskLines);
  }

  return lines.join("\n");
};
