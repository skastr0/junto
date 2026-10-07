import { ulid } from "ulid";
import type { CanvasDoc, CanvasEdge, CanvasNode } from "@shared/canvas";
import { defaultVerbForPair, verbsForPair, type Verb } from "@shared/physics";
import { productNodeKindEnabled, productVerbEnabled } from "@shared/features";
import { validateFlowDag, type FlowCycleError } from "@shared/flow-graph";
import { wiresFromDocument } from "@shared/model/from-document";
import { isGitNode, isLabelNode, nodeTitle } from "./presentation";
import { flowEdgeRemovalWarnings, readDeletionPolicy } from "./deletion-impact";
import { removeEdgesFromSelection, selectEdge, state$ } from "./state";
import { commitCommands, commitDoc, parseSide } from "./mutations";
import { connected, type Connected } from "./model-edits";
import { roleOfKind } from "./model-kind";
import { asNodeId, type Canvas } from "@shared/model";
import { titleOf } from "@shared/model/title";

/**
 * Edge authoring — drawing the wire is the whole act.
 *
 * An edge states one verb and nothing else. The pair of endpoint kinds decides
 * which verbs are legal; where two are, the operator picks by dropping on one
 * of the card's landing zones, and every other connect path takes the pair's
 * default. Ports, watch predicates, fire actions, and the task path hop are
 * compiled from the verb (`physics/verbs.ts`), never stored beside it.
 */

/** Authored kind, or nothing for a region — geography holds no verb. */
const kindOf = (node: CanvasNode | undefined): string | undefined =>
  node === undefined || node.type === "group"
    ? undefined
    : node.ether?.entity?.kind;

export type DrawVerbs = {
  /** Verbs the pair admits, in table order. Empty means connect is refused. */
  readonly verbs: ReadonlyArray<Verb>;
  /** True when the verb's source end is the card the wire was drawn *to*. */
  readonly reversed: boolean;
};

const NO_DRAW_VERBS: DrawVerbs = { verbs: [], reversed: false };

/**
 * The verbs a drawn wire may carry. Drawn order wins wherever the grammar
 * admits it; otherwise the reverse is tried and the edge is stored the other
 * way round. Dragging a pad onto a seat means the same relationship as
 * dragging the seat onto the pad — only the storage order is fixed, because a
 * verb reads in one direction.
 */
export const verbsForDraw = (
  fromKind: string | undefined,
  toKind: string | undefined,
): DrawVerbs => {
  // A feature-gated kind turned off in this build keeps its historical edges
  // but takes no new wire: the decoder still admits the stored verb, the
  // authoring surface never draws one.
  if (
    (fromKind !== undefined && !productNodeKindEnabled(fromKind)) ||
    (toKind !== undefined && !productNodeKindEnabled(toKind))
  ) {
    return NO_DRAW_VERBS;
  }
  // A gated verb leaves the offer, so two seats with reviews off hold one
  // verb, show no landing zones, and connect as messages.
  const drawn = verbsForPair(fromKind, toKind).filter(productVerbEnabled);
  if (drawn.length > 0) return { verbs: drawn, reversed: false };
  const flipped = verbsForPair(toKind, fromKind).filter(productVerbEnabled);
  return flipped.length > 0 ? { verbs: flipped, reversed: true } : NO_DRAW_VERBS;
};

/** Cards that take no wire whatever their kinds say. */
const wireableNode = (node: CanvasNode | undefined): boolean =>
  node !== undefined &&
  node.type !== "group" &&
  !isLabelNode(node) &&
  !isGitNode(node) &&
  productNodeKindEnabled(kindOf(node));

/** Live connect validation — the same grammar the commit below enforces. */
export const connectAllowed = (
  fromNode: CanvasNode | undefined,
  toNode: CanvasNode | undefined,
): boolean =>
  wireableNode(fromNode) &&
  wireableNode(toNode) &&
  verbsForDraw(kindOf(fromNode), kindOf(toNode)).verbs.length > 0;

const VERB_HANDLE_PREFIX = "verb:";

/** Handle id a landing zone carries. Never parses as a node side. */
export const verbHandleId = (verb: Verb): string =>
  `${VERB_HANDLE_PREFIX}${verb}`;

/**
 * Translate a raw FlowCycleError (board ids) into a titled, readable line.
 * One wording for one rejection: the connect-time refusal below and the batch
 * connect both speak it.
 */
export const friendlyCycleMessage = (error: FlowCycleError, doc: CanvasDoc): string => {
  const titleOf = (id: string): string => {
    const node = doc.nodes.find((candidate) => candidate.id === id);
    return node ? nodeTitle(node) : "that board";
  };
  const names = error.cycle.map(titleOf);
  const loop = names.length > 0 ? `${names.join(" → ")} → ${names[0]}` : "a loop";
  return `That direction would send tasks in a loop — ${loop}. Pick the other direction or a different Next board.`;
};

export const deleteEdges = async (ids: ReadonlyArray<string>): Promise<void> => {
  const removed = new Set(ids);
  if (removed.size === 0) return;
  const doc = state$.doc.peek();
  const existingEdges = doc.edges.filter((edge) => removed.has(edge.id));
  if (existingEdges.length === 0) return;
  const label = existingEdges.length === 1 ? "this relation" : `${existingEdges.length} relations`;
  const pendingPolicy = readDeletionPolicy(state$.canvasName.peek(), doc, new Set(), existingEdges);
  const policy = pendingPolicy instanceof Promise ? await pendingPolicy : pendingPolicy;
  if (state$.doc.peek() !== doc) return;
  const impactWarnings = flowEdgeRemovalWarnings(doc, existingEdges, policy);
  const impactCopy = impactWarnings.length === 0 ? "" : ` ${impactWarnings.join(" ")}`;
  if (typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm(`Delete ${label}?${impactCopy}`)) return;
  removeEdgesFromSelection(removed);
  commitDoc({ ...doc, edges: doc.edges.filter((edge) => !removed.has(edge.id)) });
};

/** What the operator reads when two cards cannot be joined, for each way that can be. */
const refusalLine = (canvas: Canvas, refusal: Extract<Connected, { ok: false }>, draw: { from: string; to: string }): string => {
  switch (refusal.why) {
    case "self":
      return "A node cannot connect to itself.";
    case "label":
      return "Labels cannot take connections.";
    case "git":
      return "Git cannot take connections.";
    case "disabled":
      return "That node is disabled in this build.";
    case "duplicate":
      return "That relation already exists.";
    case "cycle":
      return cycleLine(canvas, refusal.cycle ?? []);
    case "missing":
    case "no-verb": {
      // A card that only sits there (a note, a file, a link, a region) is why.
      const loose = [draw.from, draw.to]
        .map((id) => canvas.nodes.get(asNodeId(id)))
        .find((node) => node !== undefined && roleOfKind(node.kind) === "geography");
      return loose ? `${titleOf(loose)} does not connect to anything.` : "These two cannot be connected.";
    }
  }
};

/** A loop of boards, named: one wording for the single connect and the batch. */
const cycleLine = (canvas: Canvas, cycle: ReadonlyArray<string>): string => {
  const names = cycle.map((id) => {
    const node = canvas.nodes.get(asNodeId(id));
    return node ? titleOf(node) : "that board";
  });
  const loop = names.length > 0 ? `${names.join(" → ")} → ${names[0]}` : "a loop";
  return `That direction would send tasks in a loop — ${loop}. Pick the other direction or a different Next board.`;
};

/** The verb a landing zone named, whether or not the pair admits it; the edit decides. */
const droppedVerb = (handles: ReadonlyArray<string | null | undefined>): Verb | undefined => {
  for (const handle of handles) {
    if (handle?.startsWith(VERB_HANDLE_PREFIX)) return handle.slice(VERB_HANDLE_PREFIX.length) as Verb;
  }
  return undefined;
};

/**
 * Draw one wire. The edit is the model's own (`connected`): it picks the verb
 * the operator dropped on when the pair admits it, else the pair's default,
 * stores the wire in the direction its verb reads, and refuses a wire that
 * would close a loop of boards. A refusal is said in the window's own words
 * and nothing is sent.
 */
export const addEdge = (params: {
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}): void => {
  let drawn: string | undefined;
  commitCommands((canvas) => {
    const draw = {
      id: `edge-${ulid()}`,
      from: params.source,
      to: params.target,
      verb: droppedVerb([params.sourceHandle, params.targetHandle]),
      fromSide: parseSide(params.sourceHandle),
      toSide: parseSide(params.targetHandle),
    };
    const result = connected(canvas, draw);
    if (!result.ok) {
      state$.error.set(refusalLine(canvas, result, draw));
      return [];
    }
    drawn = result.wire.id;
    state$.error.set("");
    return result.commands;
  });
  if (drawn !== undefined) selectEdge(drawn);
};

// --- multi-source → one target (RTS-006) ------------------------------------
// Pure plan + one commit mutator. No landing zones on this path: a batch has no
// drag to land, so every wire takes its pair's default verb.

export type EdgeBatchSkipReason =
  | "self"
  | "duplicate"
  | "missing-source"
  | "group-source"
  | "label-source"
  | "invalid-target"
  | "refused-pair"
  | "flow-cycle";

/** Plan payload speaks the document's one edge word: the verb. */
export type EdgeBatchCandidate = {
  readonly fromNode: string;
  readonly toNode: string;
  readonly verb: Verb;
};

export type EdgeBatchSkip = {
  readonly source: string;
  readonly reason: EdgeBatchSkipReason;
  /** Present only on `flow-cycle` — the loop the refused hop would close. */
  readonly cycle?: FlowCycleError;
};

export type EdgeBatchPlan = {
  readonly toAdd: ReadonlyArray<EdgeBatchCandidate>;
  readonly skipped: ReadonlyArray<EdgeBatchSkip>;
};

/**
 * Pure planner: given selected source ids and a target, compute which wires to
 * create. Does not touch state, ids, or the document.
 * - Skips self, groups-as-sources, missing sources, duplicates (existing or
 *   within the batch).
 * - Invalid target (missing / group) skips every source with `invalid-target`.
 * - A pair the verb grammar refuses skips with `refused-pair`.
 * - Each wire is stored in its verb's order, so a duplicate is judged on the
 *   stored pair rather than the order the operator happened to select in.
 * - A `feeds` hop that would close a cycle (against the document AND the hops
 *   already planned in this batch) skips with `flow-cycle`.
 */
export const planConnectToTarget = (
  sourceIds: ReadonlyArray<string>,
  targetId: string,
  nodes: ReadonlyArray<CanvasNode>,
  edges: ReadonlyArray<CanvasEdge>,
): EdgeBatchPlan => {
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const target = nodeById.get(targetId);
  if (!target || target.type === "group" || isLabelNode(target) || isGitNode(target)) {
    return {
      toAdd: [],
      skipped: sourceIds.map((source) => ({ source, reason: "invalid-target" as const })),
    };
  }

  const existing = new Set(edges.map((edge) => `${edge.fromNode}->${edge.toNode}`));
  const planned = new Set<string>();
  const toAdd: EdgeBatchCandidate[] = [];
  const skipped: EdgeBatchSkip[] = [];
  // Grows with each accepted hop so the batch is guarded as one document.
  const prospective: CanvasEdge[] = [...edges];

  for (const sourceId of sourceIds) {
    if (sourceId === targetId) {
      skipped.push({ source: sourceId, reason: "self" });
      continue;
    }
    const source = nodeById.get(sourceId);
    if (!source) {
      skipped.push({ source: sourceId, reason: "missing-source" });
      continue;
    }
    if (source.type === "group") {
      skipped.push({ source: sourceId, reason: "group-source" });
      continue;
    }
    if (isLabelNode(source) || isGitNode(source)) {
      skipped.push({ source: sourceId, reason: "label-source" });
      continue;
    }
    const sourceKind = kindOf(source);
    const targetKind = kindOf(target);
    const draw = verbsForDraw(sourceKind, targetKind);
    const verb = defaultVerbForPair(
      draw.reversed ? targetKind : sourceKind,
      draw.reversed ? sourceKind : targetKind,
    );
    if (verb === undefined) {
      skipped.push({ source: sourceId, reason: "refused-pair" });
      continue;
    }
    const fromNode = draw.reversed ? targetId : sourceId;
    const toNode = draw.reversed ? sourceId : targetId;
    const key = `${fromNode}->${toNode}`;
    if (existing.has(key) || planned.has(key)) {
      skipped.push({ source: sourceId, reason: "duplicate" });
      continue;
    }
    if (verb === "feeds") {
      const probe: CanvasEdge = {
        id: `probe-${sourceId}`,
        fromNode,
        toNode,
        ether: { verb },
      };
      const cycle = validateFlowDag(wiresFromDocument({ edges: [...prospective, probe] }));
      if (cycle) {
        skipped.push({ source: sourceId, reason: "flow-cycle", cycle });
        continue;
      }
      prospective.push(probe);
    }
    planned.add(key);
    toAdd.push({ fromNode, toNode, verb });
  }

  return { toAdd, skipped };
};

/**
 * Commit one wire per valid selected source → target in a single document
 * write. Preserves selection when `keepSelection` (shift-RMB multi-target
 * convenience). Returns the plan for callers/tests.
 */
export const connectAllToTarget = (
  sourceIds: ReadonlyArray<string>,
  targetId: string,
  options?: { readonly keepSelection?: boolean },
): EdgeBatchPlan => {
  const doc = state$.doc.peek();
  const plan = planConnectToTarget(sourceIds, targetId, doc.nodes, doc.edges);
  if (plan.toAdd.length === 0) {
    const reasons = new Set(plan.skipped.map((item) => item.reason));
    const refusedHop = plan.skipped.find((item) => item.cycle !== undefined);
    if (refusedHop?.cycle) {
      state$.error.set(friendlyCycleMessage(refusedHop.cycle, doc));
    } else if (reasons.has("invalid-target")) {
      state$.error.set("Cannot connect to that target.");
    } else if (reasons.size === 1 && reasons.has("self")) {
      state$.error.set("A node cannot connect to itself.");
    } else if (reasons.has("duplicate") && plan.skipped.length === sourceIds.length) {
      state$.error.set("That relation already exists.");
    } else if (plan.skipped.length > 0) {
      state$.error.set("No new relations to create.");
    }
    return plan;
  }

  const newEdges: CanvasEdge[] = plan.toAdd.map((candidate) => ({
    id: `edge-${ulid()}`,
    fromNode: candidate.fromNode,
    toNode: candidate.toNode,
    ether: { verb: candidate.verb },
  }));

  if (!options?.keepSelection) {
    selectEdge(newEdges[newEdges.length - 1]?.id ?? "");
  }
  state$.error.set("");
  commitDoc({ ...doc, edges: [...doc.edges, ...newEdges] });
  return plan;
};

// --- selection mesh (multi-select connect / disconnect) ---------------------
// Peer wiring across a selection: one wire per unordered pair, each pair
// planned by the same single-target planner so verb, direction, and refusal
// follow the connect grammar. Disconnect is the exact inverse.

const pairKey = (a: string, b: string): string => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * Pure planner: full mesh over `nodeIds`. A pair already wired in either
 * direction, or planned earlier in this batch, is skipped as `duplicate`.
 */
export const planConnectMesh = (
  nodeIds: ReadonlyArray<string>,
  nodes: ReadonlyArray<CanvasNode>,
  edges: ReadonlyArray<CanvasEdge>,
): EdgeBatchPlan => {
  const ids = [...new Set(nodeIds)];
  const linked = new Set(edges.map((edge) => pairKey(edge.fromNode, edge.toNode)));
  const prospective: CanvasEdge[] = [...edges];
  const toAdd: EdgeBatchCandidate[] = [];
  const skipped: EdgeBatchSkip[] = [];
  ids.forEach((targetId, index) => {
    const sources = ids.slice(0, index).filter((sourceId) => {
      if (!linked.has(pairKey(sourceId, targetId))) return true;
      skipped.push({ source: sourceId, reason: "duplicate" });
      return false;
    });
    if (sources.length === 0) return;
    const plan = planConnectToTarget(sources, targetId, nodes, prospective);
    for (const candidate of plan.toAdd) {
      linked.add(pairKey(candidate.fromNode, candidate.toNode));
      prospective.push({
        id: `probe-${candidate.fromNode}-${candidate.toNode}`,
        fromNode: candidate.fromNode,
        toNode: candidate.toNode,
        ether: { verb: candidate.verb },
      });
      toAdd.push(candidate);
    }
    skipped.push(...plan.skipped);
  });
  return { toAdd, skipped };
};

/** Commit the mesh in one document write (one undo step); selection stays. */
export const connectMesh = (nodeIds: ReadonlyArray<string>): EdgeBatchPlan => {
  const doc = state$.doc.peek();
  const plan = planConnectMesh(nodeIds, doc.nodes, doc.edges);
  if (plan.toAdd.length === 0) {
    const allLinked = plan.skipped.length > 0 && plan.skipped.every((item) => item.reason === "duplicate");
    state$.error.set(allLinked ? "Those agents are already connected." : "No new relations to create.");
    return plan;
  }
  const newEdges: CanvasEdge[] = plan.toAdd.map((candidate) => ({
    id: `edge-${ulid()}`,
    fromNode: candidate.fromNode,
    toNode: candidate.toNode,
    ether: { verb: candidate.verb },
  }));
  state$.error.set("");
  commitDoc({ ...doc, edges: [...doc.edges, ...newEdges] });
  return plan;
};

/** Edges with both ends inside `nodeIds`; wires to outside nodes stay out. */
export const edgeIdsWithin = (
  nodeIds: ReadonlyArray<string>,
  edges: ReadonlyArray<CanvasEdge>,
): ReadonlyArray<string> => {
  const inside = new Set(nodeIds);
  return edges
    .filter((edge) => inside.has(edge.fromNode) && inside.has(edge.toNode))
    .map((edge) => edge.id);
};

/** Remove every wire among `nodeIds` through the confirmed delete path. */
export const disconnectWithin = (nodeIds: ReadonlyArray<string>): void => {
  deleteEdges(edgeIdsWithin(nodeIds, state$.doc.peek().edges));
};
