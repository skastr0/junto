/**
 * Process-local seat state runtime: observer snapshots → SeatStateMachine →
 * idle gate for ManagedTerminalDrive + attention broadcasts + mid-turn
 * progress watchdog (turn-stalled attention, never idle).
 */

import type { AgentSeatState, AgentSeatStateEvent } from "../../../../shared/agent-seat-state";
import { terminalObserverPlane } from "../observer";
import type { ObserverGridSnapshot } from "../observer/types";
import { FALLBACK_IDLE } from "./engine";
import { hookStateFromSnapshot } from "./hook-feed";
import { SeatStateMachine } from "./seat-state-machine";
import type { HarnessId } from "../../../../shared/managed-terminal-templates";
import { isHarnessId } from "../../../../shared/managed-terminal-templates";
import {
  DEFAULT_TURN_STALL_MS,
  TURN_STALLED_REASON,
  TurnProgressWatch,
  progressFingerprint,
} from "./turn-progress-watch";

export type SeatStateRuntimeOptions = {
  readonly now?: () => number;
  readonly onEvent?: (event: AgentSeatStateEvent) => void;
  /**
   * Mid-turn silence threshold while the seat is working.
   * Default DEFAULT_TURN_STALL_MS (90s). Delivery-path paste ack is separate.
   */
  readonly turnStallMs?: number;
  /** When false, mid-turn progress watch is not installed (tests that only need idle gate). */
  readonly turnProgressWatch?: boolean;
};

/**
 * Owns harness bindings and bridges the global observer plane into the SM.
 * Call `start()` once during main IPC boot; `stop()` on tests/shutdown.
 */
export class SeatStateRuntime {
  readonly machine: SeatStateMachine;
  private unsubObserver: (() => void) | undefined;
  private readonly harnessByBinding = new Map<string, HarnessId | string>();
  private readonly eventListeners = new Set<(event: AgentSeatStateEvent) => void>();
  private readonly now: () => number;
  private readonly progressWatch: TurnProgressWatch | undefined;
  /** Sticky mid-turn stall: hold attention until progress or a non-working leave. */
  private readonly turnStalled = new Set<string>();
  private readonly lastProgressFp = new Map<string, string>();

  constructor(opts: SeatStateRuntimeOptions = {}) {
    this.now = opts.now ?? (() => Date.now());
    this.machine = new SeatStateMachine({
      now: this.now,
      onEvent: (event) => {
        this.syncWatchWithEvent(event);
        opts.onEvent?.(event);
        for (const listener of this.eventListeners) {
          try {
            listener(event);
          } catch (err) {
            console.error("[seat-state] event listener failed:", err);
          }
        }
      },
    });
    if (opts.turnProgressWatch === false) {
      this.progressWatch = undefined;
    } else {
      this.progressWatch = new TurnProgressWatch({
        now: this.now,
        stallMs: opts.turnStallMs ?? DEFAULT_TURN_STALL_MS,
        onStall: (bindingId) => this.fireTurnStalled(bindingId),
      });
    }
  }

  start(): void {
    if (this.unsubObserver) return;
    // Single observer path: OSC hook + evaluate on the same tick so null
    // clears sticky hooks before idle gate reads them (no dual-sub race).
    this.unsubObserver = terminalObserverPlane.subscribeAll((snap) => {
      this.observe(snap);
    });
  }

  stop(): void {
    this.unsubObserver?.();
    this.unsubObserver = undefined;
    this.progressWatch?.dispose();
    this.turnStalled.clear();
    this.lastProgressFp.clear();
    this.machine.dispose();
    this.harnessByBinding.clear();
    this.eventListeners.clear();
  }

  /** Bind a live terminal generation to a harness rule pack. */
  bindHarness(
    bindingId: string,
    harness: HarnessId | string,
    epoch?: string,
  ): void {
    this.harnessByBinding.set(bindingId, harness);
    this.machine.bind(bindingId, { harness, epoch });
  }

  unbind(
    bindingId: string,
    epoch?: string,
    reason = "generation_unbound",
  ): void {
    const current = this.machine.getSlot(bindingId);
    if (epoch !== undefined && current?.epoch !== epoch) return;
    const event = this.machine.unbind(bindingId, { epoch, reason });
    this.clearTurnWatch(bindingId);
    if (!event) return;
    this.harnessByBinding.delete(bindingId);
  }

  /**
   * Paste authorization for ManagedTerminalDrive.
   * Fail closed: unknown/unbound/attention/working refuse.
   * Low-confidence bare `default_known_agent_idle_fallback` is **not** typeable —
   * only high-confidence idle or visible idle chrome authorizes paste.
   */
  isSeatIdle(bindingId: string): boolean {
    const slot = this.machine.getSlot(bindingId);
    if (!slot || slot.state !== "idle") return false;
    if (slot.visibleIdle) return true;
    if (slot.confidence === "high") return true;
    // Low-confidence fallback idle: refuse paste (dialog / unmatched chrome).
    if (slot.reason === FALLBACK_IDLE || slot.reason.startsWith(`${FALLBACK_IDLE}+`)) {
      return false;
    }
    return false;
  }

  getState(bindingId: string): AgentSeatState | undefined {
    return this.machine.getState(bindingId);
  }

  /** True while sticky mid-turn stall holds attention (tests / diagnostics). */
  isTurnStalled(bindingId: string): boolean {
    return this.turnStalled.has(bindingId);
  }

  /** Bounded current-state projection; no history or renderer-owned cache. */
  currentEvents(): ReadonlyArray<AgentSeatStateEvent> {
    return this.machine.currentEvents();
  }

  subscribe(listener: (event: AgentSeatStateEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  /**
   * Apply one observer snapshot (same path as the global plane subscription).
   * Tests call this directly; production uses `start()` → plane.
   */
  observe(snap: ObserverGridSnapshot): AgentSeatStateEvent | null {
    const harness =
      this.harnessByBinding.get(snap.bindingId) ??
      this.machine.getSlot(snap.bindingId)?.harness;
    // Unbound sessions stay unbound — isSeatIdle remains false.
    if (!harness) {
      return null;
    }
    const now = this.now();
    // Same-tick hook: null clears sticky prior OSC working/idle.
    const hook = hookStateFromSnapshot(snap, String(harness), now);
    const fp = progressFingerprint(snap, hook);
    const priorFp = this.lastProgressFp.get(snap.bindingId);
    const progressed = priorFp !== undefined && priorFp !== fp;
    this.lastProgressFp.set(snap.bindingId, fp);

    if (progressed) {
      this.progressWatch?.noteProgress(snap.bindingId);
      // Progress after a stall: release sticky so live working chrome can return.
      this.turnStalled.delete(snap.bindingId);
    }

    this.machine.setHookState(snap.bindingId, hook);
    let event = this.machine.feed(snap, {
      harness: isHarnessId(harness) ? harness : harness,
      hookState: hook,
    });

    // Sticky turn-stalled: never re-publish working (cyan) without progress.
    // Must not coerce to idle — that would drain the managed prompt queue.
    if (
      this.turnStalled.has(snap.bindingId) &&
      this.machine.getState(snap.bindingId) === "working"
    ) {
      event = this.machine.force(
        snap.bindingId,
        "attention",
        TURN_STALLED_REASON,
        "high",
      );
    }

    this.syncWatchWithPublished(snap.bindingId);
    return event;
  }

  private fireTurnStalled(bindingId: string): void {
    if (!this.machine.getSlot(bindingId)) return;
    // Never idle: attention refuses paste and does not call onSeatIdle.
    this.turnStalled.add(bindingId);
    this.machine.force(bindingId, "attention", TURN_STALLED_REASON, "high");
  }

  private syncWatchWithEvent(event: AgentSeatStateEvent): void {
    // force()/bind publish through onEvent; keep arm/clear consistent when
    // tests call machine.force directly.
    if (event.state === "working") {
      this.progressWatch?.arm(event.bindingId);
      return;
    }
    if (event.state === "attention" && event.reason === TURN_STALLED_REASON) {
      // Stall fire already disarmed the watch; keep sticky latch.
      return;
    }
    // Idle / gone / real attention / unknown: drop mid-turn watch + sticky.
    this.clearTurnWatch(event.bindingId);
  }

  private syncWatchWithPublished(bindingId: string): void {
    const slot = this.machine.getSlot(bindingId);
    if (!slot) {
      this.clearTurnWatch(bindingId);
      return;
    }
    if (slot.state === "working") {
      this.progressWatch?.arm(bindingId);
      return;
    }
    if (slot.state === "attention" && slot.reason === TURN_STALLED_REASON) {
      return;
    }
    this.clearTurnWatch(bindingId);
  }

  private clearTurnWatch(bindingId: string): void {
    this.progressWatch?.clear(bindingId);
    this.turnStalled.delete(bindingId);
    this.lastProgressFp.delete(bindingId);
  }
}

/** Process singleton used by main IPC boot. */
export const seatStateRuntime = new SeatStateRuntime();

export {
  DEFAULT_TURN_STALL_MS,
  TURN_STALLED_REASON,
  progressFingerprint,
} from "./turn-progress-watch";
