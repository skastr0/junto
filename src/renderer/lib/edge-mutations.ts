import { ulid } from "ulid";
import type {
  CanvasEdge,
  CanvasNode,
  EdgeCriteria,
  EdgeEffect,
  EdgeEnd,
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
  defaultWatchWhenForSource,
  inferSchedulerEdgeEffect,
} from "@shared/scheduler-effects";
import { isLabelNode } from "./presentation";
import { noteEdgeCreated } from "./edge-sparks";
import { state$ } from "./state";
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

export const deleteEdges = (ids: ReadonlyArray<string>): void => {
  const removed = new Set(ids);
  if (removed.size === 0) return;
  const doc = state$.doc.peek();
  const existingEdges = doc.edges.filter((edge) => removed.has(edge.id));
  if (existingEdges.length === 0) return;
  const label = existingEdges.length === 1 ? "this relation" : `${existingEdges.length} relations`;
  if (typeof window !== "undefined" && typeof window.confirm === "function" && !window.confirm(`Delete ${label}?`)) return;
  if (removed.has(state$.selectedEdgeId.peek())) state$.selectedEdgeId.set("");
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
 * Write stops only.
 * `undefined` means: restore auto work-lane stops if either end is task/requests,
 * otherwise clear. Never silently wipe auto tasks stops from Hold "None".
 */
export const setEdgeCriteria = (id: string, criteria: EdgeCriteria | undefined): void => {
  const doc = state$.doc.peek();
  commitDoc({
    ...doc,
    edges: doc.edges.map((edge) => {
      if (edge.id !== id) return edge;
      let cleaned = criteria;
      if (cleaned === undefined) {
        const from = doc.nodes.find((n) => n.id === edge.fromNode);
        const to = doc.nodes.find((n) => n.id === edge.toNode);
        cleaned = inferEdgeCriteria(from, to);
      }
      if (!cleaned) {
        if (!edge.ether) return edge;
        const rest = without(without(edge.ether, "stops"), "kind");
        return Object.keys(rest).length > 0 ? { ...edge, ether: rest } : without(edge, "ether");
      }
      const rest = edge.ether ? without(edge.ether, "kind") : {};
      return { ...edge, ether: { ...rest, stops: cleaned } };
    }),
  });
};

/**
 * Set or clear edge.ether.ports (ocap attenuation).
 * `undefined` or empty array removes the field; absence ⇒ full offers at admit.
 * Does not strip criteria / derived kind.
 */
export const setEdgePorts = (
  id: string,
  ports: ReadonlyArray<Port> | undefined,
): void => {
  const doc = state$.doc.peek();
  const cleaned = ports && ports.length > 0 ? [...ports] : undefined;
  commitDoc({
    ...doc,
    edges: doc.edges.map((edge) => {
      if (edge.id !== id) return edge;
      if (!cleaned) {
        if (!edge.ether || edge.ether.ports === undefined) return edge;
        const rest = without(edge.ether, "ports");
        return Object.keys(rest).length > 0
          ? { ...edge, ether: rest }
          : without(edge, "ether");
      }
      return { ...edge, ether: { ...(edge.ether ?? {}), ports: cleaned } };
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

/**
 * Infer access stops for a directed pair.
 * Work lanes (task/requests on either end) arm tasks stops so attention can
 * block the connected actor whether the edge was drawn agent→task or task→agent.
 * Board/page soft relates only. Proof/approval stay operator-authored via Hold.
 */
export const inferEdgeCriteria = (
  fromNode: CanvasNode | undefined,
  toNode?: CanvasNode | undefined,
): EdgeCriteria | undefined => {
  const kindOf = (n: CanvasNode | undefined) => n?.ether?.entity?.kind;
  const fromKind = kindOf(fromNode);
  const toKind = kindOf(toNode);
  if (
    fromKind === "task" ||
    fromKind === "requests" ||
    toKind === "task" ||
    toKind === "requests"
  ) {
    return { mode: "tasks" };
  }
  return undefined;
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
  criteria?: EdgeCriteria;
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
  const check = connectCheck(fromRole, toRole);
  if (!check.ok) {
    state$.error.set(check.reason);
    return;
  }
  const slot = defaultSlotForDraw({
    fromRole,
    toRole,
    fromKind: fromNode?.ether?.entity?.kind,
    toKind: toNode?.ether?.entity?.kind,
  });
  const does = inferSchedulerEdgeEffect(fromNode, toNode);
  const when = inferWatchWhen(fromNode, toNode);
  // Access-only: tasks/requests stops never ride watch (sink→relay) wires.
  const stops =
    when === undefined && (fromRole === "sink" || toRole === "sink" || fromRole === "actor")
      ? (params.criteria ?? inferEdgeCriteria(fromNode, toNode))
      : undefined;
  // Actor→relay OptIn needs an explicit port mask for relay.trigger grant.
  const ports =
    slot === "trigger" && toNode?.ether?.entity?.kind === "relay"
      ? (["relay.trigger"] as const)
      : undefined;
  const fromSide = parseSide(params.sourceHandle);
  const toSide = parseSide(params.targetHandle);
  const etherParts: NonNullable<CanvasEdge["ether"]> = {
    ...(slot ? { slot } : {}),
    ...(stops ? { stops } : {}),
    ...(does ? { does } : {}),
    ...(when ? { when } : {}),
    ...(ports ? { ports: [...ports] } : {}),
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
  state$.selectedNodeId.set("");
  state$.selectedEdgeId.set(edge.id);
  state$.error.set("");
  commitDoc({ ...doc, edges: [...doc.edges, edge] });
  noteEdgeCreated(edge);
};

// --- multi-source → one target (RTS-006) ------------------------------------
// Pure plan + one commit mutator. Soft relates by default (tasks still auto-bind
// via inferEdgeCriteria, matching single-edge connect). Direction is always
// source → target (fromNode → toNode), same as addEdge / Inspector connect.

export type EdgeBatchSkipReason =
  | "self"
  | "duplicate"
  | "missing-source"
  | "group-source"
  | "label-source"
  | "invalid-target"
  | "refused-pair";

/** Plan payload uses document words: stops / does / when / slot / ports. */
export type EdgeBatchCandidate = {
  readonly fromNode: string;
  readonly toNode: string;
  readonly stops?: EdgeCriteria;
  readonly does?: EdgeEffect;
  readonly slot?: WireSlot;
  readonly when?: WatchWhen;
  readonly ports?: ReadonlyArray<Port>;
};

export type EdgeBatchPlan = {
  readonly toAdd: ReadonlyArray<EdgeBatchCandidate>;
  readonly skipped: ReadonlyArray<{ readonly source: string; readonly reason: EdgeBatchSkipReason }>;
};

/**
 * Pure planner: given selected source ids and a target, compute which soft
 * relates edges to create. Does not touch state, ids, or the document.
 * - Skips self, groups-as-sources, missing sources, duplicates (existing or
 *   within the batch).
 * - Invalid target (missing / group) skips every source with `invalid-target`.
 * - Criteria: optional override per batch; else inferred per source (tasks →
 *   tasks criteria; otherwise none = soft relates).
 */
export const planConnectToTarget = (
  sourceIds: ReadonlyArray<string>,
  targetId: string,
  nodes: ReadonlyArray<CanvasNode>,
  edges: ReadonlyArray<CanvasEdge>,
  criteriaOverride?: EdgeCriteria,
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
  const skipped: Array<{ source: string; reason: EdgeBatchSkipReason }> = [];

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
    if (!connectCheck(fromRole, toRole).ok) {
      skipped.push({ source: sourceId, reason: "refused-pair" });
      continue;
    }
    const key = `${sourceId}->${targetId}`;
    if (existing.has(key) || planned.has(key)) {
      skipped.push({ source: sourceId, reason: "duplicate" });
      continue;
    }
    planned.add(key);
    const does = inferSchedulerEdgeEffect(source, target);
    const slot = defaultSlotForDraw({
      fromRole,
      toRole,
      fromKind: source.ether?.entity?.kind,
      toKind: target.ether?.entity?.kind,
    });
    const when = inferWatchWhen(source, target);
    // Access-only stops — never stamp tasks stops on watch wires.
    const stops =
      when === undefined &&
      (fromRole === "sink" || toRole === "sink" || fromRole === "actor")
        ? (criteriaOverride ?? inferEdgeCriteria(source, target))
        : undefined;
    const ports =
      slot === "trigger" && target.ether?.entity?.kind === "relay"
        ? (["relay.trigger"] as const)
        : undefined;
    toAdd.push({
      fromNode: sourceId,
      toNode: targetId,
      ...(stops ? { stops } : {}),
      ...(does ? { does } : {}),
      ...(slot ? { slot } : {}),
      ...(when ? { when } : {}),
      ...(ports ? { ports: [...ports] } : {}),
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
  options?: { readonly keepSelection?: boolean; readonly criteria?: EdgeCriteria },
): EdgeBatchPlan => {
  const doc = state$.doc.peek();
  const plan = planConnectToTarget(sourceIds, targetId, doc.nodes, doc.edges, options?.criteria);
  if (plan.toAdd.length === 0) {
    const reasons = new Set(plan.skipped.map((item) => item.reason));
    if (reasons.has("invalid-target")) {
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
      ...(candidate.stops ? { stops: candidate.stops } : {}),
      ...(candidate.does ? { does: candidate.does } : {}),
      ...(candidate.when ? { when: candidate.when } : {}),
      ...(candidate.ports && candidate.ports.length > 0
        ? { ports: [...candidate.ports] }
        : {}),
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
    state$.selectedNodeId.set("");
    state$.selectedNodeIds.set([]);
    state$.selectedEdgeId.set(newEdges[newEdges.length - 1]?.id ?? "");
  }
  state$.error.set("");
  commitDoc({ ...doc, edges: [...doc.edges, ...newEdges] });
  for (const edge of newEdges) noteEdgeCreated(edge);
  return plan;
};
