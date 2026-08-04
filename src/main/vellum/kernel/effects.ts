/**
 * Apply scheduler edge effects after a home-local fire.
 * Claim assignment is never done here — only inventory / flags.
 */

import type { CanvasDoc, CanvasNode, EtherFlag } from "@shared/canvas";
import {
  collectEffectEdgesFrom,
  defaultInjectPromptText,
  resolveMirrorFlagEnabled,
  validateEffectTarget,
  type EffectEdgeBinding,
} from "@shared/scheduler-effects";

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
    readonly brief: string;
    readonly reason?: string;
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
    const result = await deps.enqueueTask({
      canvasName,
      sinkNodeId: binding.target.id,
      brief: binding.effect.brief,
      ...(binding.effect.reason !== undefined
        ? { reason: binding.effect.reason }
        : {}),
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
 * Apply outbound `does` edges from one scheduler source only.
 * Never walks other nodes, trigger chains, or watch edges.
 */
export type ApplySchedulerFireResult = {
  readonly applied: number;
  readonly skipped?: "no_deps" | "paused" | "no_effects";
};

export const applySchedulerFire = async (
  doc: CanvasDoc,
  fire: SchedulerFireEvent,
): Promise<ApplySchedulerFireResult> => {
  if (!effectDeps) return { applied: 0, skipped: "no_deps" };
  if (!effectDeps.canAutomateCanvas(fire.canvasName)) {
    return { applied: 0, skipped: "paused" };
  }
  // Scope law: only edges with fromNode === sourceNodeId and ether.does.
  const bindings = collectEffectEdgesFrom(doc, fire.sourceNodeId);
  if (bindings.length === 0) return { applied: 0, skipped: "no_effects" };
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
  return { applied };
};

/** True when a node is a schedule carrier (timer body on cron/timer kinds). */
export const nodeHasCronBody = (node: CanvasNode): boolean =>
  node.type === "text" && node.ether?.timer !== undefined;

export const nodeIsRelay = (node: CanvasNode): boolean =>
  node.type === "text" && node.ether?.entity?.kind === "relay";
