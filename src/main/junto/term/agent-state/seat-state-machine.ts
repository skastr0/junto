/**
 * Per-binding seat state machine.
 * Feeds ObserverGridSnapshot → debounced AgentSeatStateEvent stream.
 *
 * Debounce:
 * - base tick 300ms (caller cadence — we accept feeds as they arrive)
 * - only low-confidence Working→Idle is held
 * - 3 consecutive confirmations OR a real 700ms cap timer
 * - visible idle / attention publish immediately
 * - never publish idle while visibleAttention is true
 *
 * Each slot folds the fact behind every published decision into a
 * `SeatSnapshot` (shared/harness-domain reduceSeat), and the state it
 * publishes is the projection of that snapshot (projection.ts). Debounce and
 * arbitration still decide here which decision is published; the snapshot is
 * what the decision means.
 */

import {
  encodeAgentSeatStatus,
  type AgentSeatHookState,
  type AgentSeatState,
  type AgentSeatStateEvent,
  type AgentSeatStatusWire,
} from "../../../../shared/agent-seat-state";
import type { ObserverGridSnapshot } from "../observer/types";
import { evaluate, type EvaluateOptions } from "./engine";
import {
  isHarnessId,
  type HarnessId,
} from "../../../../shared/managed-terminal-templates";
import type { SeatEvaluation } from "./types";
import {
  initialSnapshot,
  reduceSeat,
  sourceRank,
  topNeed,
  type BindingId,
  type Fidelity,
  type SeatSignal,
  type SeatSnapshot,
  type SignalSource,
} from "../../../../shared/harness-domain";
import { projectAgentSeatState } from "./projection";
import { signalForState } from "./screen-signal";

/** Debounce constants for agent-state detection. */
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

/** A fact for a forced state: what it means, and who said it. */
export type SeatFact = {
  readonly signal: SeatSignal;
  readonly source: SignalSource;
  readonly fidelity: Fidelity;
};

export type SeatBindingConfig = {
  readonly harness: HarnessId | string;
  readonly epoch?: string;
  /** The zone the seat's process runs in (its TZ); clock times on its screen read in it. */
  readonly timeZone?: string;
};

type BindingSlot = {
  /** The key this slot is published under. Moves with `rekey`. */
  key: string;
  harness: HarnessId | string;
  epoch: string;
  timeZone?: string;
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
  /** Every published decision's fact, folded. `state` is its projection. */
  snapshot: SeatSnapshot;
  /** The screen facts the last frame showed, so each folds once, on appearing. */
  factKeys: ReadonlySet<string>;
};

export type SeatStateListener = (event: AgentSeatStateEvent) => void;

export class SeatStateMachine {
  private readonly slots = new Map<string, BindingSlot>();
  /**
   * Last published event of a retired generation, per binding.
   *
   * `unbind` publishes `gone` and then drops the slot, so the published event
   * is the only surviving record that a generation exited. Retaining it here is
   * what lets a post-exit observation answer at all: a wait that starts after
   * the exit would otherwise have nothing to match and could only time out.
   *
   * One tombstone per binding, replaced by the next retirement, and cleared by
   * `bind` — a live generation is never shadowed by its predecessor. A late
   * exit from an already-replaced generation is refused by `unbind` and writes
   * no tombstone.
   */
  private readonly retired = new Map<string, AgentSeatStateEvent>();
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
      if (config.timeZone !== undefined) prior.timeZone = config.timeZone;
      return;
    }
    if (prior) this.clearPendingIdle(prior);
    const slot: BindingSlot = {
      key: bindingId,
      harness: config.harness,
      epoch,
      ...(config.timeZone === undefined ? {} : { timeZone: config.timeZone }),
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
      snapshot: initialSnapshot(bindingId as BindingId, this.now()),
      factKeys: new Set(),
    };
    this.slots.set(bindingId, slot);
    // A live generation supersedes its predecessor's tombstone.
    this.retired.delete(bindingId);
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
        { signal: { _tag: "ProcessExited" }, source: "process", fidelity: "native" },
      ),
      true,
    );
    // Retain the published exit before dropping the slot: the event is the
    // only record of this generation's terminal state, and a wait that starts
    // after it must still be able to observe it.
    if (event !== null) this.retired.set(bindingId, event);
    this.slots.delete(bindingId);
    return event;
  }

  /**
   * Move a generation's slot to another key, whole: state, flags, epoch, and
   * an idle still waiting out its debounce. The old key is left with no slot,
   * exactly as if nothing had ever been bound there, so the seat's next
   * generation binds fresh.
   *
   * Two events come out of it, in this order. Under the old key, `gone` for
   * the generation that left, with its epoch and `reason`: the same thing
   * `unbind` says, and retained the same way, because to everything that
   * follows the seat this generation is over. Then, under the new key, the
   * moved slot once, with the state it already had.
   *
   * False, and nothing changes, when `from` has no slot or `to` already does.
   */
  rekey(from: string, to: string, reason = "offboard_detached"): boolean {
    const slot = this.slots.get(from);
    if (!slot || from === to || this.slots.has(to)) return false;
    this.slots.delete(from);
    slot.key = to;
    slot.snapshot = { ...slot.snapshot, seat: to as BindingId };
    this.slots.set(to, slot);
    const gone: AgentSeatStateEvent = {
      bindingId: from,
      epoch: slot.epoch,
      state: "gone",
      reason,
      confidence: "high",
      at: this.now(),
      harness: typeof slot.harness === "string" ? slot.harness : undefined,
    };
    this.retired.set(from, gone);
    this.emit(gone);
    this.maybePublish(
      slot,
      to,
      {
        ...this.lifecycleEvaluation(slot, slot.state, slot.reason, slot.confidence),
        visibleIdle: slot.visibleIdle,
        visibleWorking: slot.visibleWorking,
        visibleAttention: slot.visibleAttention,
      },
      true,
    );
    return true;
  }

  setHookState(
    bindingId: string,
    hookState: AgentSeatHookState | null,
  ): void {
    const slot = this.ensure(bindingId, undefined);
    slot.hookState = hookState;
    // A structured reporter that no longer holds the seat stops owning it,
    // so the screen carries the seat again.
    if (hookState?.fullLifecycle !== true && slot.snapshot.channels.includes("report")) {
      this.fold(slot, { signal: { _tag: "ChannelClosed", channel: "report" }, source: "system", fidelity: "native" });
    }
  }

  /** The seat's folded snapshot: the status the published state projects. */
  snapshot(bindingId: string): SeatSnapshot | undefined {
    return this.slots.get(bindingId)?.snapshot;
  }

  /**
   * Fold a fact that publishes nothing by itself: a channel closing, a
   * heartbeat. The next published decision projects from it.
   */
  note(bindingId: string, fact: SeatFact): void {
    const slot = this.slots.get(bindingId);
    if (slot) this.fold(slot, fact);
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
        status: statusWire(slot.snapshot),
      }));
  }

  /**
   * Last published event of each retired generation, in binding order.
   *
   * A retired binding is absent from {@link currentEvents} by construction, so
   * this is how a caller that must observe an exit *after* it happened (the
   * seat wait/observe lane) still sees the published `gone` event with its
   * epoch, reason and confidence.
   */
  retiredEvents(): ReadonlyArray<AgentSeatStateEvent> {
    return [...this.retired.values()].sort((left, right) =>
      left.bindingId.localeCompare(right.bindingId),
    );
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
      ...(slot.timeZone === undefined ? {} : { timeZone: slot.timeZone }),
    };

    const next = evaluate(snapshot, evalOpts);
    slot.lastEval = next;
    if (!next.skipStateUpdate) this.foldFacts(slot, next.facts ?? []);

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
        signal: signalForState("attention"),
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
          // The slot's key, read now: a slot moved to a drain key while its
          // idle was pending still publishes, under the key it lives at.
          this.maybePublish(
            slot,
            slot.key,
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

  /**
   * Force-publish a state (e.g. process exit → idle). `fact` says what it
   * means and who said it; without one it is the signal the state stands
   * for, as the screen would have read it.
   */
  force(
    bindingId: string,
    state: AgentSeatState,
    reason: string,
    confidence: "high" | "low" = "high",
    fact?: SeatFact,
  ): AgentSeatStateEvent {
    const slot = this.ensure(bindingId, undefined);
    this.clearPendingIdle(slot);
    const evalLike = this.lifecycleEvaluation(
      slot,
      state,
      reason,
      confidence,
      fact ?? { signal: signalForState(state), source: "screen", fidelity: "screen" },
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
        key: bindingId,
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
        snapshot: initialSnapshot(bindingId as BindingId, this.now()),
        factKeys: new Set(),
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
    if (next.signal !== null) {
      this.fold(slot, { signal: next.signal, source: next.source, fidelity: next.fidelity });
    }
    const state = projectAgentSeatState(slot.snapshot);
    // A richer open channel owning the seat outranks the screen by design;
    // only a disagreement the precedence does not explain is worth a line.
    if (state !== next.state && !outrankedByOwner(slot.snapshot, next.source)) {
      console.warn(
        `[seat-state] ${bindingId}: ${next.reason} decided ${next.state}, the snapshot reads ${state} (${slot.snapshot.status._tag} from ${slot.snapshot.statusSource})`,
      );
    }
    const stateChanged = slot.state !== state;
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

    slot.state = state;
    slot.reason = next.reason;
    slot.confidence = next.confidence;
    slot.visibleIdle = next.visibleIdle;
    slot.visibleWorking = next.visibleWorking;
    slot.visibleAttention = next.visibleAttention;
    slot.lastPublishedAt = t;

    const event: AgentSeatStateEvent = {
      bindingId,
      epoch: slot.epoch,
      state,
      reason: next.reason,
      confidence: next.confidence,
      at: t,
      harness:
        typeof slot.harness === "string" ? slot.harness : undefined,
      status: statusWire(slot.snapshot),
    };

    this.emit(event);
    return event;
  }

  private emit(event: AgentSeatStateEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("[seat-state] listener failed:", err);
      }
    }
    this.onEvent?.(event);
  }

  /**
   * Fold one fact into the slot's snapshot. A fresh decision supersedes a
   * stalled-turn latch, so any fact but the stall itself resumes the
   * heartbeat first: the latch reads only until the next judgment.
   */
  private fold(slot: BindingSlot, fact: SeatFact): void {
    const at = Math.max(this.now(), slot.snapshot.updatedAt);
    const envelope = (signal: SeatSignal, source: SignalSource, fidelity: Fidelity) => ({
      seat: slot.snapshot.seat,
      at,
      source,
      fidelity,
      signal,
    });
    let snapshot = slot.snapshot;
    if (snapshot.stalledSince !== undefined && fact.signal._tag !== "HeartbeatStalled" && isStatusFact(fact.signal)) {
      snapshot = reduceSeat(snapshot, envelope({ _tag: "HeartbeatResumed" }, "system", "native"));
    }
    slot.snapshot = reduceSeat(snapshot, envelope(fact.signal, fact.source, fact.fidelity));
  }

  /**
   * Fold the screen facts that appeared since the last frame. A fact still
   * on screen is not news; one that left and comes back is.
   */
  private foldFacts(slot: BindingSlot, facts: ReadonlyArray<SeatSignal>): void {
    const keys = new Set<string>();
    for (const signal of facts) {
      const key = JSON.stringify(signal);
      keys.add(key);
      if (!slot.factKeys.has(key)) this.fold(slot, { signal, source: "screen", fidelity: "screen" });
    }
    slot.factKeys = keys;
  }

  private clearPendingIdle(slot: BindingSlot): void {
    if (!slot.pendingIdle) return;
    if (slot.pendingIdle.timer !== undefined) {
      clearTimeout(slot.pendingIdle.timer);
    }
    slot.pendingIdle = null;
  }

  /**
   * A state Junto publishes itself. Without a fact it folds nothing: binding
   * a generation and moving a slot publish the status the snapshot holds.
   */
  private lifecycleEvaluation(
    slot: BindingSlot,
    state: AgentSeatState,
    reason: string,
    confidence: "high" | "low",
    fact?: SeatFact,
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
        typeof slot.harness === "string" && isHarnessId(slot.harness)
          ? slot.harness
          : "claude",
      signal: fact?.signal ?? null,
      source: fact?.source ?? "system",
      fidelity: fact?.fidelity ?? "native",
    };
  }
}

const outrankedByOwner = (snapshot: SeatSnapshot, source: SignalSource): boolean => {
  const owner = snapshot.statusSource;
  return (
    (snapshot.channels as ReadonlyArray<string>).includes(owner) &&
    sourceRank(owner) > sourceRank(source)
  );
};

const statusWire = (snapshot: SeatSnapshot): AgentSeatStatusWire =>
  encodeAgentSeatStatus({ snapshot, need: topNeed(snapshot) });

/** A fact that judges the seat's status, as opposed to one that only records. */
const isStatusFact = (signal: SeatSignal): boolean =>
  signal._tag !== "UsageLevel" &&
  signal._tag !== "SessionIdentified" &&
  signal._tag !== "SeatReported" &&
  signal._tag !== "AwarenessAssessed" &&
  signal._tag !== "ChannelOpened" &&
  signal._tag !== "ChannelClosed" &&
  signal._tag !== "HeartbeatResumed" &&
  signal._tag !== "WakeScheduled" &&
  signal._tag !== "MailDelivered" &&
  signal._tag !== "MailDeliveryFailed" &&
  signal._tag !== "OperatorViewed";

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
