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
 * and `enqueues` / `wakes` name the action the target accepts. The
 * kernel applies them on home-local fire; task claiming stays in the crew
 * tick.
 */

import type { Canvas } from "./model/canvas";
import type { Node } from "./model/kinds";
import { titleOf } from "./model/title";
import { wireGrant, wireKinds, type Wire } from "./model/wire";
import type { EdgeEffect, WatchWhen } from "./physics/verbs";
import type { WatchRead } from "./work-read";

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

export const isSchedulerNode = (
  node: Pick<Node, "kind"> | undefined,
): boolean => node !== undefined && isSchedulerEntityKind(node.kind);

type Wired = Pick<Canvas, "nodes" | "wires">;

export type EffectEdgeBinding = {
  readonly wire: Wire;
  readonly effect: EdgeEffect;
  readonly source: Node;
  readonly target: Node;
};

/**
 * Scheduler → target wires whose verb is a fire action (`enqueues` /
 * `wakes`). The verb's own order puts the scheduler on `from`, so a
 * downstream wire is exactly one whose source is this scheduler.
 */
export const collectEffectEdgesFrom = (
  canvas: Wired,
  sourceNodeId: string,
): ReadonlyArray<EffectEdgeBinding> => {
  const source = canvas.nodes.get(sourceNodeId as Node["id"]);
  if (source === undefined || !isSchedulerNode(source)) return [];
  const kinds = wireKinds(canvas.nodes.values());
  const out: EffectEdgeBinding[] = [];
  for (const wire of canvas.wires.values()) {
    if (wire.from !== sourceNodeId) continue;
    const effect = wireGrant(wire, kinds)?.does;
    if (!effect) continue;
    const target = canvas.nodes.get(wire.to);
    if (!target) continue;
    out.push({ wire, effect, source, target });
  }
  return out;
};

/** Watch input wires: sink → relay (`when` from the wire's verb). */
export type WatchEdgeBinding = {
  readonly wire: Wire;
  readonly when: WatchWhen;
  readonly source: Node;
  readonly scheduler: Node;
};

export const NO_WATCH_YET_DETAIL =
  "no watch yet — draw a sink in and set fires-when";

/**
 * Watch inputs into a scheduler: the `announces` wires pointing at it.
 *
 * The verb names both the subscription and the predicate — a source announces
 * its own headline event — so there is nothing on the wire to read and nothing
 * to default. Scheduler chaining is not a watch: it rides the trigger cascade
 * (`chains`), and is filtered out here.
 *
 * Multiple matching wires remain OR-combined by the caller.
 */
export const collectWatchEdgesInto = (
  canvas: Wired,
  schedulerNodeId: string,
): ReadonlyArray<WatchEdgeBinding> => {
  const scheduler = canvas.nodes.get(schedulerNodeId as Node["id"]);
  if (scheduler === undefined || !isSchedulerNode(scheduler)) return [];
  const kinds = wireKinds(canvas.nodes.values());
  const out: WatchEdgeBinding[] = [];
  for (const wire of canvas.wires.values()) {
    if (wire.to !== schedulerNodeId) continue;
    const source = canvas.nodes.get(wire.from);
    if (!source) continue;
    const grant = wireGrant(wire, kinds);
    if (grant === undefined || grant.chain === true) continue;
    const when = grant.when;
    if (!when) continue;
    out.push({ wire, when, source, scheduler });
  }
  return out;
};

export type EffectTargetError =
  | "target_not_task_sink"
  | "target_not_agent"
  | "target_missing";

export const validateEffectTarget = (
  effect: EdgeEffect,
  target: Pick<Node, "kind">,
): EffectTargetError | undefined => {
  if (effect.mode === "enqueue_task") {
    // No payload check: `enqueues` carries none, and the kernel builds the
    // brief from the firing scheduler at apply time.
    return target.kind === "task" ? undefined : "target_not_task_sink";
  }
  if (target.kind === "region") return "target_missing";
  if (target.kind !== "agent") return "target_not_agent";
  return undefined;
};

const firstLineOf = (node: Node): string | undefined => {
  const text =
    "label" in node ? node.label : "text" in node ? node.text : undefined;
  const line = text?.trim().split("\n")[0];
  return line === undefined || line.length === 0 ? undefined : line;
};

/** Human label for a scheduler node (its label, else its kind). */
export const schedulerSourceLabel = (source: Node): string =>
  firstLineOf(source) ?? source.kind;

/** Default inject text when the wire carries no authored template. */
export const defaultInjectPromptText = (
  source: Node,
  fireStatus?: string,
): string => {
  const status = fireStatus ? ` (${fireStatus})` : "";
  return `Scheduler ${schedulerSourceLabel(source)} fired${status}`;
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
  /** Agent seats (document-local node ids) with an open blocked or escalate signal. */
  readonly raisedHandNodeIds?: ReadonlySet<string>;
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
  source: Node,
  want: string,
  pageLoadByNodeId: ReadonlyMap<string, PageLoadStatus> | undefined,
): RelayEvaluation => {
  const who = titleOf(source);
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
  source: Node,
  when: Extract<WatchWhen, { readonly word: "completes" | "signals" }>,
  work: WatchRead,
  context?: WatchEvalContext,
): RelayEvaluation => {
  const who = titleOf(source);

  if (when.word === "signals") {
    const raised = context?.raisedHandNodeIds?.has(source.id) ?? false;
    return {
      status: raised ? "satisfied" : "pending",
      // Name the watched seat, never imply the relay itself needs a look.
      detail: raised
        ? `${who} raised a hand`
        : `watching ${who} for blocked or escalate`,
    };
  }

  // completes — kind-specific. equals discriminates variants (ready vs failed).
  const kind = source.kind;
  const want = when.equals ?? "completed";

  if (kind === "task" || kind === "requests") {
    const items = work.itemsOf(source.id);
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
    const board = work.board(source.id);
    if (want === "topic") {
      const n = board?.topics ?? 0;
      return n > 0
        ? { status: "satisfied", detail: `${who}: ${n} topic${n === 1 ? "" : "s"}` }
        : { status: "pending", detail: `${who}: waiting for a topic` };
    }
    const posts = board?.posts ?? 0;
    return posts > 0
      ? {
          status: "satisfied",
          detail: `${who}: ${posts} post${posts === 1 ? "" : "s"}`,
        }
      : { status: "pending", detail: `${who}: waiting for a post` };
  }

  if (kind === "artifacts") {
    const n = work.artifacts(source.id);
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

/**
 * Evaluate a watch predicate against a concrete source node. A canvas holds
 * no work, so what the source holds is asked of `work`.
 */
export const evaluateWatchWhen = (
  source: Node | undefined,
  when: WatchWhen,
  work: WatchRead,
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
      when.any.map((atom) => evaluateWatchAtom(source, atom, work, context)),
    );
  }
  return evaluateWatchAtom(source, when, work, context);
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
