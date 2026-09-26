/**
 * Apply scheduler edge effects after a home-local fire.
 * Task claiming is never done here — only inventory and prompts.
 */

import type { CanvasDoc, CanvasNode } from "@shared/canvas";
import { compileEdgeGrant, edgeKindIndex } from "@shared/canvas";
import {
  defaultEffectTasksCreate,
  type EffectTasksCreate,
} from "@shared/node-insert";
import {
  collectEffectEdgesFrom,
  defaultInjectPromptText,
  schedulerSourceLabel,
  validateEffectTarget,
  type EffectEdgeBinding,
} from "@shared/scheduler-effects";
import { schedulerFeatureEnabled } from "@shared/features";

export type SchedulerFireKind = "cron" | "gauge" | "relay";

export type OverseerFireAuthority = {
  /** Rechecked at every async effect and cascade hop. Pause does not admit. */
  readonly liveGrant: () => Promise<boolean>;
  /**
   * Required in-transaction commit check. mutatePortfolio's callback is
   * synchronous and sees current docs after ensureReady/queue wait; this
   * must refuse without awaiting. Native:
   * `(documents) => !signal.aborted && callerGrantLive(documents, caller)`.
   */
  readonly commitGrantLive: (documents: ReadonlyMap<string, CanvasDoc>) => boolean;
};

export type SchedulerFireEvent = {
  readonly canvasName: string;
  readonly sourceNodeId: string;
  readonly kind: SchedulerFireKind;
  /** Durable identity for at-most-once receipts. */
  readonly fireKey: string;
  /** Sensor level when known (named in the injected prompt). */
  readonly status?: "satisfied" | "pending" | "unknown";
};

export type SchedulerEffectDeps = {
  /** Per-canvas: playing + station role configured. */
  readonly canAutomateCanvas: (canvasName: string) => boolean;
  /** Return true if this fireKey+edgeId was already applied. */
  readonly hasReceipt: (fireKey: string, edgeId: string) => boolean;
  readonly recordReceipt: (fireKey: string, edgeId: string) => void;
  readonly enqueueTask: (input: {
    readonly canvasName: string;
    readonly sinkNodeId: string;
    readonly payload: EffectTasksCreate;
    /** Admitted overseer fire. Pause does not admit; role checks remain. */
    readonly overseer?: OverseerFireAuthority;
  }) => Promise<{ readonly ok: boolean; readonly message?: string }>;
  /** Optional — inject prompt into agent mailbox. Absent = inject effects no-op. */
  readonly injectPrompt?: (input: {
    readonly canvasName: string;
    readonly agentNodeId: string;
    readonly text: string;
    /** Admitted overseer fire. Pause does not admit; role checks remain. */
    readonly overseer?: OverseerFireAuthority;
  }) => Promise<{ readonly ok: boolean; readonly message?: string }>;
};

let effectDeps: SchedulerEffectDeps | undefined;

export const setSchedulerEffectDeps = (
  deps: SchedulerEffectDeps | undefined,
): void => {
  effectDeps = deps;
};

export const __setSchedulerEffectDepsForTest = setSchedulerEffectDeps;

/**
 * Production enqueue/inject admission. Overseer skips pause only; station
 * role and Command Center inject remain. liveGrant is rechecked here.
 */
export const admitSchedulerEffectAutomation = async (input: {
  readonly canvasName: string;
  readonly canAutomateCanvas: (canvasName: string) => boolean;
  readonly stationRole: "" | "command-center" | "remote";
  readonly overseer?: OverseerFireAuthority;
  readonly requireCommandCenter?: boolean;
}): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> => {
  if (input.overseer === undefined) {
    if (!input.canAutomateCanvas(input.canvasName)) {
      return { ok: false, message: "canvas paused or station role unset" };
    }
  } else if (!(await input.overseer.liveGrant())) {
    return { ok: false, message: "overseer grant revoked" };
  } else if (input.stationRole === "") {
    return { ok: false, message: "station role unset" };
  }
  if (
    input.requireCommandCenter === true &&
    input.stationRole !== "command-center"
  ) {
    return { ok: false, message: "inject_prompt requires Command Center" };
  }
  return { ok: true };
};

type ApplyOneOutcome = "applied" | "skipped" | "failed";

/** True when this edge effect ran successfully under the fireKey. */
const applyOne = async (
  canvasName: string,
  binding: EffectEdgeBinding,
  fire: SchedulerFireEvent,
  deps: SchedulerEffectDeps,
  overseer?: OverseerFireAuthority,
): Promise<ApplyOneOutcome> => {
  const err = validateEffectTarget(binding.effect, binding.target);
  if (err) {
    console.error(
      `[kernel] scheduler effect rejected on ${binding.edge.id}: ${err}`,
    );
    return "failed";
  }
  if (deps.hasReceipt(fire.fireKey, binding.edge.id)) return "skipped";
  if (overseer !== undefined && !(await overseer.liveGrant())) return "failed";

  if (binding.effect.mode === "enqueue_task") {
    // `enqueues` is the whole authored fact: the edge carries no payload, so
    // the brief is built here from the scheduler that fired — the same
    // provenance the injected prompt reads.
    const result = await deps.enqueueTask({
      canvasName,
      sinkNodeId: binding.target.id,
      payload: defaultEffectTasksCreate(schedulerSourceLabel(binding.source)),
      ...(overseer !== undefined ? { overseer } : {}),
    });
    if (overseer !== undefined && !(await overseer.liveGrant())) return "failed";
    if (!result.ok) {
      console.error(
        `[kernel] enqueue_task failed on ${binding.edge.id}: ${result.message ?? "unknown"}`,
      );
      return "failed";
    }
    deps.recordReceipt(fire.fireKey, binding.edge.id);
    return "applied";
  }

  // inject_prompt: the only other fire action a scheduler verb compiles to.
  if (!deps.injectPrompt) {
    console.error(
      `[kernel] inject_prompt skipped on ${binding.edge.id}: no inject handler`,
    );
    return "failed";
  }
  const text =
    binding.effect.text?.trim() ||
    defaultInjectPromptText(binding.source, fire.status);
  const result = await deps.injectPrompt({
    canvasName,
    agentNodeId: binding.target.id,
    text,
    ...(overseer !== undefined ? { overseer } : {}),
  });
  if (overseer !== undefined && !(await overseer.liveGrant())) return "failed";
  if (!result.ok) {
    console.error(
      `[kernel] inject_prompt failed on ${binding.edge.id}: ${result.message ?? "unknown"}`,
    );
    return "failed";
  }
  deps.recordReceipt(fire.fireKey, binding.edge.id);
  return "applied";
};

/**
 * Apply outbound `does` edges from one scheduler source, then cascade along
 * directed **trigger** wires to downstream schedulers (cron→relay, relay→relay).
 * Cycle-guarded with a hard depth budget so chains cannot recurse forever.
 */
export type ApplySchedulerFireResult = {
  readonly applied: number;
  readonly cascaded?: number;
  readonly skipped?: "no_deps" | "paused" | "disabled" | "no_effects" | "revoked";
  /** Wired edges that did not apply (downstream refuse, throw, or grant drop). */
  readonly failed?: number;
};

/** Max trigger hops after the root fire (root is depth 0). */
export const SCHEDULER_TRIGGER_CASCADE_MAX_DEPTH = 3;

const schedulerKindForNode = (
  node: CanvasNode | undefined,
): SchedulerFireKind | undefined => {
  const kind = node?.ether?.entity?.kind;
  if (kind === "cron" || kind === "timer") return "cron";
  if (kind === "relay") return "relay";
  if (kind === "watcher" || kind === "gauge") return "gauge";
  return undefined;
};

const schedulerNodeEnabled = (node: CanvasNode | undefined): boolean => {
  const kind = schedulerKindForNode(node);
  return kind !== undefined && schedulerFeatureEnabled(kind);
};

/**
 * Downstream schedulers this one chains into (`chains`, upstream → downstream).
 *
 * The chain fact is read off the compiled grant, the same way watch predicates
 * and fire actions are: a verb word the endpoint pair cannot hold grants
 * nothing, so a stale or hand-edited `chains` never buys a cascade hop.
 */
export const collectTriggerCascadeTargets = (
  doc: CanvasDoc,
  sourceNodeId: string,
): ReadonlyArray<string> => {
  const source = doc.nodes.find((node) => node.id === sourceNodeId);
  if (!schedulerNodeEnabled(source)) return [];

  const kinds = edgeKindIndex(doc);
  const out: string[] = [];
  for (const edge of doc.edges) {
    if (edge.fromNode !== sourceNodeId) continue;
    if (compileEdgeGrant(edge, kinds)?.chain !== true) continue;
    const target = doc.nodes.find((n) => n.id === edge.toNode);
    if (!schedulerNodeEnabled(target)) continue;
    out.push(edge.toNode);
  }
  return out;
};

export const applySchedulerFire = async (
  doc: CanvasDoc,
  fire: SchedulerFireEvent,
  opts?: {
    readonly depth?: number;
    readonly visited?: Set<string>;
    /**
     * Overseer-admitted fire. Pause/play has no bearing. Ordinary automatic
     * and operator Fire now stay paused. liveGrant is rechecked at each
     * async effect and cascade hop — this is not a shared ignorePause path.
     */
    readonly overseer?: OverseerFireAuthority;
  },
): Promise<ApplySchedulerFireResult> => {
  if (!effectDeps) return { applied: 0, skipped: "no_deps" };
  const source = doc.nodes.find((node) => node.id === fire.sourceNodeId);
  if (!schedulerFeatureEnabled(fire.kind) || !schedulerNodeEnabled(source)) {
    return { applied: 0, skipped: "disabled" };
  }
  if (opts?.overseer === undefined && !effectDeps.canAutomateCanvas(fire.canvasName)) {
    return { applied: 0, skipped: "paused" };
  }
  if (opts?.overseer !== undefined && !(await opts.overseer.liveGrant())) {
    return { applied: 0, skipped: "revoked" };
  }
  const depth = opts?.depth ?? 0;
  const visited = opts?.visited ?? new Set<string>();
  if (visited.has(fire.sourceNodeId)) {
    return { applied: 0, skipped: "no_effects" };
  }
  visited.add(fire.sourceNodeId);

  // Scope law: only edges leaving this scheduler whose verb is a fire action.
  const bindings = collectEffectEdgesFrom(doc, fire.sourceNodeId);
  let applied = 0;
  let failed = 0;
  for (const binding of bindings) {
    try {
      const outcome = await applyOne(
        fire.canvasName,
        binding,
        fire,
        effectDeps,
        opts?.overseer,
      );
      if (outcome === "applied") applied += 1;
      else if (outcome === "failed") failed += 1;
    } catch (error) {
      failed += 1;
      console.error(
        `[kernel] scheduler effect threw on ${binding.edge.id}:`,
        error,
      );
    }
  }

  let cascaded = 0;
  if (depth < SCHEDULER_TRIGGER_CASCADE_MAX_DEPTH) {
    for (const targetId of collectTriggerCascadeTargets(
      doc,
      fire.sourceNodeId,
    )) {
      if (visited.has(targetId)) continue;
      const child = await applySchedulerFire(
        doc,
        {
          ...fire,
          sourceNodeId: targetId,
          fireKey: `${fire.fireKey}:cascade:${targetId}`,
        },
        {
          depth: depth + 1,
          visited,
          ...(opts?.overseer !== undefined ? { overseer: opts.overseer } : {}),
        },
      );
      applied += child.applied;
      failed += child.failed ?? 0;
      if (child.skipped === "revoked") failed += 1;
      cascaded += 1 + (child.cascaded ?? 0);
    }
  }

  if (applied === 0 && cascaded === 0 && bindings.length === 0) {
    return { applied: 0, cascaded: 0, skipped: "no_effects" };
  }
  if (failed > 0) {
    return { applied, cascaded, failed };
  }
  return { applied, cascaded };
};

/** True when a node is a schedule carrier (timer body on cron/timer kinds). */
export const nodeHasCronBody = (node: CanvasNode): boolean =>
  node.type === "text" && node.ether?.timer !== undefined;

export const nodeIsRelay = (node: CanvasNode): boolean =>
  node.type === "text" && node.ether?.entity?.kind === "relay";
