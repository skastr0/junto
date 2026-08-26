/**
 * Apply scheduler edge effects after a home-local fire.
 * Claim assignment is never done here — only inventory / flags.
 */

import type { CanvasDoc, CanvasNode, EtherFlag } from "@shared/canvas";
import { compileEdgeGrant, edgeKindIndex } from "@shared/canvas";
import {
  defaultEffectTasksCreate,
  type EffectTasksCreate,
} from "@shared/node-insert";
import {
  collectEffectEdgesFrom,
  defaultInjectPromptText,
  resolveMirrorFlagEnabled,
  schedulerSourceLabel,
  validateEffectTarget,
  type EffectEdgeBinding,
} from "@shared/scheduler-effects";
import { schedulerFeatureEnabled } from "@shared/features";

export type SchedulerFireKind = "cron" | "gauge" | "relay";

export type SchedulerFireEvent = {
  readonly canvasName: string;
  readonly sourceNodeId: string;
  readonly kind: SchedulerFireKind;
  /** Durable identity for at-most-once receipts. */
  readonly fireKey: string;
  /** Sensor level when known (for mirror flags). */
  readonly status?: "satisfied" | "pending" | "unknown";
};

export type SchedulerEffectDeps = {
  /** Per-canvas: playing + station role configured. */
  readonly canAutomateCanvas: (canvasName: string) => boolean;
  /** Document flag effects (set_flag / flagOnUnsatisfied) are Command Center-only. */
  readonly canApplyFlagEffects: () => boolean;
  /** Return true if this fireKey+edgeId was already applied. */
  readonly hasReceipt: (fireKey: string, edgeId: string) => boolean;
  readonly recordReceipt: (fireKey: string, edgeId: string) => void;
  readonly enqueueTask: (input: {
    readonly canvasName: string;
    readonly sinkNodeId: string;
    readonly payload: EffectTasksCreate;
  }) => Promise<{ readonly ok: boolean; readonly message?: string }>;
  readonly setFlag: (
    canvasName: string,
    nodeId: string,
    flag: EtherFlag,
    enabled: boolean,
  ) => Promise<{ readonly ok: boolean; readonly message?: string }>;
  /** Optional — inject prompt into agent mailbox. Absent = inject effects no-op. */
  readonly injectPrompt?: (input: {
    readonly canvasName: string;
    readonly agentNodeId: string;
    readonly text: string;
  }) => Promise<{ readonly ok: boolean; readonly message?: string }>;
};

let effectDeps: SchedulerEffectDeps | undefined;

export const setSchedulerEffectDeps = (
  deps: SchedulerEffectDeps | undefined,
): void => {
  effectDeps = deps;
};

export const __setSchedulerEffectDepsForTest = setSchedulerEffectDeps;

/** True when this edge effect ran successfully under the fireKey. */
const applyOne = async (
  canvasName: string,
  binding: EffectEdgeBinding,
  fire: SchedulerFireEvent,
  deps: SchedulerEffectDeps,
): Promise<boolean> => {
  const err = validateEffectTarget(binding.effect, binding.target);
  if (err) {
    console.error(
      `[kernel] scheduler effect rejected on ${binding.edge.id}: ${err}`,
    );
    return false;
  }
  if (deps.hasReceipt(fire.fireKey, binding.edge.id)) return false;

  if (binding.effect.mode === "enqueue_task") {
    // `enqueues` is the whole authored fact: the edge carries no payload, so
    // the brief is built here from the scheduler that fired — the same
    // provenance the injected prompt reads.
    const result = await deps.enqueueTask({
      canvasName,
      sinkNodeId: binding.target.id,
      payload: defaultEffectTasksCreate(schedulerSourceLabel(binding.source)),
    });
    if (!result.ok) {
      console.error(
        `[kernel] enqueue_task failed on ${binding.edge.id}: ${result.message ?? "unknown"}`,
      );
      return false;
    }
    deps.recordReceipt(fire.fireKey, binding.edge.id);
    return true;
  }

  if (binding.effect.mode === "inject_prompt") {
    if (!deps.injectPrompt) {
      console.error(
        `[kernel] inject_prompt skipped on ${binding.edge.id}: no inject handler`,
      );
      return false;
    }
    const text =
      binding.effect.text?.trim() ||
      defaultInjectPromptText(binding.source, fire.status);
    const result = await deps.injectPrompt({
      canvasName,
      agentNodeId: binding.target.id,
      text,
    });
    if (!result.ok) {
      console.error(
        `[kernel] inject_prompt failed on ${binding.edge.id}: ${result.message ?? "unknown"}`,
      );
      return false;
    }
    deps.recordReceipt(fire.fireKey, binding.edge.id);
    return true;
  }

  if (!deps.canApplyFlagEffects()) {
    console.error(
      `[kernel] set_flag skipped on ${binding.edge.id}: durable flag effects require Command Center`,
    );
    return false;
  }

  const enabled = resolveMirrorFlagEnabled(
    binding.effect.enabled,
    fire.status ?? "satisfied",
  );
  if (enabled === undefined) return false;
  const flagResult = await deps.setFlag(
    canvasName,
    binding.target.id,
    binding.effect.flag,
    enabled,
  );
  if (!flagResult.ok) {
    console.error(
      `[kernel] set_flag failed on ${binding.edge.id}: ${flagResult.message ?? "unknown"}`,
    );
    return false;
  }
  deps.recordReceipt(fire.fireKey, binding.edge.id);
  return true;
};

/**
 * Apply outbound `does` edges from one scheduler source, then cascade along
 * directed **trigger** wires to downstream schedulers (cron→relay, relay→relay).
 * Cycle-guarded with a hard depth budget so chains cannot recurse forever.
 */
export type ApplySchedulerFireResult = {
  readonly applied: number;
  readonly cascaded?: number;
  readonly skipped?: "no_deps" | "paused" | "disabled" | "no_effects";
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
  },
): Promise<ApplySchedulerFireResult> => {
  if (!effectDeps) return { applied: 0, skipped: "no_deps" };
  const source = doc.nodes.find((node) => node.id === fire.sourceNodeId);
  if (!schedulerFeatureEnabled(fire.kind) || !schedulerNodeEnabled(source)) {
    return { applied: 0, skipped: "disabled" };
  }
  if (!effectDeps.canAutomateCanvas(fire.canvasName)) {
    return { applied: 0, skipped: "paused" };
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
  for (const binding of bindings) {
    try {
      if (await applyOne(fire.canvasName, binding, fire, effectDeps)) {
        applied += 1;
      }
    } catch (error) {
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
        { depth: depth + 1, visited },
      );
      applied += child.applied;
      cascaded += 1 + (child.cascaded ?? 0);
    }
  }

  if (applied === 0 && cascaded === 0 && bindings.length === 0) {
    return { applied: 0, cascaded: 0, skipped: "no_effects" };
  }
  return { applied, cascaded };
};

/** True when a node is a schedule carrier (timer body on cron/timer kinds). */
export const nodeHasCronBody = (node: CanvasNode): boolean =>
  node.type === "text" && node.ether?.timer !== undefined;

export const nodeIsRelay = (node: CanvasNode): boolean =>
  node.type === "text" && node.ether?.entity?.kind === "relay";
