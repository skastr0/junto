import { ulid } from "ulid";
import type { CanvasEdge, CanvasNode } from "@shared/canvas";
import { defaultVerbForPair, verbsForPair, type Verb } from "@shared/physics";
import { productNodeKindEnabled, productVerbEnabled } from "@shared/features";
import { validateFlowDag, type FlowCycleError } from "@shared/flow-graph";
import { isGitNode, isLabelNode } from "./presentation";
import { removalPolicy, wireRemovalWarnings } from "./deletion-impact";
import { removeEdgesFromSelection, selectEdge, state$ } from "./state";
import { canvasAsItStands, commitCommands, parseSide } from "./mutations";
import { connected, removed, type Connected } from "./model-edits";
import { physicsKind, roleOfKind } from "./model-kind";
import { asNodeId, asWireId, type Canvas, type Command, type Node, type Wire } from "@shared/model";
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

/**
 * The same question of two nodes as the store holds them: could a wire be
 * drawn between these at all. connectAllowed above goes when its one caller
 * (the canvas's live connect check) asks this instead.
 */
export const canConnect = (from: Node | undefined, to: Node | undefined): boolean => {
  if (from === undefined || to === undefined) return false;
  for (const node of [from, to]) {
    if (node.kind === "region" || node.kind === "label" || node.kind === "git") return false;
    if (!productNodeKindEnabled(physicsKind(node.kind))) return false;
  }
  return verbsForDraw(physicsKind(from.kind), physicsKind(to.kind)).verbs.length > 0;
};

const VERB_HANDLE_PREFIX = "verb:";

/** Handle id a landing zone carries. Never parses as a node side. */
export const verbHandleId = (verb: Verb): string =>
  `${VERB_HANDLE_PREFIX}${verb}`;

/**
 * Remove wires, once the operator has confirmed with what removing them does
 * to tasks on their way. The removal is one act, undone as one.
 */
export const deleteEdges = async (ids: ReadonlyArray<string>): Promise<void> => {
  const going = new Set(ids);
  if (going.size === 0) return;
  const canvas = canvasAsItStands();
  const wires = [...canvas.wires.values()].filter((wire) => going.has(wire.id));
  if (wires.length === 0) return;
  const label = wires.length === 1 ? "this relation" : `${wires.length} relations`;
  const pendingPolicy = removalPolicy(state$.canvasName.peek(), canvas, new Set(), wires);
  const policy = pendingPolicy instanceof Promise ? await pendingPolicy : pendingPolicy;
  // The canvas moved while the policy was being read: what was asked about is
  // no longer what would be removed.
  if (canvasAsItStands().seq !== canvas.seq) return;
  const impactWarnings = wireRemovalWarnings(canvas, wires, policy);
  const impactCopy = impactWarnings.length === 0 ? "" : ` ${impactWarnings.join(" ")}`;
  if (typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm(`Delete ${label}?${impactCopy}`)) return;
  removeEdgesFromSelection(going);
  commitCommands((now) => removed(now, [], [...going]));
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
/** What a plan needs to know of a card: whether it takes a wire at all, and its kind. */
type PlanNode = {
  /** Why it takes no wire, when it takes none. */
  readonly takes: "wire" | "region" | "label" | "git";
  readonly kind: string | undefined;
};
/** A wire as a plan reads it: its two ends, and its verb when it has one. */
type PlanWire = { readonly from: string; readonly to: string; readonly verb?: Verb | undefined };

const planNodeOfDocument = (node: CanvasNode): PlanNode => ({
  takes: node.type === "group" ? "region" : isLabelNode(node) ? "label" : isGitNode(node) ? "git" : "wire",
  kind: kindOf(node),
});
const planNodeOf = (node: Node): PlanNode => ({
  takes: node.kind === "region" ? "region" : node.kind === "label" ? "label" : node.kind === "git" ? "git" : "wire",
  kind: physicsKind(node.kind),
});
const planWireOfDocument = (edge: CanvasEdge): PlanWire => ({
  from: edge.fromNode,
  to: edge.toNode,
  verb: edge.ether?.verb,
});

/** Whether these wires, as a canvas, hold a loop of boards. */
const loopIn = (wires: ReadonlyArray<PlanWire>): FlowCycleError | undefined =>
  validateFlowDag({
    wires: new Map(
      wires.flatMap((wire, index) =>
        wire.verb === undefined
          ? []
          : [[asWireId(`plan-${String(index)}`), { id: asWireId(`plan-${String(index)}`), from: asNodeId(wire.from), to: asNodeId(wire.to), verb: wire.verb }] as const],
      ),
    ),
  });

const planToTarget = (
  sourceIds: ReadonlyArray<string>,
  targetId: string,
  nodeById: ReadonlyMap<string, PlanNode>,
  wires: ReadonlyArray<PlanWire>,
): EdgeBatchPlan => {
  const target = nodeById.get(targetId);
  if (!target || target.takes !== "wire") {
    return {
      toAdd: [],
      skipped: sourceIds.map((source) => ({ source, reason: "invalid-target" as const })),
    };
  }

  const existing = new Set(wires.map((wire) => `${wire.from}->${wire.to}`));
  const planned = new Set<string>();
  const toAdd: EdgeBatchCandidate[] = [];
  const skipped: EdgeBatchSkip[] = [];
  // Grows with each accepted hop so the batch is guarded as one canvas.
  const prospective: PlanWire[] = [...wires];

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
    if (source.takes === "region") {
      skipped.push({ source: sourceId, reason: "group-source" });
      continue;
    }
    if (source.takes !== "wire") {
      skipped.push({ source: sourceId, reason: "label-source" });
      continue;
    }
    const draw = verbsForDraw(source.kind, target.kind);
    const verb = defaultVerbForPair(
      draw.reversed ? target.kind : source.kind,
      draw.reversed ? source.kind : target.kind,
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
      const probe: PlanWire = { from: fromNode, to: toNode, verb };
      const cycle = loopIn([...prospective, probe]);
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

/** The same plan over document nodes and edges, for callers that still hold a document. */
export const planConnectToTarget = (
  sourceIds: ReadonlyArray<string>,
  targetId: string,
  nodes: ReadonlyArray<CanvasNode>,
  edges: ReadonlyArray<CanvasEdge>,
): EdgeBatchPlan =>
  planToTarget(
    sourceIds,
    targetId,
    new Map(nodes.map((node) => [node.id, planNodeOfDocument(node)] as const)),
    edges.map(planWireOfDocument),
  );

/** What the canvas holds, as a plan reads it. */
const planView = (canvas: Canvas) => ({
  nodes: new Map([...canvas.nodes.values()].map((node) => [node.id as string, planNodeOf(node)] as const)),
  wires: [...canvas.wires.values()].map((wire): PlanWire => ({ from: wire.from, to: wire.to, verb: wire.verb })),
});

/** The wires a plan asks for, as the one command that adds them. */
const addPlanned = (canvas: Canvas, plan: EdgeBatchPlan): { commands: ReadonlyArray<Command>; ids: string[] } => {
  const wires: Wire[] = plan.toAdd.map((candidate) => ({
    id: asWireId(`edge-${ulid()}`),
    from: asNodeId(candidate.fromNode),
    to: asNodeId(candidate.toNode),
    verb: candidate.verb,
  }));
  return {
    commands: wires.length === 0 ? [] : [{ _tag: "Add", canvas: canvas.name, nodes: [], wires }],
    ids: wires.map((wire) => wire.id),
  };
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
  let plan: EdgeBatchPlan = { toAdd: [], skipped: [] };
  let added: string[] = [];
  commitCommands((canvas) => {
    const view = planView(canvas);
    plan = planToTarget(sourceIds, targetId, view.nodes, view.wires);
    if (plan.toAdd.length === 0) {
      const reasons = new Set(plan.skipped.map((item) => item.reason));
      const refusedHop = plan.skipped.find((item) => item.cycle !== undefined);
      if (refusedHop?.cycle) {
        state$.error.set(cycleLine(canvas, refusedHop.cycle.cycle));
      } else if (reasons.has("invalid-target")) {
        state$.error.set("Cannot connect to that target.");
      } else if (reasons.size === 1 && reasons.has("self")) {
        state$.error.set("A node cannot connect to itself.");
      } else if (reasons.has("duplicate") && plan.skipped.length === sourceIds.length) {
        state$.error.set("That relation already exists.");
      } else if (plan.skipped.length > 0) {
        state$.error.set("No new relations to create.");
      }
      return [];
    }
    const adding = addPlanned(canvas, plan);
    added = adding.ids;
    state$.error.set("");
    return adding.commands;
  });
  if (added.length > 0 && !options?.keepSelection) selectEdge(added[added.length - 1]!);
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
const planMesh = (
  nodeIds: ReadonlyArray<string>,
  nodeById: ReadonlyMap<string, PlanNode>,
  wires: ReadonlyArray<PlanWire>,
): EdgeBatchPlan => {
  const ids = [...new Set(nodeIds)];
  const linked = new Set(wires.map((wire) => pairKey(wire.from, wire.to)));
  const prospective: PlanWire[] = [...wires];
  const toAdd: EdgeBatchCandidate[] = [];
  const skipped: EdgeBatchSkip[] = [];
  ids.forEach((targetId, index) => {
    const sources = ids.slice(0, index).filter((sourceId) => {
      if (!linked.has(pairKey(sourceId, targetId))) return true;
      skipped.push({ source: sourceId, reason: "duplicate" });
      return false;
    });
    if (sources.length === 0) return;
    const plan = planToTarget(sources, targetId, nodeById, prospective);
    for (const candidate of plan.toAdd) {
      linked.add(pairKey(candidate.fromNode, candidate.toNode));
      prospective.push({ from: candidate.fromNode, to: candidate.toNode, verb: candidate.verb });
      toAdd.push(candidate);
    }
    skipped.push(...plan.skipped);
  });
  return { toAdd, skipped };
};

/** The same plan over document nodes and edges, for callers that still hold a document. */
export const planConnectMesh = (
  nodeIds: ReadonlyArray<string>,
  nodes: ReadonlyArray<CanvasNode>,
  edges: ReadonlyArray<CanvasEdge>,
): EdgeBatchPlan =>
  planMesh(
    nodeIds,
    new Map(nodes.map((node) => [node.id, planNodeOfDocument(node)] as const)),
    edges.map(planWireOfDocument),
  );

/** Wire every pair in the selection as one act (one undo step); selection stays. */
export const connectMesh = (nodeIds: ReadonlyArray<string>): EdgeBatchPlan => {
  let plan: EdgeBatchPlan = { toAdd: [], skipped: [] };
  commitCommands((canvas) => {
    const view = planView(canvas);
    plan = planMesh(nodeIds, view.nodes, view.wires);
    if (plan.toAdd.length === 0) {
      const allLinked = plan.skipped.length > 0 && plan.skipped.every((item) => item.reason === "duplicate");
      state$.error.set(allLinked ? "Those agents are already connected." : "No new relations to create.");
      return [];
    }
    state$.error.set("");
    return addPlanned(canvas, plan).commands;
  });
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
  const inside = new Set(nodeIds);
  void deleteEdges(
    [...canvasAsItStands().wires.values()]
      .filter((wire) => inside.has(wire.from) && inside.has(wire.to))
      .map((wire) => wire.id),
  );
};
