/**
 * Process-local seat state runtime: observer snapshots → SeatStateMachine →
 * idle gate for ManagedTerminalDrive + attention broadcasts.
 */

import type { AgentSeatState, AgentSeatStateEvent } from "../../../../shared/agent-seat-state";
import { terminalObserverPlane } from "../observer";
import type { ObserverGridSnapshot } from "../observer/types";
import { attachOscHookFeed } from "./hook-feed";
import { SeatStateMachine } from "./seat-state-machine";
import type { HarnessId } from "../../../../shared/managed-terminal-templates";
import { isHarnessId } from "../../../../shared/managed-terminal-templates";

export type SeatStateRuntimeOptions = {
  readonly now?: () => number;
  readonly onEvent?: (event: AgentSeatStateEvent) => void;
};

/**
 * Owns harness bindings and bridges the global observer plane into the SM.
 * Call `start()` once during main IPC boot; `stop()` on tests/shutdown.
 */
export class SeatStateRuntime {
  readonly machine: SeatStateMachine;
  private unsubObserver: (() => void) | undefined;
  private unsubHookFeed: (() => void) | undefined;
  private readonly harnessByBinding = new Map<string, HarnessId | string>();
  private readonly eventListeners = new Set<(event: AgentSeatStateEvent) => void>();

  constructor(opts: SeatStateRuntimeOptions = {}) {
    this.machine = new SeatStateMachine({
      now: opts.now,
      onEvent: (event) => {
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
  }

  start(): void {
    if (this.unsubObserver) return;
    this.unsubObserver = terminalObserverPlane.subscribeAll((snap) => {
      this.onSnapshot(snap);
    });
    // OSC → setHookState so hooks→OSC→grid rank is live (not dead API).
    this.unsubHookFeed = attachOscHookFeed(this.machine, (listener) =>
      terminalObserverPlane.subscribeAll(listener),
    );
  }

  stop(): void {
    this.unsubObserver?.();
    this.unsubObserver = undefined;
    this.unsubHookFeed?.();
    this.unsubHookFeed = undefined;
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
    if (!event) return;
    this.harnessByBinding.delete(bindingId);
  }

  isSeatIdle(bindingId: string): boolean {
    const state = this.machine.getState(bindingId);
    // Unknown/unbound: refuse typing (fail closed — never type into a dialog).
    return state === "idle";
  }

  getState(bindingId: string): AgentSeatState | undefined {
    return this.machine.getState(bindingId);
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

  private onSnapshot(snap: ObserverGridSnapshot): void {
    const harness =
      this.harnessByBinding.get(snap.bindingId) ??
      this.machine.getSlot(snap.bindingId)?.harness;
    // Unbound sessions still evaluate with a default pack only if bound —
    // ensure() in feed creates unknown harness slots; prefer explicit bind.
    if (!harness) {
      // Auto-bind as unknown harness "claude" only after first snap if never
      // configured — better: stay unbound and isSeatIdle stays false.
      return;
    }
    this.machine.feed(snap, {
      harness: isHarnessId(harness) ? harness : harness,
    });
  }
}

/** Process singleton used by main IPC boot. Tests construct their own. */
export const seatStateRuntime = new SeatStateRuntime();
