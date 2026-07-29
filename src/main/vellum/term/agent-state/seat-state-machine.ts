/**
 * Per-binding seat state machine.
 * Feeds ObserverGridSnapshot → debounced AgentSeatStateEvent stream.
 *
 * Debounce (herdr design values, reimplemented):
 * - base tick 300ms (caller cadence — we accept feeds as they arrive)
 * - only low-confidence Working→Idle is held
 * - 3 consecutive confirmations OR a real 700ms cap timer
 * - visible idle / attention publish immediately
 * - never publish idle while visibleAttention is true
 */

import type {
  AgentSeatHookState,
  AgentSeatState,
  AgentSeatStateEvent,
} from "../../../../shared/agent-seat-state";
import type { ObserverGridSnapshot } from "../observer/types";
import { evaluate, type EvaluateOptions } from "./engine";
import type { HarnessId } from "../../../../shared/managed-terminal-templates";
import type { SeatEvaluation } from "./types";

/** Debounce constants — ported from herdr agent_detection design (values only). */
export const SEAT_DEBOUNCE = {
  /** Confirmations required for low-confidence working→idle. */
  pendingIdleConfirmations: 3,
  /** Hard ceiling on the hold (ms). */
  pendingIdleCapMs: 700,
  /** Sustained attention heartbeat re-publish (ms). */
  stableVisibleRefreshMs: 800,
} as const;

export type SeatMachineOptions = {
  readonly now?: () => number;
  readonly onEvent?: (event: AgentSeatStateEvent) => void;
};

export type SeatBindingConfig = {
  readonly harness: HarnessId | string;
  readonly epoch?: string;
};

type BindingSlot = {
  harness: HarnessId | string;
  epoch: string;
  state: AgentSeatState;
  reason: string;
  confidence: "high" | "low";
  visibleIdle: boolean;
  visibleWorking: boolean;
  visibleAttention: boolean;
  lastPublishedAt: number;
  hookState: AgentSeatHookState | null;
  /** Pending low-confidence working→idle. */
  pendingIdle: null | {
    firstAt: number;
    confirmations: number;
    reason: string;
    evaluation: SeatEvaluation;
    timer: ReturnType<typeof setTimeout> | undefined;
  };
  lastEval: SeatEvaluation | null;
};

export type SeatStateListener = (event: AgentSeatStateEvent) => void;

export class SeatStateMachine {
  private readonly slots = new Map<string, BindingSlot>();
  private readonly listeners = new Set<SeatStateListener>();
  private readonly now: () => number;
  private readonly onEvent?: (event: AgentSeatStateEvent) => void;

  constructor(opts: SeatMachineOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.onEvent = opts.onEvent;
  }

  /** Register or reconfigure a binding. Resets state on harness/epoch change. */
  bind(bindingId: string, config: SeatBindingConfig): void {
    const prior = this.slots.get(bindingId);
    const epoch = config.epoch ?? prior?.epoch ?? "";
    if (
      prior &&
      prior.harness === config.harness &&
      prior.epoch === epoch
    ) {
      return;
    }
    if (prior) this.clearPendingIdle(prior);
    const slot: BindingSlot = {
      harness: config.harness,
      epoch,
      state: "unknown",
      reason:
        prior?.epoch !== undefined && prior.epoch !== epoch
          ? "generation_replaced"
          : prior
            ? "binding_reconfigured"
            : "generation_bound",
      confidence: "low",
      visibleIdle: false,
      visibleWorking: false,
      visibleAttention: false,
      lastPublishedAt: 0,
      // Hook evidence belongs to one process generation. A replacement starts
      // unknown and must earn fresh activity from its own observer stream.
      hookState:
        prior?.epoch === epoch
          ? prior.hookState
          : null,
      pendingIdle: null,
      lastEval: null,
    };
    this.slots.set(bindingId, slot);
    this.maybePublish(
      slot,
      bindingId,
      this.lifecycleEvaluation(slot, "unknown", slot.reason, "low"),
      true,
    );
  }

  /**
   * Invalidate exactly one live generation. An old generation's late exit
   * cannot clear a replacement that already owns the binding.
   */
  unbind(
    bindingId: string,
    options: {
      readonly epoch?: string;
      readonly reason?: string;
    } = {},
  ): AgentSeatStateEvent | null {
    const slot = this.slots.get(bindingId);
    if (!slot) return null;
    if (
      options.epoch !== undefined &&
      slot.epoch !== options.epoch
    ) {
      return null;
    }
    this.clearPendingIdle(slot);
    const event = this.maybePublish(
      slot,
      bindingId,
      this.lifecycleEvaluation(
        slot,
        "gone",
        options.reason ?? "generation_unbound",
        "high",
      ),
      true,
    );
    this.slots.delete(bindingId);
    return event;
  }

  setHookState(
    bindingId: string,
    hookState: AgentSeatHookState | null,
  ): void {
    const slot = this.ensure(bindingId, undefined);
    slot.hookState = hookState;
  }

  getState(bindingId: string): AgentSeatState | undefined {
    return this.slots.get(bindingId)?.state;
  }

  /**
   * Current live projection for renderer (re)hydration.
   *
   * Slots created only by an early hook observation have never published and
   * therefore are not presentation truth yet. Bound seats publish immediately,
   * so every live managed seat appears here with its last authoritative state.
   */
  currentEvents(): ReadonlyArray<AgentSeatStateEvent> {
    return [...this.slots.entries()]
      .filter(([, slot]) => slot.lastPublishedAt > 0)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([bindingId, slot]) => ({
        bindingId,
        epoch: slot.epoch,
        state: slot.state,
        reason: slot.reason,
        confidence: slot.confidence,
        at: slot.lastPublishedAt,
        harness: slot.harness,
      }));
  }

  getSlot(
    bindingId: string,
  ): Readonly<
    Pick<
      BindingSlot,
      | "state"
      | "reason"
      | "confidence"
      | "visibleIdle"
      | "visibleWorking"
      | "visibleAttention"
      | "harness"
      | "epoch"
    >
  > | undefined {
    const s = this.slots.get(bindingId);
    if (!s) return undefined;
    return {
      state: s.state,
      reason: s.reason,
      confidence: s.confidence,
      visibleIdle: s.visibleIdle,
      visibleWorking: s.visibleWorking,
      visibleAttention: s.visibleAttention,
      harness: s.harness,
      epoch: s.epoch,
    };
  }

  subscribe(listener: SeatStateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Feed an observer snapshot. Returns the event if one was published, else null.
   */
  feed(
    snapshot: ObserverGridSnapshot,
    opts?: Partial<EvaluateOptions> & { harness?: HarnessId | string },
  ): AgentSeatStateEvent | null {
    const bindingId = snapshot.bindingId;
    let slot = this.ensure(bindingId, opts?.harness);
    if (snapshot.epoch && slot.epoch && snapshot.epoch !== slot.epoch) {
      // Epoch mismatch — publish replacement before evaluating the new screen.
      this.bind(bindingId, {
        harness: opts?.harness ?? slot.harness,
        epoch: snapshot.epoch,
      });
      slot = this.ensure(bindingId, opts?.harness);
    } else if (snapshot.epoch && !slot.epoch) {
      slot.epoch = snapshot.epoch;
    }

    if (opts?.harness) slot.harness = opts.harness;

    const evalOpts: EvaluateOptions = {
      harness: slot.harness,
      hookState: opts?.hookState !== undefined ? opts.hookState : slot.hookState,
      pack: opts?.pack,
      now: this.now(),
    };

    const next = evaluate(snapshot, evalOpts);
    slot.lastEval = next;

    // Viewer / menu: hold prior published state entirely.
    if (next.skipStateUpdate) {
      return null;
    }

    // Hard gate: never publish idle while attention chrome is visible.
    if (next.visibleAttention && next.state === "idle") {
      // Should not happen with well-formed packs; coerce to attention.
      return this.maybePublish(slot, bindingId, {
        ...next,
        state: "attention",
        reason: "coerced_idle_with_visible_attention",
        confidence: "high",
      });
    }

    const hold = shouldHoldWorkingToIdle(slot, next);
    if (hold) {
      const t = this.now();
      if (!slot.pendingIdle) {
        const pending: NonNullable<BindingSlot["pendingIdle"]> = {
          firstAt: t,
          confirmations: 1,
          reason: next.reason,
          evaluation: next,
          timer: undefined,
        };
        pending.timer = setTimeout(() => {
          if (slot.pendingIdle !== pending) return;
          slot.pendingIdle = null;
          this.maybePublish(
            slot,
            bindingId,
            {
              ...pending.evaluation,
              reason: `${pending.reason}+debounced_idle`,
            },
          );
        }, SEAT_DEBOUNCE.pendingIdleCapMs);
        (
          pending.timer as ReturnType<typeof setTimeout> & {
            unref?: () => void;
          }
        ).unref?.();
        slot.pendingIdle = pending;
        return null;
      }
      slot.pendingIdle.confirmations += 1;
      const elapsed = t - slot.pendingIdle.firstAt;
      const confirmed =
        slot.pendingIdle.confirmations >=
        SEAT_DEBOUNCE.pendingIdleConfirmations;
      const capped = elapsed >= SEAT_DEBOUNCE.pendingIdleCapMs;
      if (!confirmed && !capped) {
        return null;
      }
      // Release hold → publish idle.
      const released: SeatEvaluation = {
        ...next,
        reason: `${next.reason}+debounced_idle`,
      };
      this.clearPendingIdle(slot);
      return this.maybePublish(slot, bindingId, released);
    }

    // Any non-held transition clears pending idle.
    this.clearPendingIdle(slot);
    return this.maybePublish(slot, bindingId, next);
  }

  /** Force-publish current evaluation (e.g. process exit → idle). */
  force(
    bindingId: string,
    state: AgentSeatState,
    reason: string,
    confidence: "high" | "low" = "high",
  ): AgentSeatStateEvent {
    const slot = this.ensure(bindingId, undefined);
    this.clearPendingIdle(slot);
    const evalLike = this.lifecycleEvaluation(
      slot,
      state,
      reason,
      confidence,
    );
    return this.maybePublish(slot, bindingId, evalLike, true)!;
  }

  dispose(): void {
    for (const slot of this.slots.values()) this.clearPendingIdle(slot);
    this.slots.clear();
    this.listeners.clear();
  }

  private ensure(
    bindingId: string,
    harness: HarnessId | string | undefined,
  ): BindingSlot {
    let slot = this.slots.get(bindingId);
    if (!slot) {
      slot = {
        harness: harness ?? "unknown",
        epoch: "",
        state: "unknown",
        reason: "unbound",
        confidence: "low",
        visibleIdle: false,
        visibleWorking: false,
        visibleAttention: false,
        lastPublishedAt: 0,
        hookState: null,
        pendingIdle: null,
        lastEval: null,
      };
      this.slots.set(bindingId, slot);
    }
    return slot;
  }

  private maybePublish(
    slot: BindingSlot,
    bindingId: string,
    next: SeatEvaluation,
    force = false,
  ): AgentSeatStateEvent | null {
    const t = this.now();
    const stateChanged = slot.state !== next.state;
    const flagsChanged =
      slot.visibleIdle !== next.visibleIdle ||
      slot.visibleWorking !== next.visibleWorking ||
      slot.visibleAttention !== next.visibleAttention;
    const reasonChanged = slot.reason !== next.reason;
    const heartbeat =
      next.visibleAttention &&
      slot.state === "attention" &&
      t - slot.lastPublishedAt >= SEAT_DEBOUNCE.stableVisibleRefreshMs;

    if (!force && !stateChanged && !flagsChanged && !heartbeat) {
      // Keep reason fresh without event spam when nothing material changed.
      if (reasonChanged) slot.reason = next.reason;
      return null;
    }

    slot.state = next.state;
    slot.reason = next.reason;
    slot.confidence = next.confidence;
    slot.visibleIdle = next.visibleIdle;
    slot.visibleWorking = next.visibleWorking;
    slot.visibleAttention = next.visibleAttention;
    slot.lastPublishedAt = t;

    const event: AgentSeatStateEvent = {
      bindingId,
      epoch: slot.epoch,
      state: next.state,
      reason: next.reason,
      confidence: next.confidence,
      at: t,
      harness:
        typeof slot.harness === "string" ? slot.harness : undefined,
    };

    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("[seat-state] listener failed:", err);
      }
    }
    this.onEvent?.(event);
    return event;
  }

  private clearPendingIdle(slot: BindingSlot): void {
    if (!slot.pendingIdle) return;
    if (slot.pendingIdle.timer !== undefined) {
      clearTimeout(slot.pendingIdle.timer);
    }
    slot.pendingIdle = null;
  }

  private lifecycleEvaluation(
    slot: BindingSlot,
    state: AgentSeatState,
    reason: string,
    confidence: "high" | "low",
  ): SeatEvaluation {
    return {
      state,
      reason,
      priority: 0,
      confidence,
      visibleIdle: state === "idle",
      visibleWorking: state === "working",
      visibleAttention: state === "attention",
      skipStateUpdate: false,
      ruleId: null,
      harness:
        typeof slot.harness === "string" &&
        (slot.harness === "claude" ||
          slot.harness === "codex" ||
          slot.harness === "grok" ||
          slot.harness === "hermes")
          ? slot.harness
          : "claude",
    };
  }
}

/**
 * Hold only low-confidence Working→Idle drops.
 * Visible idle chrome and any attention publish immediately.
 */
export const shouldHoldWorkingToIdle = (
  slot: {
    state: AgentSeatState;
  },
  next: SeatEvaluation,
): boolean => {
  if (slot.state !== "working") return false;
  if (next.state !== "idle") return false;
  if (next.visibleIdle) return false;
  if (next.visibleAttention) return false;
  if (next.confidence === "high" && next.visibleIdle) return false;
  // Low-confidence idle (fallback / non-visible) is held.
  return next.confidence === "low" || !next.visibleIdle;
};
