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
} from "./canvas";
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

/** Directed scheduler → target edges that carry an authored effect. */
export const collectEffectEdgesFrom = (
  doc: CanvasDoc,
  sourceNodeId: string,
): ReadonlyArray<EffectEdgeBinding> => {
  const source = doc.nodes.find((node) => node.id === sourceNodeId);
  if (!isSchedulerNode(source)) return [];
  const out: EffectEdgeBinding[] = [];
  for (const edge of doc.edges) {
    if (edge.fromNode !== sourceNodeId) continue;
    const effect = edge.ether?.effect;
    if (!effect) continue;
    const target = doc.nodes.find((node) => node.id === edge.toNode);
    if (!target) continue;
    out.push({ edge, effect, source: source!, target });
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

export const evaluateRelay = (
  doc: CanvasDoc,
  relay: EtherRelay,
): RelayEvaluation => {
  const source = doc.nodes.find((node) => node.id === relay.sourceNodeId);
  if (!source) {
    return { status: "unknown", detail: `source ${relay.sourceNodeId} missing` };
  }

  if (relay.path === "flags") {
    const flag = (relay.equals ?? "blocker") as EtherFlag;
    const has = source.ether?.flags?.includes(flag) ?? false;
    return {
      status: has ? "satisfied" : "pending",
      detail: has ? `flag ${flag} set` : `flag ${flag} absent`,
    };
  }

  // task_state
  if (source.ether?.entity?.kind !== "task") {
    return { status: "unknown", detail: "source is not a task sink" };
  }
  const want = relay.equals ?? "completed";
  const items = source.ether.tasks?.items ?? [];
  if (items.length === 0) {
    return { status: "pending", detail: "no tasks" };
  }
  if (relay.itemId) {
    const item = items.find((task) => task.id === relay.itemId);
    if (!item) {
      return { status: "unknown", detail: `item ${relay.itemId} missing` };
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

export const resolveMirrorFlagEnabled = (
  enabled: boolean | "mirror",
  sensorStatus: "satisfied" | "pending" | "unknown",
): boolean | undefined => {
  if (enabled !== "mirror") return enabled;
  if (sensorStatus === "unknown") return undefined;
  return sensorStatus === "pending";
};
