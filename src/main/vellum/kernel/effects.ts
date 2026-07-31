/**
 * Apply scheduler edge effects after a home-local fire.
 * Claim assignment is never done here — only inventory / flags.
 */

import type { CanvasDoc, CanvasNode, EtherFlag } from "@shared/canvas";
import {
  collectEffectEdgesFrom,
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
  readonly effectsEnabled: () => boolean;
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
  ) => void;
};

let effectDeps: SchedulerEffectDeps | undefined;

export const setSchedulerEffectDeps = (
  deps: SchedulerEffectDeps | undefined,
): void => {
  effectDeps = deps;
};

export const __setSchedulerEffectDepsForTest = setSchedulerEffectDeps;

const applyOne = async (
  canvasName: string,
  binding: EffectEdgeBinding,
  fire: SchedulerFireEvent,
  deps: SchedulerEffectDeps,
): Promise<void> => {
  const err = validateEffectTarget(binding.effect, binding.target);
  if (err) {
    console.error(
      `[kernel] scheduler effect rejected on ${binding.edge.id}: ${err}`,
    );
    return;
  }
  if (deps.hasReceipt(fire.fireKey, binding.edge.id)) return;

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
      return;
    }
    deps.recordReceipt(fire.fireKey, binding.edge.id);
    return;
  }

  const enabled = resolveMirrorFlagEnabled(
    binding.effect.enabled,
    fire.status ?? "satisfied",
  );
  if (enabled === undefined) return;
  deps.setFlag(
    canvasName,
    binding.target.id,
    binding.effect.flag,
    enabled,
  );
  deps.recordReceipt(fire.fireKey, binding.edge.id);
};

export const applySchedulerFire = async (
  doc: CanvasDoc,
  fire: SchedulerFireEvent,
): Promise<void> => {
  if (!effectDeps || !effectDeps.effectsEnabled()) return;
  const bindings = collectEffectEdgesFrom(doc, fire.sourceNodeId);
  if (bindings.length === 0) return;
  for (const binding of bindings) {
    try {
      await applyOne(fire.canvasName, binding, fire, effectDeps);
    } catch (error) {
      console.error(
        `[kernel] scheduler effect threw on ${binding.edge.id}:`,
        error,
      );
    }
  }
};

/** True when a node is a schedule carrier (timer body on cron/timer kinds). */
export const nodeHasCronBody = (node: CanvasNode): boolean =>
  node.type === "text" && node.ether?.timer !== undefined;

export const nodeHasRelayBody = (node: CanvasNode): boolean =>
  node.type === "text" && node.ether?.relay !== undefined;
