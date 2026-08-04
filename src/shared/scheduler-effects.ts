/**
 * Pure automation-effect plane for schedulers.
 *
 * Product sensors (author these): cron (time) + relay (canvas node projection).
 * Gauge/watcher (hermes stat_threshold) is product-dormant — still evaluated if
 * present on a board, but not a palette product and not “the external sensor.”
 * Hermes adapters = agent fleet join; do not invent a hermes-gauge product story.
 *
 * Effects ride `edge.ether.does` (not ports, not stops). The kernel
 * applies them on home-local fire; claim assignment stays the factory tick.
 * Product words only: stops / does / wake / when / slot / ports.
 */

import type {
  CanvasDoc,
  CanvasEdge,
  CanvasNode,
  EdgeEffect,
  EtherFlag,
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

/** Directed scheduler → target edges that carry an authored effect (`does`). */
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

/** Watch input wires: sink → relay (`when` on the edge). */
export type WatchEdgeBinding = {
  readonly edge: CanvasEdge;
  readonly when: WatchWhen;
  readonly source: CanvasNode;
  readonly scheduler: CanvasNode;
};

/**
 * Default `when` for a sink → relay edge with no authored predicate yet.
 * Single table for authoring + kernel evaluation defaults.
 */
export const defaultWatchWhenForSource = (
  source: CanvasNode,
): WatchWhen | undefined => {
  const kind = source.ether?.entity?.kind;
  if (kind === "task" || kind === "requests") return { word: "completes" };
  if (kind === "page") return { word: "completes", equals: "ready" };
  if (kind === "board") return { word: "completes", equals: "post" };
  if (kind === "artifacts") return { word: "completes" };
  return undefined;
};

export const NO_WATCH_YET_DETAIL =
  "no watch yet — draw a sink in and set fires-when";

const sourceRole = (source: CanvasNode) =>
  roleOf(
    resolveSpec({
      isGroup: source.type === "group",
      kind: source.ether?.entity?.kind,
    }),
  );

/**
 * Watch inputs into a scheduler (product: sink → relay).
 * Counts an edge when:
 * - `toNode` is the scheduler
 * - slot is absent or `"input"` (skip effect/trigger/recipient wires)
 * - source is a sink **or** the edge has an authored `when`
 * Authored `when` wins; else default from `defaultWatchWhenForSource` on relay.
 * Multiple matching edges remain OR-combined by the caller.
 */
export const collectWatchEdgesInto = (
  doc: CanvasDoc,
  schedulerNodeId: string,
): ReadonlyArray<WatchEdgeBinding> => {
  const scheduler = doc.nodes.find((node) => node.id === schedulerNodeId);
  if (!isSchedulerNode(scheduler)) return [];
  const out: WatchEdgeBinding[] = [];
  for (const edge of doc.edges) {
    if (edge.toNode !== schedulerNodeId) continue;
    const source = doc.nodes.find((node) => node.id === edge.fromNode);
    if (!source) continue;
    const slot = edge.ether?.slot;
    if (slot !== undefined && slot !== "input") continue;
    const authored = edge.ether?.when;
    const isSink = sourceRole(source) === "sink";
    if (!authored && !isSink) continue;
    // Authored `when` wins; else default for sink → relay.
    const when =
      authored ??
      (scheduler!.ether?.entity?.kind === "relay"
        ? defaultWatchWhenForSource(source)
        : undefined);
    if (!when) continue;
    out.push({ edge, when, source, scheduler: scheduler! });
  }
  return out;
};

export type EffectTargetError =
  | "target_not_task_sink"
  | "target_not_agent"
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
  if (effect.mode === "inject_prompt") {
    if (target.type === "group") return "target_missing";
    if (target.ether?.entity?.kind !== "agent") return "target_not_agent";
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

/** Infer effect when connecting a scheduler → target. */
export const inferSchedulerEdgeEffect = (
  fromNode: CanvasNode | undefined,
  toNode: CanvasNode | undefined,
): EdgeEffect | undefined => {
  if (!isSchedulerNode(fromNode)) return undefined;
  const toKind = toNode?.ether?.entity?.kind;
  if (toKind === "task") {
    return {
      mode: "enqueue_task",
      brief: defaultEnqueueBrief(fromNode!),
      reason: "scheduler",
    };
  }
  if (toKind === "agent") {
    return { mode: "inject_prompt" };
  }
  return undefined;
};

/** Default inject text when the wire carries no authored template. */
export const defaultInjectPromptText = (
  source: CanvasNode,
  fireStatus?: string,
): string => {
  const kind = source.ether?.entity?.kind ?? "scheduler";
  const label =
    source.type === "text" && source.text.trim().length > 0
      ? source.text.trim().split("\n")[0]!
      : kind;
  const status = fireStatus ? ` (${fireStatus})` : "";
  return `[factory] ${label} fired${status}`;
};

export type RelayEvaluation = {
  readonly status: "satisfied" | "pending" | "unknown";
  readonly detail: string;
};

const evaluateWatchAtom = (
  source: CanvasNode,
  when: Extract<WatchWhen, { readonly word: "completes" | "flagged" }>,
): RelayEvaluation => {
  if (when.word === "flagged") {
    const flag = when.flag;
    const has = source.ether?.flags?.includes(flag) ?? false;
    return {
      status: has ? "satisfied" : "pending",
      detail: has ? `flag ${flag} set` : `flag ${flag} absent`,
    };
  }
  // completes — kind-specific. equals discriminates variants (ready vs failed).
  const kind = source.ether?.entity?.kind;
  const want = when.equals ?? "completed";

  if (kind === "task" || kind === "requests") {
    const items =
      kind === "requests"
        ? (source.ether?.requests?.items ?? [])
        : (source.ether?.tasks?.items ?? []);
    if (items.length === 0) {
      return { status: "pending", detail: "no items" };
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
  }

  if (kind === "page") {
    // Page load is live browser session state. Kernel watch has no session
    // projection yet — not "waiting" (that would spin forever), just unknown.
    return {
      status: "unknown",
      detail:
        want === "failed"
          ? "page fail not connected yet"
          : "page load not connected yet",
    };
  }

  if (kind === "board") {
    const board = source.ether?.board;
    if (want === "topic") {
      const n = board?.topics?.length ?? 0;
      return n > 0
        ? { status: "satisfied", detail: `${n} topic(s)` }
        : { status: "pending", detail: "no topics yet" };
    }
    // post: any topic with posts, or board-level post count if present
    const posts =
      board?.topics?.reduce(
        (sum, t) => sum + (typeof t.postCount === "number" ? t.postCount : 0),
        0,
      ) ?? 0;
    return posts > 0
      ? { status: "satisfied", detail: `${posts} post(s)` }
      : { status: "pending", detail: "no posts yet" };
  }

  if (kind === "artifacts") {
    const n = source.ether?.artifacts?.items?.length ?? 0;
    return n > 0
      ? { status: "satisfied", detail: `${n} artifact(s)` }
      : { status: "pending", detail: "no artifacts yet" };
  }

  return {
    status: "unknown",
    detail: `no completes rule for kind ${kind ?? "none"}`,
  };
};

/** Evaluate a watch predicate against a concrete source node. */
export const evaluateWatchWhen = (
  source: CanvasNode | undefined,
  when: WatchWhen,
): RelayEvaluation => {
  if (!source) {
    return {
      status: "unknown",
      detail: "watch source gone — reconnect a sink",
    };
  }
  if (when.word === "any") {
    return combineWatchEvaluations(
      when.any.map((atom) => evaluateWatchAtom(source, atom)),
    );
  }
  return evaluateWatchAtom(source, when);
};

/**
 * Combine multiple watch inputs: **OR** — any input satisfied fires.
 *
 * Rising-edge memory is per relay node (not per input wire), so if A
 * satisfies and later B satisfies while A is still satisfied, there is no
 * new rising edge and the relay will not refire. Stated fire semantics for v1.
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
