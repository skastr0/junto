/**
 * Pure automation-effect plane for schedulers.
 *
 * Product sensors (author these): cron (time) + relay (canvas node projection).
 * Gauge/watcher (hermes stat_threshold) is product-dormant — still evaluated if
 * present on a board, but not a palette product and not “the external sensor.”
 * Hermes adapters = agent fleet join; do not invent a hermes-gauge product story.
 *
 * Effects ride `edge.ether.effect` (not ports, not criteria). The kernel
 * applies them on home-local fire; claim assignment stays the factory tick.
 */

import type {
  CanvasDoc,
  CanvasEdge,
  CanvasNode,
  EdgeEffect,
  EtherFlag,
  EtherRelay,
  WatchWhen,
} from "./canvas";
import { edgeDoes } from "./canvas";
import { resolveSpec, roleOf } from "./physics/kinds";

export const SCHEDULER_ENTITY_KINDS = [
  "watcher",
  "timer",
  "cron",
  "relay",
] as const;

export type SchedulerEntityKind = (typeof SCHEDULER_ENTITY_KINDS)[number];

export const isSchedulerEntityKind = (
  kind: string | undefined,
): kind is SchedulerEntityKind =>
  kind === "watcher" ||
  kind === "timer" ||
  kind === "cron" ||
  kind === "relay";

export const isSchedulerNode = (node: CanvasNode | undefined): boolean =>
  node !== undefined &&
  node.type !== "group" &&
  isSchedulerEntityKind(node.ether?.entity?.kind);

export type EffectEdgeBinding = {
  readonly edge: CanvasEdge;
  readonly effect: EdgeEffect;
  readonly source: CanvasNode;
  readonly target: CanvasNode;
};

/** Directed scheduler → target edges that carry an authored effect (does | effect). */
export const collectEffectEdgesFrom = (
  doc: CanvasDoc,
  sourceNodeId: string,
): ReadonlyArray<EffectEdgeBinding> => {
  const source = doc.nodes.find((node) => node.id === sourceNodeId);
  if (!isSchedulerNode(source)) return [];
  const out: EffectEdgeBinding[] = [];
  for (const edge of doc.edges) {
    if (edge.fromNode !== sourceNodeId) continue;
    const effect = edgeDoes(edge.ether);
    if (!effect) continue;
    const target = doc.nodes.find((node) => node.id === edge.toNode);
    if (!target) continue;
    out.push({ edge, effect, source: source!, target });
  }
  return out;
};

/** Watch input wires: sink → scheduler with when (or legacy slot input). */
export type WatchEdgeBinding = {
  readonly edge: CanvasEdge;
  readonly when: WatchWhen;
  readonly source: CanvasNode;
  readonly scheduler: CanvasNode;
};

export const collectWatchEdgesInto = (
  doc: CanvasDoc,
  schedulerNodeId: string,
): ReadonlyArray<WatchEdgeBinding> => {
  const scheduler = doc.nodes.find((node) => node.id === schedulerNodeId);
  if (!isSchedulerNode(scheduler)) return [];
  const out: WatchEdgeBinding[] = [];
  for (const edge of doc.edges) {
    if (edge.toNode !== schedulerNodeId) continue;
    const when = edge.ether?.when;
    if (!when) continue;
    const source = doc.nodes.find((node) => node.id === edge.fromNode);
    if (!source) continue;
    out.push({ edge, when, source, scheduler: scheduler! });
  }
  return out;
};

export type EffectTargetError =
  | "target_not_task_sink"
  | "target_missing"
  | "empty_brief"
  | "invalid_flag";

export const validateEffectTarget = (
  effect: EdgeEffect,
  target: CanvasNode,
): EffectTargetError | undefined => {
  if (effect.mode === "enqueue_task") {
    if (target.ether?.entity?.kind !== "task") return "target_not_task_sink";
    if (roleOf(resolveSpec({ isGroup: target.type === "group", kind: target.ether?.entity?.kind })) !== "sink") {
      return "target_not_task_sink";
    }
    if (effect.brief.trim().length === 0) return "empty_brief";
    return undefined;
  }
  // set_flag: any non-group node
  if (target.type === "group") return "target_missing";
  return undefined;
};

export const defaultEnqueueBrief = (source: CanvasNode): string => {
  if (source.type === "text" && source.text.trim().length > 0) {
    return source.text.trim();
  }
  const kind = source.ether?.entity?.kind ?? "scheduler";
  return `Scheduled work from ${kind}`;
};

/** Infer enqueue effect when connecting a scheduler to a task sink. */
export const inferSchedulerEdgeEffect = (
  fromNode: CanvasNode | undefined,
  toNode: CanvasNode | undefined,
): EdgeEffect | undefined => {
  if (!isSchedulerNode(fromNode)) return undefined;
  if (toNode?.ether?.entity?.kind !== "task") return undefined;
  return {
    mode: "enqueue_task",
    brief: defaultEnqueueBrief(fromNode!),
    reason: "scheduler",
  };
};

export type RelayEvaluation = {
  readonly status: "satisfied" | "pending" | "unknown";
  readonly detail: string;
};

/** Evaluate a watch predicate against a concrete source node. */
export const evaluateWatchWhen = (
  source: CanvasNode | undefined,
  when: WatchWhen,
): RelayEvaluation => {
  if (!source) {
    return { status: "unknown", detail: "source missing" };
  }
  if (when.word === "flagged") {
    const flag = when.flag;
    const has = source.ether?.flags?.includes(flag) ?? false;
    return {
      status: has ? "satisfied" : "pending",
      detail: has ? `flag ${flag} set` : `flag ${flag} absent`,
    };
  }
  // completes
  if (source.ether?.entity?.kind !== "task") {
    return { status: "unknown", detail: "source is not a task sink" };
  }
  const want = when.equals ?? "completed";
  const items = source.ether.tasks?.items ?? [];
  if (items.length === 0) {
    return { status: "pending", detail: "no tasks" };
  }
  if (when.itemId) {
    const item = items.find((task) => task.id === when.itemId);
    if (!item) {
      return { status: "unknown", detail: `item ${when.itemId} missing` };
    }
    const ok = item.state === want;
    return {
      status: ok ? "satisfied" : "pending",
      detail: `${item.id} state ${item.state} (want ${want})`,
    };
  }
  const match = items.find((task) => task.state === want);
  if (match) {
    return {
      status: "satisfied",
      detail: `${match.id} is ${want}`,
    };
  }
  return {
    status: "pending",
    detail: `no item in state ${want}`,
  };
};

/** @deprecated Prefer evaluateWatchWhen on wire `when`. Legacy EtherRelay body. */
export const evaluateRelay = (
  doc: CanvasDoc,
  relay: EtherRelay,
): RelayEvaluation => {
  const source = doc.nodes.find((node) => node.id === relay.sourceNodeId);
  if (relay.path === "flags") {
    return evaluateWatchWhen(source, {
      word: "flagged",
      flag: (relay.equals ?? "blocker") as EtherFlag,
    });
  }
  return evaluateWatchWhen(source, {
    word: "completes",
    ...(relay.equals ? { equals: relay.equals } : {}),
    ...(relay.itemId ? { itemId: relay.itemId } : {}),
  });
};

/**
 * Combine multiple watch inputs: satisfied if ANY is satisfied.
 * unknown only if all unknown; else pending if none satisfied.
 */
export const combineWatchEvaluations = (
  parts: ReadonlyArray<RelayEvaluation>,
): RelayEvaluation => {
  if (parts.length === 0) {
    return { status: "unknown", detail: "no watch wires" };
  }
  const satisfied = parts.find((p) => p.status === "satisfied");
  if (satisfied) return satisfied;
  const pending = parts.find((p) => p.status === "pending");
  if (pending) return pending;
  return parts[0]!;
};

export const resolveMirrorFlagEnabled = (
  enabled: boolean | "mirror",
  sensorStatus: "satisfied" | "pending" | "unknown",
): boolean | undefined => {
  if (enabled !== "mirror") return enabled;
  if (sensorStatus === "unknown") return undefined;
  return sensorStatus === "pending";
};
