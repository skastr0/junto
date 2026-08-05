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
import {
  defaultEffectBoardCreateTopic,
  defaultEffectTasksCreate,
  effectBoardCreateTopicValid,
  effectBoardPostValid,
  effectTasksCreateValid,
} from "./node-insert";
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
  | "target_not_board"
  | "target_not_agent"
  | "target_missing"
  | "invalid_payload"
  | "invalid_flag";

export const validateEffectTarget = (
  effect: EdgeEffect,
  target: CanvasNode,
): EffectTargetError | undefined => {
  if (effect.mode === "enqueue_task") {
    const kind = target.ether?.entity?.kind;
    if (kind !== "task") return "target_not_task_sink";
    if (roleOf(resolveSpec({ isGroup: target.type === "group", kind })) !== "sink") {
      return "target_not_task_sink";
    }
    if (!effectTasksCreateValid(effect.data)) return "invalid_payload";
    return undefined;
  }
  if (effect.mode === "board_create_topic" || effect.mode === "board_post") {
    const kind = target.ether?.entity?.kind;
    if (kind !== "board") return "target_not_board";
    if (roleOf(resolveSpec({ isGroup: target.type === "group", kind })) !== "sink") {
      return "target_not_board";
    }
    if (effect.mode === "board_create_topic") {
      if (!effectBoardCreateTopicValid(effect.data)) return "invalid_payload";
    } else if (!effectBoardPostValid(effect.data)) {
      return "invalid_payload";
    }
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

/** Human label for a scheduler node (text first line, else entity kind). */
export const schedulerSourceLabel = (source: CanvasNode): string => {
  if (source.type === "text" && source.text.trim().length > 0) {
    return source.text.trim().split("\n")[0]!;
  }
  return source.ether?.entity?.kind ?? "scheduler";
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
      data: defaultEffectTasksCreate(schedulerSourceLabel(fromNode!)),
    };
  }
  if (toKind === "board") {
    return {
      mode: "board_create_topic",
      data: defaultEffectBoardCreateTopic(schedulerSourceLabel(fromNode!)),
    };
  }
  if (toKind === "agent") {
    return { mode: "inject_prompt" };
  }
  // Flag sinks: bare draw is a real product effect, not a silent no-op.
  if (toKind === "requests" || toKind === "artifacts" || toKind === "page") {
    return { mode: "set_flag", flag: "attention", enabled: true };
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

/**
 * Live browser load outcome for a page node (main→kernel thin map).
 * Mirrors BrowserSessionState names used by the session machine.
 */
export type PageLoadStatus =
  | "idle"
  | "loading"
  | "ready"
  | "failed"
  | "detached"
  | "destroyed";

/**
 * Runtime sensors the pure evaluator cannot read from the document.
 * Key for page loads: document-local node id (map is scoped to one canvas
 * by the kernel when evaluating that canvas's relays).
 */
export type WatchEvalContext = {
  readonly pageLoadByNodeId?: ReadonlyMap<string, PageLoadStatus>;
};

/** Canvas-scoped key for the main-process page load map. */
export const pageLoadMapKey = (
  canvasName: string,
  nodeId: string,
): string => `${canvasName}::${nodeId}`;

/**
 * Prefer terminal load outcomes when multiple warm sessions share a page
 * node (UI + agent owners). ready/failed win over in-flight; loading over idle.
 */
export const mergePageLoadStatus = (
  previous: PageLoadStatus | undefined,
  next: PageLoadStatus,
): PageLoadStatus => {
  if (previous === undefined) return next;
  const rank = (status: PageLoadStatus): number => {
    switch (status) {
      case "ready":
        return 5;
      case "failed":
        return 4;
      case "loading":
        return 3;
      case "detached":
        return 2;
      case "idle":
        return 1;
      case "destroyed":
        return 0;
    }
  };
  return rank(next) >= rank(previous) ? next : previous;
};

const evaluatePageLoad = (
  sourceId: string,
  want: string,
  pageLoadByNodeId: ReadonlyMap<string, PageLoadStatus> | undefined,
): RelayEvaluation => {
  const load = pageLoadByNodeId?.get(sourceId);
  if (load === undefined) {
    // Sensor absent — not pending (that would spin the card forever).
    return {
      status: "unknown",
      detail:
        want === "failed"
          ? "page fail not connected yet"
          : "page load not connected yet",
    };
  }
  const target = want === "failed" ? "failed" : "ready";
  if (load === "ready" || load === "failed") {
    const ok = load === target;
    return {
      status: ok ? "satisfied" : "pending",
      detail: ok ? `page ${load}` : `page ${load} (want ${target})`,
    };
  }
  if (load === "loading") {
    return { status: "pending", detail: "page loading" };
  }
  if (load === "detached") {
    // Warm but not attached — not a completed load for watch purposes.
    return { status: "pending", detail: "page detached" };
  }
  // idle / destroyed: no live load outcome to score.
  return {
    status: "unknown",
    detail: load === "destroyed" ? "page session gone" : "page not opened",
  };
};

const evaluateWatchAtom = (
  source: CanvasNode,
  when: Extract<WatchWhen, { readonly word: "completes" | "flagged" }>,
  context?: WatchEvalContext,
): RelayEvaluation => {
  if (when.word === "flagged") {
    const flag = when.flag;
    const has = source.ether?.flags?.includes(flag) ?? false;
    const FLAG_DETAIL = {
      attention: { on: "needs attention", off: "waiting for attention" },
      blocker: { on: "blocked", off: "waiting for blocker" },
      parked: { on: "parked", off: "waiting for parked" },
    } as const;
    const copy = FLAG_DETAIL[flag as keyof typeof FLAG_DETAIL];
    return {
      status: has ? "satisfied" : "pending",
      detail: has
        ? (copy?.on ?? `${flag} on`)
        : (copy?.off ?? `waiting for ${flag}`),
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
    return evaluatePageLoad(source.id, want, context?.pageLoadByNodeId);
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
  context?: WatchEvalContext,
): RelayEvaluation => {
  if (!source) {
    return {
      status: "unknown",
      detail: "watch source gone — reconnect a sink",
    };
  }
  if (when.word === "any") {
    return combineWatchEvaluations(
      when.any.map((atom) => evaluateWatchAtom(source, atom, context)),
    );
  }
  return evaluateWatchAtom(source, when, context);
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
