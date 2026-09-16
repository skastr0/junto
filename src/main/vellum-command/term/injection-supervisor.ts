/**
 * Injection supervisor — event-driven re-engagement for managed seats.
 *
 * Policy: Junto may become more active with a seat's PTY only when it
 * can prove the intervention cannot damage the experience. Every intervention
 * goes through the typed decision matrix (term/intervention/policy.ts), which
 * is total and exhaustive; the write-gates (user present/drafted, live
 * injection, permission modal) ALWAYS override. Escalation is a canvas event,
 * never a PTY write.
 *
 * Driven by events, never wall clock: seat-state transitions, PTY snapshots
 * (marker echo, turn boundaries), user input, work-plane
 * calls (process-bound proof), claim acceptance, generation changes.
 */

import type { ObserverGridSnapshot } from "./observer/types";
import {
  deriveInteraction,
  type InjectionSignal,
  type InteractionDerived,
  type TurnSignal,
  type UserSignal,
} from "./observer/interaction";
import {
  InteractionContext,
  decideIntervention,
  MAX_TURNS_WITHOUT_PROOF,
  type Intervention,
  type SeatSignal,
} from "./intervention/policy";
import {
  appendBootstrapMarker,
  buildBootstrapMarker,
  buildOrientNotice,
} from "@shared/managed-terminal-injection";
import type { AgentSeatStateEvent } from "@shared/agent-seat-state";

export type AwarenessSignal = "unproven" | "proven";

type SeatSupervision = {
  readonly epoch: string;
  state: SeatSignal;
  proven: boolean;
  awareness: AwarenessSignal;
  /** Completed agent turns without any factory proof (turn budget). */
  turnsWithoutProof: number;
  /**
   * A marker lifecycle was observed on screen (injection seen live/in-flight
   * at some point) — the only turn evidence that survives without an
   * operator at the seat. Reset when a turn is counted.
   */
  markerLifecycleObserved: boolean;
  prevTurn: "none" | "in-turn" | "ended";
  lastSeenSeq: bigint | undefined;
  lastUserInputAt: number | undefined;
  lastOutputAt: number | undefined;
  /** Last decision we acted on, to dedup identical repeats. */
  lastActedKind: Intervention["kind"] | undefined;
  /** Only re-inject a charter when a NEW turn completed since the last one. */
  repairedOnce: boolean;
  /**
   * Orient notices delivered to THIS generation. A count, not a flag: the
   * re-orientation floor re-delivers on a budget, because a harness that
   * compacts its own context throws the doctrine away mid-session.
   */
  orientationsDelivered: number;
  /** One transport request owns this generation's next orientation receipt. */
  orientationInFlight: boolean;
  escalatedOnce: boolean;
  hadDelivery: boolean;
  lastText: string | undefined;
  lastUserSignal: UserSignal | undefined;
  lastInjectionSignal: InjectionSignal | undefined;
  lastTurnSignal: TurnSignal | undefined;
};

export type NoticeWriter = (bindingId: string, text: string) => boolean | Promise<boolean>;
export type EscalationHandler = (bindingId: string, reason: string) => void;

/**
 * Pure per-seat supervision state. The class owns state + event handling;
 * PTY writes and canvas escalation go through injected callbacks so this
 * module never imports the drive or the renderer-facing state machine.
 */
export class InjectionSupervisor {
  private readonly seats = new Map<string, SeatSupervision>();
  /**
   * Binding-level sticky facts that survive generation changes and may arrive
   * before the first snapshot registers the seat: process-bound factory proof
   * (a work-plane call) and the last user-input timestamp.
   */
  private readonly provenBindings = new Set<string>();
  private readonly userInputBindings = new Map<string, number>();
  private writer: NoticeWriter | undefined;
  private escalationHandler: EscalationHandler | undefined;
  private now: () => number = Date.now;

  setWriter(writer: NoticeWriter): void {
    this.writer = writer;
  }

  setEscalationHandler(handler: EscalationHandler): void {
    this.escalationHandler = handler;
  }

  setNow(now: () => number): void {
    this.now = now;
  }

  /** Test seam. */
  clearForTest(): void {
    this.seats.clear();
  }

  private ensure(bindingId: string, epoch: string): SeatSupervision {
    let seat = this.seats.get(bindingId);
    if (seat === undefined || seat.epoch !== epoch) {
      seat = {
        epoch,
        state: "unknown" as SeatSignal,
        proven: this.provenBindings.has(bindingId),
        awareness: "unproven",
        turnsWithoutProof: 0,
        markerLifecycleObserved: false,
        prevTurn: "none",
        lastSeenSeq: undefined,
        lastUserInputAt: this.userInputBindings.get(bindingId),
        lastOutputAt: undefined,
        lastActedKind: undefined,
        repairedOnce: false,
        orientationsDelivered: 0,
        orientationInFlight: false,
        escalatedOnce: false,
        hadDelivery: false,
        lastText: undefined,
        lastUserSignal: undefined,
        lastInjectionSignal: undefined,
        lastTurnSignal: undefined,
      };
      this.seats.set(bindingId, seat);
    }
    return seat;
  }

  /**
   * A work-plane call from the seat's own process (process-bind proof) — the
   * definitive awareness signal. Also called on claim acceptance.
   */
  noteWorkPlaneCall(bindingId: string | undefined): void {
    if (!bindingId) return;
    // Sticky: proof may arrive before the seat's first snapshot.
    this.provenBindings.add(bindingId);
    const seat = this.seats.get(bindingId);
    if (seat) {
      seat.proven = true;
      seat.awareness = "proven";
    }
  }

  noteClaimAccepted(bindingId: string): void {
    this.noteWorkPlaneCall(bindingId);
  }

  /** Sticky process-bound proof for a binding (survives generation cuts). */
  isProven(bindingId: string): boolean {
    return this.provenBindings.has(bindingId);
  }

  /** User keystrokes routed to the PTY (from the terminal write IPC). */
  noteUserInput(bindingId: string, at: number = this.now()): void {
    // Sticky: input may arrive before the seat's first snapshot.
    this.userInputBindings.set(bindingId, at);
    const seat = this.seats.get(bindingId);
    if (seat) seat.lastUserInputAt = at;
  }

  /** Last operator keystroke time for a binding, if any (process-local sticky). */
  lastUserInputAt(bindingId: string): number | undefined {
    return this.userInputBindings.get(bindingId);
  }

  /** Seat-state machine events (idle/working/attention/gone/...). */
  noteSeatState(event: AgentSeatStateEvent): void {
    const seat = this.ensure(event.bindingId, event.epoch);
    seat.state = event.state as SeatSignal;
    if (event.state === "gone") {
      // Generation exited: evict the per-generation entry (sticky binding
      // proof + user-input maps persist, so a resumed generation is re-seeded
      // correctly on its next snapshot and must re-prove awareness). The
      // spawn path re-arms the first typed message; the wiring cleared the
      // delivered registry so it can land again.
      this.seats.delete(event.bindingId);
      return;
    }
  }

  
  /**
   * PTY snapshot feed (observer global listener). Derives interaction signals,
   * runs the decision matrix with dedup.
   */
  onSnapshot(snap: ObserverGridSnapshot): void {
    const seat = this.ensure(snap.bindingId, snap.epoch);
    const now = this.now();

    // Output recency from sequence advancement.
    if (seat.lastSeenSeq !== undefined && snap.seq > seat.lastSeenSeq) {
      seat.lastOutputAt = now;
    }
    seat.lastSeenSeq = snap.seq;

    const markerToken = buildBootstrapMarker(snap.bindingId);
    const inter = deriveInteraction(
      seatStateOf(seat),
      snap.lines,
      markerToken,
      seat.hadDelivery,
      seat.lastUserInputAt,
      seat.lastOutputAt,
      now,
    );

    // Marker lifecycle: seeing our marker live/in-flight is the only turn
    // evidence that survives without an operator at the seat.
    if (inter.injection === "live" || inter.injection === "in-flight") {
      seat.hadDelivery = true;
      seat.markerLifecycleObserved = true;
    }
    if (inter.injection === "consumed") {
      seat.hadDelivery = true;
    }

    // Turn-boundary counting (turn budget, never wall clock). A working→idle
    // flip counts as a turn ONLY when real activity corroborates it: our
    // marker lifecycle completed (seen live/in-flight, then cleared/output —
    // the marker left the prompt region), or the operator is at the seat
    // (recent user input — operator-driven turns need no marker). Bare title
    // flips with neither are NOT turns: they must not fake the budget into
    // escalation (POL-2).
    if (
      seat.prevTurn === "in-turn" &&
      inter.turn === "ended" &&
      !seat.proven &&
      ((seat.markerLifecycleObserved && inter.injection !== "live") ||
        inter.user === "present")
    ) {
      seat.turnsWithoutProof += 1;
      // The lifecycle is per-turn: the next count needs a fresh observation.
      seat.markerLifecycleObserved = false;
    }
    seat.prevTurn = inter.turn;

    // Event-gate (not a throttle): the full policy decision only runs when
    // something decision-relevant changed — text, interaction signals, or
    // turn state. Identical frames are skipped; no wall clock involved.
    const signalsChanged =
      inter.user !== seat.lastUserSignal ||
      inter.injection !== seat.lastInjectionSignal ||
      inter.turn !== seat.lastTurnSignal;
    if (!signalsChanged) return;
    seat.lastUserSignal = inter.user;
    seat.lastInjectionSignal = inter.injection;
    seat.lastTurnSignal = inter.turn;

    this.runDecision(snap.bindingId, seat, inter);
  }

  private runDecision(
    bindingId: string,
    seat: SeatSupervision,
    inter: InteractionDerived,
  ): void {
    const ctx: InteractionContext = {
      seat: seatStateOf(seat),
      user: inter.user,
      injection: inter.injection,
      turn: inter.turn,
      awareness: seat.awareness,
      turnsWithoutProof: seat.turnsWithoutProof,
      orientationsDelivered: seat.orientationsDelivered,
      escalated: seat.escalatedOnce,
    };
    const decision = decideIntervention(ctx);

    // Orientations use accepted-delivery budgets and an in-flight reservation
    // instead of same-kind dedup, so a refused notice can be retried later.
    if (
      decision.kind !== "notify-orient" &&
      decision.kind === seat.lastActedKind &&
      decision.kind !== "escalate"
    ) {
      return;
    }

    switch (decision.kind) {
      case "silent":
        return;
      case "hold":
        return;
      case "notify-orient": {
        const writer = this.writer;
        if (writer === undefined || seat.orientationInFlight) return;
        // Reserve before invoking the writer: synchronous observer callbacks
        // and later turn events must not request an overlapping notice.
        seat.orientationInFlight = true;
        const payload = appendBootstrapMarker(
          buildOrientNotice(bindingId),
          bindingId,
        );
        const settle = (accepted: boolean): void => {
          if (this.seats.get(bindingId) !== seat) return;
          seat.orientationInFlight = false;
          if (accepted) {
            seat.orientationsDelivered += 1;
            seat.lastActedKind = "notify-orient";
          }
        };
        try {
          const result = writer(bindingId, payload);
          if (typeof result === "boolean") settle(result);
          else void result.then(settle, () => settle(false));
        } catch {
          settle(false);
        }
        return;
      }
      case "escalate": {
        if (seat.escalatedOnce) return;
        seat.escalatedOnce = true;
        seat.lastActedKind = "escalate";
        this.escalationHandler?.(
          bindingId,
          `seat unguided after ${seat.turnsWithoutProof} turns without factory contact (${seat.awareness})`,
        );
        return;
      }
    }
  }

}

const seatStateOf = (seat: SeatSupervision): SeatSignal => seat.state;

/** Process-wide supervisor singleton (wired by main/vellum-command/ipc.ts). */
export const injectionSupervisor = new InjectionSupervisor();
