import type {
  Task,
  CanvasDoc,
  CanvasEdge,
  CanvasNode,
  EdgePhase,
} from "./canvas";
import type { ActorSeatId } from "./actor-seat";
import { claimedByOf, isTerminalTaskState, taskBrief } from "./task";
import { dependencyScopeIndex } from "./task-dep-scope";
import { taskDepStatus } from "./task-deps";
import {
  resolveCompiledActorRef,
  type ActorRefResolver,
} from "./attention";
import { seatMayBeBlocked } from "./physics/phase-membership";
import {
  type ApprovalView,
  type ProofStamp,
  type StampView,
} from "./proof-stamps";

// Live execution graph: pure function of (document + live views).
// Derived state is never stored in the authored canvas document.
//
// Stoppage model (derived, never authored — the edge states a relationship,
// not a gate):
//   - an edge with either end task|requests → evaluate tasks stoppage:
//     a CLAIMED attention item (input-required; residual auth-required)
//     generates blocks on the claimant actor only. Tasks are claimed by the
//     pulling actor; requests are claimed by their raiser at creation.
//     An unresolved actor identity never substitutes its canvas node ID.
//   - every other pair → soft "relates" (capability only; never stoppage)
//
// Evaluation:
//   - phase "blocks" + generates → mark actor blocked (actors only)
//   - manual blocker flag marks that actor only
//   - work-plane seat blocks mark their actor only
//   - stoppage never cascades via edge property — use a relay node + wires

/** Optional live trust views (legacy stamp/approval surfaces; not product gates). */
export type LiveTrustViews = {
  readonly stamps?: StampView;
  readonly approvals?: ApprovalView;
};

/** Complete pure inputs required to attribute canvas-local actor references. */
export type ExecutionGraphContext = LiveTrustViews & {
  readonly canvasName: string;
  readonly resolveActorRef: ActorRefResolver;
  /** Live work-plane stoppage keyed by the blocked actor node. */
  readonly workBlockedSeats?: ReadonlyMap<string, WorkBlockedSeat>;
};

export type WorkBlockedSeat = {
  readonly requestId: string;
  readonly targetNodeId: string;
  readonly detail: string;
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
    }
  | {
      readonly kind: "work";
      readonly requestId: string;
      readonly targetNodeId: string;
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

const evalTasksStoppage = (
  fromNode: CanvasNode | undefined,
  toActorSeatId: ActorSeatId | undefined,
): EdgeEval => {
  const fromKind = fromNode?.ether?.entity?.kind;
  const scoped = workItemsOn(fromNode);
  if (scoped.length === 0) {
    return softRelates(fromKind === "requests" ? "no pending requests" : "no open tasks");
  }
  const open = scoped.filter((item) => isAttentionTaskItem(item));
  // Blocking is actor-state for tasks AND requests: only an attention item
  // claimed by this edge's compiled actor seat stops it.
  const held =
    toActorSeatId === undefined
      ? []
      : open.filter((item) => claimedByOf(item) === toActorSeatId);
  const noun = fromKind === "requests" ? "pending" : "need input";
  if (held.length === 0) {
    if (open.length > 0) {
      return softRelates(
        toActorSeatId === undefined
          ? `${open.length} ${noun} - actor identity unresolved`
          : `${open.length} ${noun} - not this actor's wait`,
      );
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
    detail: `${held.length} ${noun} - ${sample}`,
    generates: true,
  };
};

/** Work sink endpoint for tasks stops — either end may hold the sink. */
const workSinkOf = (
  fromNode: CanvasNode | undefined,
  toNode: CanvasNode | undefined,
): CanvasNode | undefined => {
  if (workItemsOn(fromNode).length > 0 || isWorkSinkKind(fromNode)) return fromNode;
  if (workItemsOn(toNode).length > 0 || isWorkSinkKind(toNode)) return toNode;
  return fromNode;
};

const isWorkSinkKind = (node: CanvasNode | undefined): boolean => {
  const kind = node?.ether?.entity?.kind;
  return kind === "task" || kind === "requests";
};

/** Actor seat endpoint for stoppage — either end may be the seat. */
export const stoppageActorOf = (
  fromNode: CanvasNode | undefined,
  toNode: CanvasNode | undefined,
): CanvasNode | undefined => {
  if (isBlockableNode(toNode)) return toNode;
  if (isBlockableNode(fromNode)) return fromNode;
  return toNode;
};

export const evaluateEdge = (
  _edge: CanvasEdge,
  fromNode: CanvasNode | undefined,
  toNode: CanvasNode | undefined,
  context: ExecutionGraphContext,
): EdgeEval => {
  // Work-lane stoppage is derived from the endpoints (task|requests) and live
  // work state. The edge itself carries nothing to read.
  if (!isWorkSinkKind(fromNode) && !isWorkSinkKind(toNode)) {
    return softRelates();
  }
  const sink = workSinkOf(fromNode, toNode);
  const actor = stoppageActorOf(fromNode, toNode);
  return evalTasksStoppage(
    sink,
    resolveCompiledActorRef(
      context.resolveActorRef,
      context.canvasName,
      actor,
    )?.seatId,
  );
};

/**
 * Proof edges are retired. Kept as a no-op export for digest callers.
 */
export const clearingStampsForDoc = (
  _doc: CanvasDoc,
  _stamps: StampView | undefined,
): ReadonlyArray<{ readonly edgeId: string; readonly stamp: ProofStamp }> => [];

export const deriveExecutionGraph = (
  doc: CanvasDoc,
  context: ExecutionGraphContext,
): ExecutionGraph => {
  const byId = new Map(doc.nodes.map((node) => [node.id, node] as const));

  const phaseByEdgeId = new Map<string, EdgePhase>();
  const detailByEdgeId = new Map<string, string>();
  const edgeEvalById = new Map<string, EdgeEval>();

  for (const edge of doc.edges) {
    const evaluation = evaluateEdge(
      edge,
      byId.get(edge.fromNode),
      byId.get(edge.toNode),
      context,
    );
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

  // Escalation is runtime stoppage on its exact raiser. The actor→requests
  // edge grants the operation; visual stoppage does not synthesize a reverse
  // authorial edge.
  for (const [nodeId, block] of context.workBlockedSeats ?? []) {
    markBlocked(nodeId, {
      kind: "work",
      requestId: block.requestId,
      targetNodeId: block.targetNodeId,
      detail: block.detail,
    });
  }

  // Generating edges only — no automatic relay through other edges.
  // Stoppage lands on the actor seat (either end), not always toNode.
  for (const edge of doc.edges) {
    const evaluation = edgeEvalById.get(edge.id)!;
    if (!evaluation.generates) continue;
    const from = byId.get(edge.fromNode);
    const to = byId.get(edge.toNode);
    const actor = stoppageActorOf(from, to);
    const actorId = actor?.id ?? edge.toNode;
    markBlocked(
      actorId,
      {
        kind: "edge",
        edgeId: edge.id,
        // The generator is the work sink, whichever end holds it: an edge is
        // stored in its verb's own order (agent-first for agent→sink access),
        // so `fromNode` is not the cause.
        fromNodeId: workSinkOf(from, to)?.id ?? edge.fromNode,
        detail: evaluation.detail,
      },
      edge.id,
    );
  }

  // Wires law: no hidden stoppage cascades. Propagation requires an explicit
  // relay node + does wires.

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
      taskLines.push(`${titleOf(node, id)} :: ${pending}/${items.length} pending - ${preview}`);
    } else {
      const open = items.filter((item) => !isTerminalTaskState(item.state)).length;
      const depById = dependencyScopeIndex(doc, id);
      const preview = items
        .map((item) => {
          const mark = isTerminalTaskState(item.state) ? "[x]" : "[ ]";
          const brief = taskBrief(item);
          if (item.state !== "submitted" || claimedByOf(item)) {
            return `${mark} ${brief}`;
          }
          const dep = taskDepStatus(item, depById);
          if (dep.kind === "ready") return `${mark} ${brief}`;
          if (dep.kind === "waiting") {
            return `${mark} ${brief} (waiting: ${dep.frontier.join(",")})`;
          }
          if (dep.kind === "blocked") {
            return `${mark} ${brief} (blocked: ${dep.roots.join(",")})`;
          }
          return `${mark} ${brief} (orphan: ${dep.missing.join(",")})`;
        })
        .join("; ");
      taskLines.push(
        `${titleOf(node, id)} :: ${items.length - open}/${items.length} settled - ${preview}`,
      );
    }
  }
  if (taskLines.length > 0) {
    lines.push("tasks");
    lines.push(...taskLines);
  }

  return lines.join("\n");
};
