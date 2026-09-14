/**
 * Process-local seat state runtime: observer snapshots → SeatStateMachine →
 * idle gate for ManagedTerminalDrive + attention broadcasts + mid-turn
 * progress watchdog (turn-stalled attention, never idle).
 */

import type {
  AgentSeatHookState,
  AgentSeatState,
  AgentSeatStateEvent,
} from "../../../../shared/agent-seat-state";
import { terminalObserverPlane } from "../observer";
import type { ObserverGridSnapshot } from "../observer/types";
import { peekFirstTypedMessage } from "../first-typed";
import { composerVerdictForHarness } from "./composer";
import type { ComposerVerdict } from "./types";
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

export type StructuredSeatHookInput = Readonly<{
  readonly bindingId: string;
  readonly epoch: string;
  readonly state: "idle" | "working" | "attention";
  readonly reason: string;
}>;

type StructuredSeatHookAuthority = Readonly<{
  readonly epoch: string;
  readonly hook: AgentSeatHookState;
}>;

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
  /** Last screen-derived composer verdict per binding (see composer.ts). */
  private readonly composerByBinding = new Map<string, ComposerVerdict>();
  private readonly composerListeners = new Set<
    (bindingId: string, verdict: ComposerVerdict) => void
  >();
  private readonly now: () => number;
  private readonly progressWatch: TurnProgressWatch | undefined;
  /** Sticky mid-turn stall: hold attention until progress or a non-working leave. */
  private readonly turnStalled = new Set<string>();
  private readonly lastProgressFp = new Map<string, string>();
  /** Last observer snapshot per binding — used for Muse handshake paste gate. */
  private readonly lastSnapshot = new Map<string, ObserverGridSnapshot>();
  /**
   * Full-lifecycle structured authority by exact terminal generation.
   * While present, screen and OSC ticks remain diagnostic progress only and
   * cannot replace the reporter's state.
   */
  private readonly structuredHookByBinding = new Map<
    string,
    StructuredSeatHookAuthority
  >();

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
    this.lastSnapshot.clear();
    this.structuredHookByBinding.clear();
    this.machine.dispose();
    this.harnessByBinding.clear();
    this.eventListeners.clear();
    this.composerByBinding.clear();
    this.composerListeners.clear();
  }

  /** Bind a live terminal generation to a harness rule pack. */
  bindHarness(
    bindingId: string,
    harness: HarnessId | string,
    epoch?: string,
  ): void {
    const structured = this.structuredHookByBinding.get(bindingId);
    if (structured !== undefined && structured.epoch !== (epoch ?? "")) {
      this.structuredHookByBinding.delete(bindingId);
    }
    const prior = this.machine.getSlot(bindingId);
    const nextEpoch = epoch ?? prior?.epoch ?? "";
    if (
      prior !== undefined &&
      (prior.epoch !== nextEpoch || prior.harness !== harness)
    ) {
      // Screen evidence belongs to one generation under one rule pack. The
      // machine resets the slot here; the snapshot, verdict, and progress
      // fingerprint judged for the old one go with it, so the replacement
      // answers nothing until its own observer stream paints. The old
      // generation's exit cannot do this: its unbind is an epoch no-op.
      this.lastSnapshot.delete(bindingId);
      this.composerByBinding.delete(bindingId);
      this.lastProgressFp.delete(bindingId);
    }
    this.harnessByBinding.set(bindingId, harness);
    this.machine.bind(bindingId, { harness, epoch });
  }

  /**
   * The screen a lookup may answer from: the snapshot the seat state was
   * judged on, when it belongs to the slot's generation; otherwise the plane's
   * settled grid, again only for that generation. The two are the same grid
   * whenever this runtime is subscribed — the plane emits only settled writes
   * and `observe` runs on that emit — so preferring the judged one costs no
   * freshness and keeps every lookup on one screen. A grid from another
   * generation, live or cached, never answers.
   */
  private evidenceSnapshot(
    bindingId: string,
  ): ObserverGridSnapshot | undefined {
    const slotEpoch = this.machine.getSlot(bindingId)?.epoch ?? "";
    const sameGeneration = (
      snap: ObserverGridSnapshot | undefined,
    ): ObserverGridSnapshot | undefined =>
      snap !== undefined &&
      (slotEpoch.length === 0 || snap.epoch.length === 0 || snap.epoch === slotEpoch)
        ? snap
        : undefined;
    return (
      sameGeneration(this.lastSnapshot.get(bindingId)) ??
      sameGeneration(terminalObserverPlane.snapshot(bindingId))
    );
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
    this.lastSnapshot.delete(bindingId);
    this.composerByBinding.delete(bindingId);
    const structured = this.structuredHookByBinding.get(bindingId);
    if (
      structured !== undefined &&
      (epoch === undefined || structured.epoch === epoch)
    ) {
      this.structuredHookByBinding.delete(bindingId);
    }
    if (!event) return;
    this.harnessByBinding.delete(bindingId);
  }

  /**
   * Install one exact generation's full-lifecycle structured authority.
   *
   * Unlike OSC-derived hook hints, this feed publishes immediately and owns
   * idle/working/attention until explicitly released. Old-generation packets
   * are total no-ops and cannot create or replace a machine slot.
   */
  observeStructuredHook(
    input: StructuredSeatHookInput,
  ): AgentSeatStateEvent | null {
    const slot = this.machine.getSlot(input.bindingId);
    if (slot === undefined || slot.epoch !== input.epoch) return null;
    const hook: AgentSeatHookState = Object.freeze({
      state: input.state,
      reason: input.reason,
      at: this.now(),
      fullLifecycle: true,
    });
    this.structuredHookByBinding.set(input.bindingId, {
      epoch: input.epoch,
      hook,
    });
    this.machine.setHookState(input.bindingId, hook);
    // A fresh structured transition supersedes a heuristic stall latch. A
    // later watchdog fire cannot persist over the next authoritative report.
    this.clearTurnWatch(input.bindingId);
    return this.machine.force(
      input.bindingId,
      input.state,
      input.reason,
      "high",
    );
  }

  /**
   * Release only the matching generation's structured authority.
   * Re-evaluate the newest exact-generation screen immediately when one is
   * available; otherwise publish unknown until the next observer tick.
   */
  clearStructuredHook(
    bindingId: string,
    epoch: string,
    reason = "structured_hook_released",
  ): AgentSeatStateEvent | null {
    const slot = this.machine.getSlot(bindingId);
    const structured = this.structuredHookByBinding.get(bindingId);
    if (
      slot === undefined ||
      slot.epoch !== epoch ||
      structured === undefined ||
      structured.epoch !== epoch
    ) {
      return null;
    }
    this.structuredHookByBinding.delete(bindingId);
    this.machine.setHookState(bindingId, null);
    this.clearTurnWatch(bindingId);
    const snapshot = this.lastSnapshot.get(bindingId);
    if (snapshot !== undefined && snapshot.epoch === epoch) {
      return this.observe(snapshot);
    }
    return this.machine.force(bindingId, "unknown", reason, "low");
  }

  /**
   * Paste authorization for ManagedTerminalDrive.
   * Fail closed: unknown/unbound/attention/working refuse.
   * Low-confidence bare `default_known_agent_idle_fallback` is **not** typeable —
   * only high-confidence idle or visible idle chrome authorizes paste.
   *
   * Muse exception: Tier B doctrine is firstTyped only (no `--agents` decoder on
   * 0.1.0-R708.1). museRules has no screen idle chrome, so the seat sits on
   * fallback idle forever. Open the paste gate **only while** a firstTyped body
   * is armed and the TUI handshake shows bracketed paste — one-shot doctrine
   * delivery, not permanent mid-turn injectability.
   */
  isSeatIdle(bindingId: string): boolean {
    const slot = this.machine.getSlot(bindingId);
    if (!slot || slot.state !== "idle") return false;
    if (slot.visibleIdle) return true;
    if (slot.confidence === "high") return true;
    // Low-confidence fallback idle: refuse paste (dialog / unmatched chrome),
    // except Muse firstTyped doctrine (handshake-gated, one-shot).
    if (
      slot.reason === FALLBACK_IDLE ||
      slot.reason.startsWith(`${FALLBACK_IDLE}+`)
    ) {
      const harness =
        this.harnessByBinding.get(bindingId) ?? slot.harness;
      if (
        harness === "muse" &&
        peekFirstTypedMessage(bindingId) !== undefined
      ) {
        const snap = this.evidenceSnapshot(bindingId);
        if (snap?.signals.modes.bracketedPaste) return true;
      }
      return false;
    }
    return false;
  }

  getState(bindingId: string): AgentSeatState | undefined {
    return this.machine.getState(bindingId);
  }

  /**
   * Screen-derived composer verdict for the drive's typing gate.
   *
   * Re-read from the screen at the paste moment (not the cached last
   * verdict), so a quiet idle seat that painted its empty composer minutes
   * ago still answers truthfully — and read from the same settled grid the
   * seat state was judged on, for the slot's own generation only (see
   * `evidenceSnapshot`). null — unbound seat, no snapshot for this
   * generation yet, or the harness's probes matched nothing — always refuses
   * typing.
   */
  composerVerdict(bindingId: string): ComposerVerdict {
    const harness =
      this.harnessByBinding.get(bindingId) ??
      this.machine.getSlot(bindingId)?.harness;
    if (!harness) return null;
    const snap = this.evidenceSnapshot(bindingId);
    if (!snap) return null;
    return composerVerdictForHarness(snap, String(harness));
  }

  /**
   * Notified on every composer-verdict CHANGE (draft→empty is the boundary
   * the drive's queued prompts wait on).
   */
  subscribeComposerVerdict(
    listener: (bindingId: string, verdict: ComposerVerdict) => void,
  ): () => void {
    this.composerListeners.add(listener);
    return () => {
      this.composerListeners.delete(listener);
    };
  }

  private noteComposerVerdict(
    bindingId: string,
    verdict: ComposerVerdict,
  ): void {
    const prior = this.composerByBinding.get(bindingId);
    if (prior === verdict) return;
    this.composerByBinding.set(bindingId, verdict);
    for (const listener of this.composerListeners) {
      try {
        listener(bindingId, verdict);
      } catch (err) {
        console.error("[seat-state] composer listener failed:", err);
      }
    }
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
    const slot = this.machine.getSlot(snap.bindingId);
    if (
      slot !== undefined &&
      snap.epoch.length > 0 &&
      slot.epoch.length > 0 &&
      snap.epoch !== slot.epoch
    ) {
      // The observer detach/attach boundary is epoch-gated. A late snapshot
      // from the old process must not rebind or perturb the new seat.
      return null;
    }
    this.lastSnapshot.set(snap.bindingId, snap);
    // Composer verdict on EVERY snapshot, before any state-authority branch —
    // a structured hook feed owning seat state must not blind the composer
    // question, and the drive's drain waits on the draft→empty transition.
    this.noteComposerVerdict(
      snap.bindingId,
      composerVerdictForHarness(snap, String(harness)),
    );
    const now = this.now();
    const structured = this.structuredHookByBinding.get(snap.bindingId);
    if (structured !== undefined && structured.epoch === slot?.epoch) {
      const fp = progressFingerprint(snap, structured.hook);
      const priorFp = this.lastProgressFp.get(snap.bindingId);
      const progressed = priorFp !== undefined && priorFp !== fp;
      this.lastProgressFp.set(snap.bindingId, fp);
      if (progressed) {
        this.progressWatch?.noteProgress(snap.bindingId);
        this.turnStalled.delete(snap.bindingId);
      }
      this.machine.setHookState(snap.bindingId, structured.hook);
      let event: AgentSeatStateEvent | null = null;
      const published = this.machine.getSlot(snap.bindingId);
      if (
        published?.state !== structured.hook.state ||
        published.reason !== structured.hook.reason
      ) {
        event = this.machine.force(
          snap.bindingId,
          structured.hook.state,
          structured.hook.reason,
          "high",
        );
      }
      this.syncWatchWithPublished(snap.bindingId);
      return event;
    }

    // Same-tick OSC hook: null clears sticky prior OSC working/idle only when
    // no full-lifecycle structured source owns this generation.
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
    const slot = this.machine.getSlot(bindingId);
    if (!slot) return;
    const structured = this.structuredHookByBinding.get(bindingId);
    if (structured !== undefined && structured.epoch === slot.epoch) return;
    // Never idle: attention refuses paste and does not call onSeatIdle.
    this.turnStalled.add(bindingId);
    this.machine.force(bindingId, "attention", TURN_STALLED_REASON, "high");
  }

  private syncWatchWithEvent(event: AgentSeatStateEvent): void {
    // A full-lifecycle feed owns liveness too; a heuristic screen-silence
    // watchdog must not override it between structured transitions.
    const structured = this.structuredHookByBinding.get(event.bindingId);
    if (structured !== undefined && structured.epoch === event.epoch) {
      this.progressWatch?.clear(event.bindingId);
      this.turnStalled.delete(event.bindingId);
      return;
    }
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
    const structured = this.structuredHookByBinding.get(bindingId);
    if (structured !== undefined && structured.epoch === slot.epoch) {
      this.progressWatch?.clear(bindingId);
      this.turnStalled.delete(bindingId);
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
