import { ulid } from "ulid";
import type { CanvasDoc, CanvasEdge, CanvasNode, EdgeEnd } from "@shared/canvas";
import {
  defaultVerbForPair,
  resolveSpec,
  roleOf,
  verbsForPair,
  type Verb,
} from "@shared/physics";
import { validateFlowDag, type FlowCycleError } from "@shared/flow-graph";
import { isGitNode, isLabelNode, nodeTitle } from "./presentation";
import { flowEdgeRemovalWarnings } from "./deletion-impact";
import { removeEdgesFromSelection, selectEdge, state$ } from "./state";
import { commitDoc, parseSide } from "./mutations";

/**
 * Edge authoring — drawing the wire is the whole act.
 *
 * An edge states one verb and nothing else. The pair of endpoint kinds decides
 * which verbs are legal; where two are, the operator picks by dropping on one
 * of the card's landing zones, and every other connect path takes the pair's
 * default. Ports, watch predicates, fire actions, and the task path hop are
 * compiled from the verb (`physics/verbs.ts`), never stored beside it.
 */

const roleOfNode = (node: CanvasNode | undefined) => {
  if (!node) return "geography" as const;
  return roleOf(
    resolveSpec({
      isGroup: node.type === "group",
      kind: node.ether?.entity?.kind,
    }),
  );
};

/** Authored kind, or nothing for a region — geography holds no verb. */
const kindOf = (node: CanvasNode | undefined): string | undefined =>
  node === undefined || node.type === "group"
    ? undefined
    : node.ether?.entity?.kind;

const without = <T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> => {
  const { [key]: _removed, ...rest } = value;
  return rest;
};

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
  const drawn = verbsForPair(fromKind, toKind);
  if (drawn.length > 0) return { verbs: drawn, reversed: false };
  const flipped = verbsForPair(toKind, fromKind);
  return flipped.length > 0 ? { verbs: flipped, reversed: true } : NO_DRAW_VERBS;
};

/** Cards that take no wire whatever their kinds say. */
const wireableNode = (node: CanvasNode | undefined): boolean =>
  node !== undefined &&
  node.type !== "group" &&
  !isLabelNode(node) &&
  !isGitNode(node);

/** Live connect validation — the same grammar the commit below enforces. */
export const connectAllowed = (
  fromNode: CanvasNode | undefined,
  toNode: CanvasNode | undefined,
): boolean =>
  wireableNode(fromNode) &&
  wireableNode(toNode) &&
  verbsForDraw(kindOf(fromNode), kindOf(toNode)).verbs.length > 0;

const refusalReason = (
  fromNode: CanvasNode | undefined,
  toNode: CanvasNode | undefined,
): string => {
  const fromRole = roleOfNode(fromNode);
  const toRole = roleOfNode(toNode);
  if (fromRole === "geography" || toRole === "geography") {
    return "Geography takes no edges";
  }
  if (fromRole === "sink" && toRole === "sink") {
    return "Sinks cannot wire to each other — use a relay between them";
  }
  return "This pair cannot be wired";
};

const VERB_HANDLE_PREFIX = "verb:";

/** Handle id a landing zone carries. Never parses as a node side. */
export const verbHandleId = (verb: Verb): string =>
  `${VERB_HANDLE_PREFIX}${verb}`;

/**
 * The verb a landing zone stamped. React Flow reports the dropped handle as
 * `sourceHandle` or `targetHandle` depending on which end the drag began at,
 * so both are read; a verb the pair cannot hold is ignored rather than trusted.
 */
export const verbFromHandles = (
  handles: ReadonlyArray<string | null | undefined>,
  legal: ReadonlyArray<Verb>,
): Verb | undefined => {
  for (const handle of handles) {
    if (!handle || !handle.startsWith(VERB_HANDLE_PREFIX)) continue;
    const dropped = handle.slice(VERB_HANDLE_PREFIX.length);
    const verb = legal.find((candidate) => candidate === dropped);
    if (verb) return verb;
  }
  return undefined;
};

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

export const deleteEdges = (ids: ReadonlyArray<string>): void => {
  const removed = new Set(ids);
  if (removed.size === 0) return;
  const doc = state$.doc.peek();
  const existingEdges = doc.edges.filter((edge) => removed.has(edge.id));
  if (existingEdges.length === 0) return;
  const label = existingEdges.length === 1 ? "this relation" : `${existingEdges.length} relations`;
  const impactWarnings = flowEdgeRemovalWarnings(doc, existingEdges);
  const impactCopy = impactWarnings.length === 0 ? "" : ` ${impactWarnings.join(" ")}`;
  if (typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm(`Delete ${label}?${impactCopy}`)) return;
  removeEdgesFromSelection(removed);
  commitDoc({ ...doc, edges: doc.edges.filter((edge) => !removed.has(edge.id)) });
};

export const setEdgeColor = (id: string, color?: string): void => {
  const doc = state$.doc.peek();
  commitDoc({
    ...doc,
    edges: doc.edges.map((edge) =>
      edge.id === id ? (color ? { ...edge, color } : without(edge, "color")) : edge,
    ),
  });
};

export const editEdgeLabel = (id: string, label: string): void => {
  const doc = state$.doc.peek();
  const nextLabel = label.trim();
  commitDoc({
    ...doc,
    edges: doc.edges.map((edge) =>
      edge.id === id ? (nextLabel ? { ...edge, label: nextLabel } : without(edge, "label")) : edge,
    ),
  });
};

export const toggleEdgeArrow = (id: string, side: "from" | "to"): void => {
  const doc = state$.doc.peek();
  commitDoc({
    ...doc,
    edges: doc.edges.map((edge) => {
      if (edge.id !== id) return edge;
      const next: EdgeEnd | undefined = side === "from"
        ? (edge.fromEnd === "arrow" ? undefined : "arrow")
        : (edge.toEnd === "arrow" ? undefined : "arrow");
      if (side === "from") {
        return next ? { ...edge, fromEnd: next } : without(edge, "fromEnd");
      }
      return next ? { ...edge, toEnd: next } : without(edge, "toEnd");
    }),
  });
};

export const addEdge = (params: {
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
}): void => {
  if (params.source === params.target) {
    state$.error.set("A node cannot connect to itself.");
    return;
  }
  const doc = state$.doc.peek();
  const fromNode = doc.nodes.find((node) => node.id === params.source);
  const toNode = doc.nodes.find((node) => node.id === params.target);
  if (
    (fromNode && isLabelNode(fromNode)) ||
    (toNode && isLabelNode(toNode))
  ) {
    state$.error.set("Labels cannot take connections.");
    return;
  }
  if (
    (fromNode && isGitNode(fromNode)) ||
    (toNode && isGitNode(toNode))
  ) {
    state$.error.set("Git cannot take connections.");
    return;
  }
  const fromKind = kindOf(fromNode);
  const toKind = kindOf(toNode);
  const draw = verbsForDraw(fromKind, toKind);
  const sourceKind = draw.reversed ? toKind : fromKind;
  const targetKind = draw.reversed ? fromKind : toKind;
  // A landing zone names the verb outright; every other path — click-connect,
  // a card-body drop, batch connect — takes the pair's default.
  const verb =
    verbFromHandles([params.sourceHandle, params.targetHandle], draw.verbs) ??
    defaultVerbForPair(sourceKind, targetKind);
  if (verb === undefined) {
    state$.error.set(refusalReason(fromNode, toNode));
    return;
  }
  const fromId = draw.reversed ? params.target : params.source;
  const toId = draw.reversed ? params.source : params.target;
  if (doc.edges.some((edge) => edge.fromNode === fromId && edge.toNode === toId)) {
    state$.error.set("That relation already exists.");
    return;
  }
  // Sides follow the stored ends, so a reversed draw keeps its anchors.
  const drawnFromSide = parseSide(params.sourceHandle);
  const drawnToSide = parseSide(params.targetHandle);
  const fromSide = draw.reversed ? drawnToSide : drawnFromSide;
  const toSide = draw.reversed ? drawnFromSide : drawnToSide;
  const edge: CanvasEdge = {
    id: `edge-${ulid()}`,
    fromNode: fromId,
    toNode: toId,
    ...(fromSide ? { fromSide } : {}),
    ...(toSide ? { toSide } : {}),
    ether: { verb },
  };
  const nextDoc: CanvasDoc = { ...doc, edges: [...doc.edges, edge] };
  // DAG guard at connect: a hop that would close a loop refuses the wire
  // outright rather than landing a task path that can never drain.
  if (verb === "feeds") {
    const cycle = validateFlowDag(nextDoc);
    if (cycle) {
      state$.error.set(friendlyCycleMessage(cycle, doc));
      return;
    }
  }
  selectEdge(edge.id);
  state$.error.set("");
  commitDoc(nextDoc);
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
      const cycle = validateFlowDag({ nodes, edges: [...prospective, probe] });
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
