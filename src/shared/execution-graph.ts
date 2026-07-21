import type {
  A2ATask,
  CanvasDoc,
  CanvasEdge,
  CanvasNode,
  EdgeCriteria,
  EdgePhase,
} from "./canvas";
import { WIP_GLYPH_STATES } from "./canvas";
import { taskBrief } from "./a2a";

// Live execution graph: pure function of (document + glyph view).
// Derived state is never stored in the .canvas file.
//
// Authorial edge model — criteria only:
//   - no criteria → soft "relates" (never generates, never relays)
//   - criteria glyphs/wip → "blocks" | "depends" when glyph data known;
//     unknown/missing glyph data → "relates" (no fail-closed generation)
//   - criteria tasks → from document A2A tasks/requests stores only
//
// Propagation:
//   - phase "blocks" generates a block on toNode
//   - a blocked (or manual-blocker) node relays through outbound blocks|depends
//   - "relates" never generates and never relays
//   - notes and agents are never members of the blocked set

export type GlyphRow = {
  readonly glyphId: string;
  readonly orbit: string;
  readonly title: string;
  readonly state: string;
};

/** Map project key → glyph rows. Missing key or undefined value = data unavailable. */
export type GlyphView = ReadonlyMap<string, ReadonlyArray<GlyphRow> | undefined>;

export type BlockedReason =
  | {
      readonly kind: "edge";
      readonly edgeId: string;
      readonly fromNodeId: string;
      readonly detail: string;
    }
  | {
      readonly kind: "relay";
      readonly viaNodeId: string;
      readonly edgeId: string;
    }
  | {
      readonly kind: "seed";
      readonly detail: string;
    };

export type EdgeEval = {
  readonly phase: EdgePhase;
  readonly detail: string;
  /** True when this edge can generate a block (phase === blocks with known criteria or pin). */
  readonly generates: boolean;
  /** True when this edge participates in relay (phase is blocks or depends). */
  readonly relays: boolean;
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

const WIP_SET = new Set<string>(WIP_GLYPH_STATES);

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

export const isBlockableNode = (node: CanvasNode | undefined): boolean => {
  if (!node) return false;
  if (node.type === "group") return false;
  const kind = node.ether?.entity?.kind;
  // herdr/page are work surfaces (PTY / browser), not primary execution-graph actors.
  if (
    kind === "agent" ||
    kind === "watcher" ||
    kind === "timer" ||
    kind === "herdr" ||
    kind === "page"
  )
    return false;
  // Free notes (text without entity) are not blockable.
  if (node.type === "text" && kind === undefined) return false;
  return true;
};

// The node's identity name IS the tower project key when tower knows the
// project (tower keys are the canonical project names). Edge criteria that
// need a different key carry an explicit criteria.project.
export const towerProjectKey = (node: CanvasNode | undefined): string | undefined => {
  const entity = node?.ether?.entity;
  if (!entity?.name || entity.kind === "agent") return undefined;
  return entity.name;
};

const filterOrbit = (rows: ReadonlyArray<GlyphRow>, orbit: string | undefined): ReadonlyArray<GlyphRow> =>
  orbit ? rows.filter((row) => row.orbit === orbit) : rows;

const evalGlyphsCriteria = (
  criteria: Extract<EdgeCriteria, { mode: "glyphs" }>,
  fromNode: CanvasNode | undefined,
  glyphs: GlyphView,
): EdgeEval => {
  const project = criteria.project ?? towerProjectKey(fromNode);
  if (!project) {
    return { phase: "relates", detail: "no project for glyph criteria", generates: false, relays: false };
  }
  if (criteria.glyphIds.length === 0) {
    return { phase: "relates", detail: "no glyphs selected", generates: false, relays: false };
  }
  if (!glyphs.has(project)) {
    return { phase: "relates", detail: "glyph data unavailable", generates: false, relays: false };
  }
  const rows = glyphs.get(project);
  if (rows === undefined) {
    return { phase: "relates", detail: "glyph data unavailable", generates: false, relays: false };
  }
  const scoped = filterOrbit(rows, criteria.orbit);
  const byId = new Map(scoped.map((row) => [row.glyphId, row] as const));
  const pending: string[] = [];
  let missing = 0;
  for (const id of criteria.glyphIds) {
    const row = byId.get(id);
    if (!row) {
      missing += 1;
      pending.push(id);
      continue;
    }
    if (row.state !== "done") pending.push(`${row.glyphId}(${row.state})`);
  }
  // Missing glyph ids count as unsatisfied only when we have a complete index
  // for the project — a typo stays pending, never vacuous depends.
  if (pending.length === 0) {
    return {
      phase: "depends",
      detail: `${criteria.glyphIds.length}/${criteria.glyphIds.length} glyphs done`,
      generates: false,
      relays: true,
    };
  }
  const detail =
    missing > 0
      ? `${criteria.glyphIds.length - pending.length}/${criteria.glyphIds.length} done (${missing} missing)`
      : `${criteria.glyphIds.length - pending.length}/${criteria.glyphIds.length} done · pending: ${pending.slice(0, 4).join(", ")}`;
  return { phase: "blocks", detail, generates: true, relays: true };
};

const evalWipCriteria = (
  criteria: Extract<EdgeCriteria, { mode: "wip" }>,
  fromNode: CanvasNode | undefined,
  glyphs: GlyphView,
): EdgeEval => {
  const project = criteria.project ?? towerProjectKey(fromNode);
  if (!project) {
    return { phase: "relates", detail: "no project for wip criteria", generates: false, relays: false };
  }
  if (!glyphs.has(project)) {
    return { phase: "relates", detail: "glyph data unavailable", generates: false, relays: false };
  }
  const rows = glyphs.get(project);
  if (rows === undefined) {
    return { phase: "relates", detail: "glyph data unavailable", generates: false, relays: false };
  }
  const scoped = filterOrbit(rows, criteria.orbit);
  const hot = scoped.filter((row) => WIP_SET.has(row.state));
  if (hot.length === 0) {
    return {
      phase: "depends",
      detail: "no glyphs in committed|building|reviewing",
      generates: false,
      relays: true,
    };
  }
  const sample = hot
    .slice(0, 4)
    .map((row) => `${row.glyphId}(${row.state})`)
    .join(", ");
  return {
    phase: "blocks",
    detail: `${hot.length} wip · ${sample}`,
    generates: true,
    relays: true,
  };
};

const a2aItemsOn = (node: CanvasNode | undefined): ReadonlyArray<A2ATask> => {
  if (!node) return [];
  const kind = node.ether?.entity?.kind;
  if (kind === "requests") return node.ether?.requests?.items ?? [];
  if (kind === "task") return node.ether?.tasks?.items ?? [];
  // Fallback: prefer tasks store if present (criteria mode is document-local).
  return node.ether?.tasks?.items ?? node.ether?.requests?.items ?? [];
};

const isBlockingTaskItem = (item: A2ATask, fromKind: string | undefined): boolean => {
  if (fromKind === "requests") return item.state === "input-required";
  // task nodes (and default): block while not completed
  return item.state !== "completed";
};

const evalTasksCriteria = (
  criteria: Extract<EdgeCriteria, { mode: "tasks" }>,
  fromNode: CanvasNode | undefined,
): EdgeEval => {
  const fromKind = fromNode?.ether?.entity?.kind;
  const items = a2aItemsOn(fromNode);
  const scoped =
    criteria.itemIds && criteria.itemIds.length > 0
      ? items.filter((item) => criteria.itemIds!.includes(item.id))
      : items;
  if (scoped.length === 0) {
    // Empty list with an explicit tasks edge = satisfied pathway.
    return {
      phase: "depends",
      detail: fromKind === "requests" ? "no pending requests" : "no open tasks",
      generates: false,
      relays: true,
    };
  }
  const open = scoped.filter((item) => isBlockingTaskItem(item, fromKind));
  if (open.length === 0) {
    return {
      phase: "depends",
      detail:
        fromKind === "requests"
          ? `${scoped.length}/${scoped.length} requests resolved`
          : `${scoped.length}/${scoped.length} tasks completed`,
      generates: false,
      relays: true,
    };
  }
  const sample = open
    .slice(0, 3)
    .map((item) => taskBrief(item))
    .join(", ");
  if (fromKind === "requests") {
    return {
      phase: "blocks",
      detail: `${scoped.length - open.length}/${scoped.length} requests resolved · pending: ${sample}`,
      generates: true,
      relays: true,
    };
  }
  return {
    phase: "blocks",
    detail: `${scoped.length - open.length}/${scoped.length} tasks completed · open: ${sample}`,
    generates: true,
    relays: true,
  };
};

const softRelates = (): EdgeEval => ({
  phase: "relates",
  detail: "relates",
  generates: false,
  relays: false,
});

export const evaluateEdge = (
  edge: CanvasEdge,
  fromNode: CanvasNode | undefined,
  glyphs: GlyphView,
): EdgeEval => {
  const criteria = edge.ether?.criteria;
  if (!criteria) return softRelates();
  switch (criteria.mode) {
    case "glyphs":
      return evalGlyphsCriteria(criteria, fromNode, glyphs);
    case "wip":
      return evalWipCriteria(criteria, fromNode, glyphs);
    case "tasks":
      return evalTasksCriteria(criteria, fromNode);
  }
};

/** Collect project keys that must be present in the glyph view for edge criteria. */
export const edgeGlyphProjects = (doc: CanvasDoc): ReadonlySet<string> => {
  const projects = new Set<string>();
  const byId = new Map(doc.nodes.map((node) => [node.id, node] as const));
  for (const edge of doc.edges) {
    const criteria = edge.ether?.criteria;
    if (!criteria || criteria.mode === "tasks") continue;
    const from = byId.get(edge.fromNode);
    const project = criteria.project ?? towerProjectKey(from);
    if (project) projects.add(project);
  }
  return projects;
};

export const deriveExecutionGraph = (doc: CanvasDoc, glyphs: GlyphView = new Map()): ExecutionGraph => {
  const byId = new Map(doc.nodes.map((node) => [node.id, node] as const));

  const phaseByEdgeId = new Map<string, EdgePhase>();
  const detailByEdgeId = new Map<string, string>();
  const edgeEvalById = new Map<string, EdgeEval>();

  for (const edge of doc.edges) {
    const evaluation = evaluateEdge(edge, byId.get(edge.fromNode), glyphs);
    edgeEvalById.set(edge.id, evaluation);
    phaseByEdgeId.set(edge.id, evaluation.phase);
    detailByEdgeId.set(edge.id, evaluation.detail);
  }

  // Outbound adjacency for relay: only edges that can relay.
  const outboundRelay = new Map<string, Array<{ edgeId: string; toNode: string }>>();
  for (const edge of doc.edges) {
    const evaluation = edgeEvalById.get(edge.id)!;
    if (!evaluation.relays) continue;
    const list = outboundRelay.get(edge.fromNode) ?? [];
    list.push({ edgeId: edge.id, toNode: edge.toNode });
    outboundRelay.set(edge.fromNode, list);
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
    const wasBlocked = blocked.has(nodeId);
    blocked.add(nodeId);
    if (!wasBlocked) addReason(nodeId, reason);
    else addReason(nodeId, reason);
    if (viaEdgeId) blockedEdgeIds.add(viaEdgeId);
  };

  // Manual blocker flags are seeds (generate via their outbound relay edges).
  for (const node of doc.nodes) {
    if (node.ether?.flags?.includes("blocker") && isBlockableNode(node)) {
      seedNodeIds.add(node.id);
    }
  }

  // Generating edges (phase blocks).
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

  // Seed: manual blockers push through outbound relay edges.
  const queue: string[] = [];
  for (const seedId of seedNodeIds) {
    queue.push(seedId);
    for (const hop of outboundRelay.get(seedId) ?? []) {
      markBlocked(
        hop.toNode,
        { kind: "seed", detail: `from blocker ${titleOf(byId.get(seedId), seedId)}` },
        hop.edgeId,
      );
      queue.push(hop.toNode);
    }
  }

  // Also enqueue every currently blocked node for relay expansion.
  for (const id of blocked) queue.push(id);

  // Relay: blocked nodes retransmit through outbound blocks|depends.
  const seenRelay = new Set<string>();
  while (queue.length > 0) {
    const current = queue.pop()!;
    if (seenRelay.has(current)) continue;
    // Seeds that are not themselves blocked still relay; blocked nodes always relay.
    if (!blocked.has(current) && !seedNodeIds.has(current)) continue;
    seenRelay.add(current);
    for (const hop of outboundRelay.get(current) ?? []) {
      if (blocked.has(hop.toNode)) {
        // Still mark edge as active in the closure.
        blockedEdgeIds.add(hop.edgeId);
        continue;
      }
      const before = blocked.size;
      markBlocked(
        hop.toNode,
        { kind: "relay", viaNodeId: current, edgeId: hop.edgeId },
        hop.edgeId,
      );
      if (blocked.size > before) queue.push(hop.toNode);
    }
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
  regionId: string,
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
          if (reason.kind === "relay") return `relay via ${titleOf(byId.get(reason.viaNodeId), reason.viaNodeId)}`;
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

  // Task / request lists in the region (even when not edged).
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
      const open = items.filter((item) => item.state !== "completed").length;
      const preview = items
        .map((item) => `${item.state === "completed" ? "[x]" : "[ ]"} ${taskBrief(item)}`)
        .join("; ");
      taskLines.push(
        `${titleOf(node, id)} :: ${items.length - open}/${items.length} completed · ${preview}`,
      );
    }
  }
  if (taskLines.length > 0) {
    lines.push("tasks");
    lines.push(...taskLines);
  }

  return lines.join("\n");
};
