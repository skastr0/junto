/**
 * Per-binding seat state machine.
 * Feeds ObserverGridSnapshot → debounced AgentSeatStateEvent stream.
 *
 * Debounce (herdr design values, reimplemented):
 * - base tick 300ms (caller cadence — we accept feeds as they arrive)
 * - only low-confidence Working→Idle is held
 * - 3 consecutive confirmations OR 700ms cap
 * - 100ms recheck while holding (caller may feed faster; we time by clock)
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
    this.slots.set(bindingId, {
      harness: config.harness,
      epoch,
      state: "unknown",
      reason: "bound",
      confidence: "low",
      visibleIdle: false,
      visibleWorking: false,
      visibleAttention: false,
      lastPublishedAt: 0,
      hookState: prior?.hookState ?? null,
      pendingIdle: null,
      lastEval: null,
    });
  }

  unbind(bindingId: string): void {
    this.slots.delete(bindingId);
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
    const slot = this.ensure(bindingId, opts?.harness);
    if (snapshot.epoch && slot.epoch && snapshot.epoch !== slot.epoch) {
      // Epoch mismatch — rebind to the new generation.
      slot.epoch = snapshot.epoch;
      slot.state = "unknown";
      slot.pendingIdle = null;
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
        slot.pendingIdle = {
          firstAt: t,
          confirmations: 1,
          reason: next.reason,
        };
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
      slot.pendingIdle = null;
      return this.maybePublish(slot, bindingId, released);
    }

    // Any non-held transition clears pending idle.
    slot.pendingIdle = null;
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
    slot.pendingIdle = null;
    const evalLike: SeatEvaluation = {
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
    return this.maybePublish(slot, bindingId, evalLike, true)!;
  }

  dispose(): void {
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
