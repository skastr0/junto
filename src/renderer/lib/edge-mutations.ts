import { ulid } from "ulid";
import type {
  CanvasDoc,
  CanvasEdge,
  CanvasNode,
  EdgeEffect,
  EdgeEnd,
  EtherEdgeFlow,
  WatchWhen,
  WireSlot,
} from "@shared/canvas";
import {
  connectCheck,
  defaultSlotForDraw,
  resolveSpec,
  roleOf,
  type Port,
} from "@shared/physics";
import {
  isTaskFlowPair,
  validateFlowDag,
  type FlowCycleError,
} from "@shared/flow-graph";
import {
  defaultWatchWhenForSource,
  inferSchedulerEdgeEffect,
} from "@shared/scheduler-effects";
import { isLabelNode, nodeTitle } from "./presentation";
import { noteEdgeCreated } from "./edge-sparks";
import { removeEdgesFromSelection, selectEdge, state$ } from "./state";
import { commitDoc, parseSide } from "./mutations";

const roleOfNode = (node: CanvasNode | undefined) => {
  if (!node) return "geography" as const;
  return roleOf(
    resolveSpec({
      isGroup: node.type === "group",
      kind: node.ether?.entity?.kind,
    }),
  );
};

/**
 * Infer watch `when` only for sink → **relay** input wires.
 * Defaults live in `defaultWatchWhenForSource` (single table).
 * Cron/gauge never consume `when` — authoring them would be meaningless config.
 */
export const inferWatchWhen = (
  fromNode: CanvasNode | undefined,
  toNode: CanvasNode | undefined,
): WatchWhen | undefined => {
  if (!fromNode || !toNode) return undefined;
  if (toNode.ether?.entity?.kind !== "relay") return undefined;
  if (roleOfNode(fromNode) !== "sink") return undefined;
  return defaultWatchWhenForSource(fromNode);
};

const without = <T extends object, K extends keyof T>(value: T, key: K): Omit<T, K> => {
  const { [key]: _removed, ...rest } = value;
  return rest;
};

/**
 * Translate a raw FlowCycleError (station ids) into a titled, readable line.
 * One wording for one rejection: the connect-time refusal below and the edge
 * sheet's direction toggle both speak it.
 */
export const friendlyCycleMessage = (error: FlowCycleError, doc: CanvasDoc): string => {
  const titleOf = (id: string): string => {
    const node = doc.nodes.find((candidate) => candidate.id === id);
    return node ? nodeTitle(node) : "that station";
  };
  const names = error.cycle.map(titleOf);
  const loop = names.length > 0 ? `${names.join(" → ")} → ${names[0]}` : "a loop";
  return `That direction would send tasks in a loop — ${loop}. Pick the other direction or a different destination.`;
};

/**
 * The hop a fresh task↔task edge carries. Drawing the wire IS the authoring
 * act, so the flow config lands at connect in draw direction; the sheet toggle
 * only flips or clears it afterwards.
 */
const hopForDraw = (
  fromNode: CanvasNode | undefined,
  toNode: CanvasNode | undefined,
  source: string,
  destination: string,
): EtherEdgeFlow | undefined =>
  isTaskFlowPair(fromNode, toNode) ? { source, destination } : undefined;

export const deleteEdges = (ids: ReadonlyArray<string>): void => {
  const removed = new Set(ids);
  if (removed.size === 0) return;
  const doc = state$.doc.peek();
  const existingEdges = doc.edges.filter((edge) => removed.has(edge.id));
  if (existingEdges.length === 0) return;
  const label = existingEdges.length === 1 ? "this relation" : `${existingEdges.length} relations`;
  if (typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm(`Delete ${label}?`)) return;
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

/**
 * Set or clear edge.ether.ports (ocap attenuation).
 * `undefined` removes the field → full offers (unattenuated).
 * Explicit array (including `[]`) is a closed allow-list — empty = nothing allowed.
 * Does not strip derived kind.
 */
export const setEdgePorts = (
  id: string,
  ports: ReadonlyArray<Port> | undefined,
): void => {
  const doc = state$.doc.peek();
  commitDoc({
    ...doc,
    edges: doc.edges.map((edge) => {
      if (edge.id !== id) return edge;
      if (ports === undefined) {
        if (!edge.ether || edge.ether.ports === undefined) return edge;
        const rest = without(edge.ether, "ports");
        return Object.keys(rest).length > 0
          ? { ...edge, ether: rest }
          : without(edge, "ether");
      }
      return { ...edge, ether: { ...(edge.ether ?? {}), ports: [...ports] } };
    }),
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

/** Author effect word on an edge — `does` only. */
export const setEdgeEffect = (
  id: string,
  effect: EdgeEffect | undefined,
): void => {
  const doc = state$.doc.peek();
  commitDoc({
    ...doc,
    edges: doc.edges.map((edge) => {
      if (edge.id !== id) return edge;
      if (!effect) {
        if (!edge.ether) return edge;
        const rest = without(edge.ether, "does");
        return Object.keys(rest).length > 0
          ? { ...edge, ether: rest }
          : without(edge, "ether");
      }
      return {
        ...edge,
        ether: { ...(edge.ether ?? {}), does: effect },
      };
    }),
  });
};

export const setEdgeWhen = (
  id: string,
  when: WatchWhen | undefined,
): void => {
  const doc = state$.doc.peek();
  commitDoc({
    ...doc,
    edges: doc.edges.map((edge) => {
      if (edge.id !== id) return edge;
      if (!when) {
        if (!edge.ether || edge.ether.when === undefined) return edge;
        const rest = without(edge.ether, "when");
        return Object.keys(rest).length > 0
          ? { ...edge, ether: rest }
          : without(edge, "ether");
      }
      return { ...edge, ether: { ...(edge.ether ?? {}), when } };
    }),
  });
};

export const setEdgeSlot = (
  id: string,
  slot: WireSlot | undefined,
): void => {
  const doc = state$.doc.peek();
  commitDoc({
    ...doc,
    edges: doc.edges.map((edge) => {
      if (edge.id !== id) return edge;
      if (!slot) {
        if (!edge.ether || edge.ether.slot === undefined) return edge;
        const rest = without(edge.ether, "slot");
        return Object.keys(rest).length > 0
          ? { ...edge, ether: rest }
          : without(edge, "ether");
      }
      return { ...edge, ether: { ...(edge.ether ?? {}), slot } };
    }),
  });
};

/**
 * Agent → relay draw choice (gold): fire this relay vs watch the agent.
 * Fire: slot trigger + relay.trigger port. Watch: slot input + flagged when.
 */
export const setAgentRelayMode = (
  id: string,
  mode: "fire" | "watch",
): void => {
  const doc = state$.doc.peek();
  commitDoc({
    ...doc,
    edges: doc.edges.map((edge) => {
      if (edge.id !== id) return edge;
      if (mode === "fire") {
        const rest = edge.ether ? without(without(edge.ether, "when"), "does") : {};
        return {
          ...edge,
          ether: {
            ...rest,
            slot: "trigger" as const,
            ports: ["relay.trigger"],
          },
        };
      }
      // watch
      const rest = edge.ether
        ? without(without(edge.ether, "ports"), "does")
        : {};
      return {
        ...edge,
        ether: {
          ...rest,
          slot: "input" as const,
          when: { word: "flagged" as const, flag: "attention" as const },
        },
      };
    }),
  });
};

/**
 * Board wake eligibility. ON default (field absent); OFF = wake false.
 */
export const setEdgeNotify = (edgeId: string, notify: boolean): void => {
  const doc = state$.doc.peek();
  commitDoc({
    ...doc,
    edges: doc.edges.map((edge) => {
      if (edge.id !== edgeId) return edge;
      const ether = { ...(edge.ether ?? {}) };
      if (notify) {
        delete ether.wake;
      } else {
        ether.wake = false;
      }
      const nextEther = Object.keys(ether).length > 0 ? ether : undefined;
      if (!nextEther) {
        const { ether: _drop, ...rest } = edge;
        return rest;
      }
      return { ...edge, ether: nextEther };
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
  if (doc.edges.some((edge) => edge.fromNode === params.source && edge.toNode === params.target)) {
    state$.error.set("That relation already exists.");
    return;
  }
  const fromNode = doc.nodes.find((node) => node.id === params.source);
  const toNode = doc.nodes.find((node) => node.id === params.target);
  if (
    (fromNode && isLabelNode(fromNode)) ||
    (toNode && isLabelNode(toNode))
  ) {
    state$.error.set("Labels cannot take connections.");
    return;
  }
  const fromRole = roleOfNode(fromNode);
  const toRole = roleOfNode(toNode);
  const fromKind = fromNode?.ether?.entity?.kind;
  const toKind = toNode?.ether?.entity?.kind;
  const check = connectCheck(fromRole, toRole, { fromKind, toKind });
  if (!check.ok) {
    state$.error.set(check.reason);
    return;
  }
  const slot = defaultSlotForDraw({
    fromRole,
    toRole,
    fromKind,
    toKind,
  });
  const does = inferSchedulerEdgeEffect(fromNode, toNode);
  const when = inferWatchWhen(fromNode, toNode);
  // Task stoppage is derived at eval time — never stamp ether.stops on draw.
  // Actor→relay OptIn needs an explicit port mask for relay.trigger grant.
  const ports =
    slot === "trigger" && toNode?.ether?.entity?.kind === "relay"
      ? (["relay.trigger"] as const)
      : undefined;
  const flow = hopForDraw(fromNode, toNode, params.source, params.target);
  const fromSide = parseSide(params.sourceHandle);
  const toSide = parseSide(params.targetHandle);
  const etherParts: NonNullable<CanvasEdge["ether"]> = {
    ...(slot ? { slot } : {}),
    ...(does ? { does } : {}),
    ...(when ? { when } : {}),
    ...(ports ? { ports: [...ports] } : {}),
    ...(flow ? { flow } : {}),
  };
  const ether =
    Object.keys(etherParts).length > 0 ? etherParts : undefined;
  const edge: CanvasEdge = {
    id: `edge-${ulid()}`,
    fromNode: params.source,
    toNode: params.target,
    ...(fromSide ? { fromSide } : {}),
    ...(toSide ? { toSide } : {}),
    ...(ether ? { ether } : {}),
  };
  const nextDoc: CanvasDoc = { ...doc, edges: [...doc.edges, edge] };
  // DAG guard at connect: a hop that would close a loop refuses the wire
  // outright — the same guard setEdgeFlow runs, just one step earlier.
  if (flow) {
    const cycle = validateFlowDag(nextDoc);
    if (cycle) {
      state$.error.set(friendlyCycleMessage(cycle, doc));
      return;
    }
  }
  selectEdge(edge.id);
  state$.error.set("");
  commitDoc(nextDoc);
  noteEdgeCreated(edge);
};

// --- multi-source → one target (RTS-006) ------------------------------------
// Pure plan + one commit mutator. No authorial stops — task stoppage is derived.
// Direction is always source → target (fromNode → toNode).

export type EdgeBatchSkipReason =
  | "self"
  | "duplicate"
  | "missing-source"
  | "group-source"
  | "label-source"
  | "invalid-target"
  | "refused-pair"
  | "flow-cycle";

/** Plan payload uses document words: does / when / slot / ports / flow. */
export type EdgeBatchCandidate = {
  readonly fromNode: string;
  readonly toNode: string;
  readonly does?: EdgeEffect;
  readonly slot?: WireSlot;
  readonly when?: WatchWhen;
  readonly ports?: ReadonlyArray<Port>;
  readonly flow?: EtherEdgeFlow;
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
 * Pure planner: given selected source ids and a target, compute which soft
 * relates edges to create. Does not touch state, ids, or the document.
 * - Skips self, groups-as-sources, missing sources, duplicates (existing or
 *   within the batch).
 * - Invalid target (missing / group) skips every source with `invalid-target`.
 * - Task↔task sources author a pipeline hop; one that would close a cycle
 *   (against the document AND the hops already planned in this batch) skips
 *   with `flow-cycle` rather than landing a loop.
 * - Never stamps ether.stops (derived stoppage at eval).
 */
export const planConnectToTarget = (
  sourceIds: ReadonlyArray<string>,
  targetId: string,
  nodes: ReadonlyArray<CanvasNode>,
  edges: ReadonlyArray<CanvasEdge>,
): EdgeBatchPlan => {
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const target = nodeById.get(targetId);
  if (!target || target.type === "group" || isLabelNode(target)) {
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
    if (isLabelNode(source)) {
      skipped.push({ source: sourceId, reason: "label-source" });
      continue;
    }
    const fromRole = roleOfNode(source);
    const toRole = roleOfNode(target);
    const fromKind = source.ether?.entity?.kind;
    const toKind = target.ether?.entity?.kind;
    if (!connectCheck(fromRole, toRole, { fromKind, toKind }).ok) {
      skipped.push({ source: sourceId, reason: "refused-pair" });
      continue;
    }
    const key = `${sourceId}->${targetId}`;
    if (existing.has(key) || planned.has(key)) {
      skipped.push({ source: sourceId, reason: "duplicate" });
      continue;
    }
    const flow = hopForDraw(source, target, sourceId, targetId);
    if (flow) {
      const probe: CanvasEdge = {
        id: `probe-${sourceId}`,
        fromNode: sourceId,
        toNode: targetId,
        ether: { flow },
      };
      const cycle = validateFlowDag({ nodes, edges: [...prospective, probe] });
      if (cycle) {
        skipped.push({ source: sourceId, reason: "flow-cycle", cycle });
        continue;
      }
      prospective.push(probe);
    }
    planned.add(key);
    const does = inferSchedulerEdgeEffect(source, target);
    const slot = defaultSlotForDraw({
      fromRole,
      toRole,
      fromKind,
      toKind,
    });
    const when = inferWatchWhen(source, target);
    const ports =
      slot === "trigger" && target.ether?.entity?.kind === "relay"
        ? (["relay.trigger"] as const)
        : undefined;
    toAdd.push({
      fromNode: sourceId,
      toNode: targetId,
      ...(does ? { does } : {}),
      ...(slot ? { slot } : {}),
      ...(when ? { when } : {}),
      ...(ports ? { ports: [...ports] } : {}),
      ...(flow ? { flow } : {}),
    });
  }

  return { toAdd, skipped };
};

/**
 * Commit edges from each valid selected source → target in one document write.
 * Soft relates default; preserves selection when `keepSelection` (shift-RMB
 * multi-target convenience). Returns the plan for callers/tests.
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

  const newEdges: CanvasEdge[] = plan.toAdd.map((candidate) => {
    const etherParts: NonNullable<CanvasEdge["ether"]> = {
      ...(candidate.slot ? { slot: candidate.slot } : {}),
      ...(candidate.does ? { does: candidate.does } : {}),
      ...(candidate.when ? { when: candidate.when } : {}),
      ...(candidate.ports && candidate.ports.length > 0
        ? { ports: [...candidate.ports] }
        : {}),
      ...(candidate.flow ? { flow: candidate.flow } : {}),
    };
    const ether =
      Object.keys(etherParts).length > 0 ? etherParts : undefined;
    return {
      id: `edge-${ulid()}`,
      fromNode: candidate.fromNode,
      toNode: candidate.toNode,
      ...(ether ? { ether } : {}),
    };
  });

  if (!options?.keepSelection) {
    selectEdge(newEdges[newEdges.length - 1]?.id ?? "");
  }
  state$.error.set("");
  commitDoc({ ...doc, edges: [...doc.edges, ...newEdges] });
  for (const edge of newEdges) noteEdgeCreated(edge);
  return plan;
};
