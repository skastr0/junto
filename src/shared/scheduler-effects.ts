/**
 * Pure automation-effect plane for schedulers.
 *
 * Product sensors (author these): cron (time) + relay (canvas node projection).
 * Gauge/watcher (hermes stat_threshold) is product-dormant — still evaluated if
 * present on a board, but not a palette product and not “the external sensor.”
 * Hermes adapters = agent fleet join; do not invent a hermes-gauge product story.
 *
 * Watch predicates and fire actions are **compiled from the edge's verb**, not
 * read off the document: `announces` names the predicate the source publishes,
 * and `enqueues` / `wakes` / `flags` name the action the target accepts. The
 * kernel applies them on home-local fire; claim assignment stays the factory
 * tick.
 */

import type { CanvasDoc, CanvasEdge, CanvasNode, EtherFlag } from "./canvas";
import { compileEdgeGrant, edgeKindIndex } from "./canvas";
import {
  defaultEffectBoardCreateTopic,
  defaultEffectTasksCreate,
  effectBoardCreateTopicValid,
  effectBoardPostValid,
} from "./node-insert";
import { resolveSpec, roleOf } from "./physics/kinds";
import type { EdgeEffect, WatchWhen } from "./physics/verbs";

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

/**
 * Scheduler → target edges whose verb is a fire action (`enqueues` / `wakes` /
 * `flags`). The verb's own order puts the scheduler on `fromNode`, so a
 * downstream edge is exactly one whose source is this scheduler.
 */
export const collectEffectEdgesFrom = (
  doc: CanvasDoc,
  sourceNodeId: string,
): ReadonlyArray<EffectEdgeBinding> => {
  const source = doc.nodes.find((node) => node.id === sourceNodeId);
  if (!isSchedulerNode(source)) return [];
  const kinds = edgeKindIndex(doc);
  const out: EffectEdgeBinding[] = [];
  for (const edge of doc.edges) {
    if (edge.fromNode !== sourceNodeId) continue;
    const effect = compileEdgeGrant(edge, kinds)?.does;
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
 * DYING IN SURFACE BATCH — authoring-side default only.
 *
 * The kernel reads the predicate off the compiled verb (`announces`), which is
 * the single table now. This one survives for the renderer draw path until that
 * is cut over.
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

/**
 * Watch inputs into a scheduler: the `announces` edges pointing at it.
 *
 * The verb names both the subscription and the predicate — a source announces
 * its own headline event — so there is nothing on the edge to read and nothing
 * to default. Scheduler chaining is not a watch: it rides the trigger cascade
 * (`chains`), and is filtered out here.
 *
 * Multiple matching edges remain OR-combined by the caller.
 */
export const collectWatchEdgesInto = (
  doc: CanvasDoc,
  schedulerNodeId: string,
): ReadonlyArray<WatchEdgeBinding> => {
  const scheduler = doc.nodes.find((node) => node.id === schedulerNodeId);
  if (!isSchedulerNode(scheduler)) return [];
  const kinds = edgeKindIndex(doc);
  const out: WatchEdgeBinding[] = [];
  for (const edge of doc.edges) {
    if (edge.toNode !== schedulerNodeId) continue;
    const source = doc.nodes.find((node) => node.id === edge.fromNode);
    if (!source) continue;
    const grant = compileEdgeGrant(edge, kinds);
    if (grant === undefined || grant.chain === true) continue;
    const when = grant.when;
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
    // No payload check: `enqueues` carries none, and the kernel builds the
    // brief from the firing scheduler at apply time.
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

/**
 * DYING IN SURFACE BATCH — authoring-side draw helper only. The kernel reads
 * the fire action off the compiled verb.
 */
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

/** First line of node text, else kind — for operator-facing watch copy. */
const watchSourceLabel = (source: CanvasNode): string => {
  if (source.type === "text" && source.text.trim().length > 0) {
    return source.text.trim().split("\n")[0]!;
  }
  return source.ether?.entity?.kind ?? "source";
};

/**
 * Flag names as product words (not wire vocabulary).
 * The relay is waiting on the *connected* node having this mark.
 */
const FLAG_PRODUCT = {
  attention: "needs attention",
  blocker: "blocker",
  parked: "parked",
} as const;

const evaluatePageLoad = (
  source: CanvasNode,
  want: string,
  pageLoadByNodeId: ReadonlyMap<string, PageLoadStatus> | undefined,
): RelayEvaluation => {
  const who = watchSourceLabel(source);
  const load = pageLoadByNodeId?.get(source.id);
  if (load === undefined) {
    // Sensor absent — not pending (that would spin the card forever).
    return {
      status: "unknown",
      detail:
        want === "failed"
          ? `open ${who} to watch for load failure`
          : `open ${who} to watch for load`,
    };
  }
  const target = want === "failed" ? "failed" : "ready";
  if (load === "ready" || load === "failed") {
    const ok = load === target;
    return {
      status: ok ? "satisfied" : "pending",
      detail: ok
        ? want === "failed"
          ? `${who} failed to load`
          : `${who} loaded`
        : want === "failed"
          ? `${who} loaded (watching for fail)`
          : `${who} failed (watching for load)`,
    };
  }
  if (load === "loading") {
    return { status: "pending", detail: `${who} loading` };
  }
  if (load === "detached") {
    // Not a live load outcome — quiet, not "still waiting" forever-spin.
    return {
      status: "unknown",
      detail: `${who} session idle`,
    };
  }
  return {
    status: "unknown",
    detail:
      load === "destroyed" ? `${who} session closed` : `${who} not opened`,
  };
};

const evaluateWatchAtom = (
  source: CanvasNode,
  when: Extract<WatchWhen, { readonly word: "completes" | "flagged" }>,
  context?: WatchEvalContext,
): RelayEvaluation => {
  const who = watchSourceLabel(source);

  if (when.word === "flagged") {
    const flag = when.flag;
    const has = source.ether?.flags?.includes(flag) ?? false;
    const mark =
      FLAG_PRODUCT[flag as keyof typeof FLAG_PRODUCT] ?? String(flag);
    return {
      status: has ? "satisfied" : "pending",
      // Name the watched node — never imply the *relay* needs attention.
      detail: has
        ? `${who} is marked ${mark}`
        : `watching ${who} for ${mark}`,
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
    const lane = kind === "requests" ? "request" : "task";
    if (items.length === 0) {
      return { status: "pending", detail: `${who} has no ${lane}s yet` };
    }
    if (when.itemId) {
      const item = items.find((task) => task.id === when.itemId);
      if (!item) {
        return {
          status: "unknown",
          detail: `${who}: ${lane} gone`,
        };
      }
      const ok = item.state === want;
      return {
        status: ok ? "satisfied" : "pending",
        detail: ok
          ? `${who}: ${lane} ${want}`
          : `${who}: waiting for ${lane} to ${want}`,
      };
    }
    const match = items.find((task) => task.state === want);
    if (match) {
      return {
        status: "satisfied",
        detail: `${who}: a ${lane} ${want}`,
      };
    }
    return {
      status: "pending",
      detail: `${who}: waiting for a ${lane} to ${want}`,
    };
  }

  if (kind === "page") {
    return evaluatePageLoad(source, want, context?.pageLoadByNodeId);
  }

  if (kind === "board") {
    const board = source.ether?.board;
    if (want === "topic") {
      const n = board?.topics?.length ?? 0;
      return n > 0
        ? { status: "satisfied", detail: `${who}: ${n} topic${n === 1 ? "" : "s"}` }
        : { status: "pending", detail: `${who}: waiting for a topic` };
    }
    const posts =
      board?.topics?.reduce(
        (sum, t) => sum + (typeof t.postCount === "number" ? t.postCount : 0),
        0,
      ) ?? 0;
    return posts > 0
      ? {
          status: "satisfied",
          detail: `${who}: ${posts} post${posts === 1 ? "" : "s"}`,
        }
      : { status: "pending", detail: `${who}: waiting for a post` };
  }

  if (kind === "artifacts") {
    const n = source.ether?.artifacts?.items?.length ?? 0;
    return n > 0
      ? {
          status: "satisfied",
          detail: `${who}: ${n} artifact${n === 1 ? "" : "s"}`,
        }
      : { status: "pending", detail: `${who}: waiting for an artifact` };
  }

  return {
    status: "unknown",
    detail: `can't watch ${who} for completes`,
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
