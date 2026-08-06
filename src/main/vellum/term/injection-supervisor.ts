/**
 * Injection supervisor — event-driven re-engagement for managed seats.
 *
 * Policy: Vellum Command may become more active with a seat's PTY only when it
 * can prove the intervention cannot damage the experience. Every intervention
 * goes through the typed decision matrix (term/intervention/policy.ts), which
 * is total and exhaustive; the write-gates (user present/drafted, live
 * injection, permission modal) ALWAYS override. Escalation is a canvas event,
 * never a PTY write.
 *
 * Driven by events, never wall clock: seat-state transitions, PTY snapshots
 * (marker echo, output heuristics, turn boundaries), user input, work-plane
 * calls (process-bound proof), claim acceptance, generation changes.
 */

import { existsSync } from "node:fs";
import type { ObserverGridSnapshot } from "./observer/types";
import {
  deriveInteraction,
  type InjectionSignal,
  type InteractionDerived,
  type TurnSignal,
  type UserSignal,
} from "./observer/interaction";
import {
  scanHeuristics,
  type HeuristicHit,
  type HeuristicClass,
} from "./observer/heuristics";
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
  buildInjectionText,
  buildRepairEnvNudge,
  type InjectionContext,
} from "@shared/managed-terminal-injection";
import type { AgentSeatStateEvent } from "@shared/agent-seat-state";
import { vellumCliPathPrefixes } from "./templates/seat-env";

export type AwarenessSignal =
  | "unproven"
  | "proven"
  | "confused"
  | "env-broken"
  | "socket-down";

type SeatSupervision = {
  readonly epoch: string;
  state: SeatSignal;
  proven: boolean;
  awareness: AwarenessSignal;
  /** Completed agent turns without any factory proof (turn budget). */
  turnsWithoutProof: number;
  prevTurn: "none" | "in-turn" | "ended";
  lastSeenSeq: bigint | undefined;
  lastUserInputAt: number | undefined;
  lastOutputAt: number | undefined;
  /** Last decision we acted on, to dedup identical repeats. */
  lastActedKind: Intervention["kind"] | undefined;
  /** Only re-inject a charter when a NEW turn completed since the last one. */
  lastCharterTurn: number;
  repairedOnce: boolean;
  escalatedOnce: boolean;
  hadDelivery: boolean;
  lastText: string | undefined;
  lastUserSignal: UserSignal | undefined;
  lastInjectionSignal: InjectionSignal | undefined;
  lastTurnSignal: TurnSignal | undefined;
};

export type DoctrineWriter = (bindingId: string, text: string) => boolean | Promise<boolean>;
export type EscalationHandler = (bindingId: string, reason: string) => void;
/**
 * Resolves the seat's CURRENT edge context so re-delivered doctrine is the
 * same compiled body the seat would receive at spawn — one prompt, dynamic
 * only by edges. Wired by main/vellum/ipc.ts from the live canvas.
 */
export type ContextProvider = (
  bindingId: string,
) => InjectionContext | Promise<InjectionContext>;

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
  private writer: DoctrineWriter | undefined;
  private escalationHandler: EscalationHandler | undefined;
  private contextProvider: ContextProvider | undefined;
  private now: () => number = Date.now;

  setWriter(writer: DoctrineWriter): void {
    this.writer = writer;
  }

  setEscalationHandler(handler: EscalationHandler): void {
    this.escalationHandler = handler;
  }

  setContextProvider(provider: ContextProvider): void {
    this.contextProvider = provider;
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
        prevTurn: "none",
        lastSeenSeq: undefined,
        lastUserInputAt: this.userInputBindings.get(bindingId),
        lastOutputAt: undefined,
        lastActedKind: undefined,
        lastCharterTurn: -1,
        repairedOnce: false,
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

  /** User keystrokes routed to the PTY (from the terminal write IPC). */
  noteUserInput(bindingId: string, at: number = this.now()): void {
    // Sticky: input may arrive before the seat's first snapshot.
    this.userInputBindings.set(bindingId, at);
    const seat = this.seats.get(bindingId);
    if (seat) seat.lastUserInputAt = at;
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
   * applies heuristics, and runs the decision matrix with dedup.
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

    // Turn-boundary counting (turn budget, never wall clock).
    if (
      seat.prevTurn === "in-turn" &&
      inter.turn === "ended" &&
      !seat.proven
    ) {
      seat.turnsWithoutProof += 1;
    }
    seat.prevTurn = inter.turn;

    // Output-region heuristics (awareness / env / protocol failure classes).
    // Only rescan when the screen text actually changed.
    const textChanged = seat.lastText !== snap.text;
    if (textChanged) {
      seat.lastText = snap.text;
      for (const hit of scanHeuristics(snap.text)) {
        this.applyHeuristic(seat, hit);
      }
    }

    if (inter.injection === "live" || inter.injection === "in-flight") {
      seat.hadDelivery = true;
    }
    if (inter.injection === "consumed") {
      seat.hadDelivery = true;
    }

    // Event-gate (not a throttle): the full policy decision only runs when
    // something decision-relevant changed — text, interaction signals, or
    // turn state. Identical frames are skipped; no wall clock involved.
    const signalsChanged =
      textChanged ||
      inter.user !== seat.lastUserSignal ||
      inter.injection !== seat.lastInjectionSignal ||
      inter.turn !== seat.lastTurnSignal;
    if (!signalsChanged) return;
    seat.lastUserSignal = inter.user;
    seat.lastInjectionSignal = inter.injection;
    seat.lastTurnSignal = inter.turn;

    this.runDecision(snap.bindingId, seat, inter);
  }

  private applyHeuristic(seat: SeatSupervision, hit: HeuristicHit): void {
    // Proof is final: once the seat's process called the work plane, no
    // screen phrase can downgrade it back to confused/env-broken.
    if (seat.proven) return;
    switch (hit.class) {
      case "awareness":
        if (seat.awareness === "unproven" || seat.awareness === "proven") {
          seat.awareness = "confused";
        }
        break;
      case "env":
        if (seat.awareness === "unproven" || seat.awareness === "confused") {
          seat.awareness = "env-broken";
        }
        break;
      case "protocol":
        if (seat.awareness === "unproven") {
          seat.awareness = "socket-down";
        }
        break;
    }
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
    };
    const decision = decideIntervention(ctx);

    // Doctrine re-delivery only on new completed turns since the last one.
    if (
      decision.kind === "inject-doctrine" &&
      seat.turnsWithoutProof <= seat.lastCharterTurn
    ) {
      return;
    }
    // Dedup: identical decisions are not re-acted. Doctrine re-delivery is
    // governed by the new-turn check above, so it is exempt from same-kind
    // dedup.
    if (
      decision.kind !== "inject-doctrine" &&
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
      case "inject-doctrine": {
        seat.lastActedKind = "inject-doctrine";
        seat.lastCharterTurn = seat.turnsWithoutProof;
        // Synchronous when no provider (deterministic, testable); async via
        // the live-canvas provider in production.
        if (this.contextProvider === undefined) {
          const body = buildInjectionText({
            seatBound: true,
            connected: false,
            seatRef: bindingId,
          });
          if (body !== null) {
            const payload = appendBootstrapMarker(body, bindingId);
            void this.writer?.(bindingId, payload);
          }
        } else {
          void this.deliverDoctrine(bindingId);
        }
        return;
      }
      case "repair-env": {
        if (seat.repairedOnce) return;
        seat.repairedOnce = true;
        seat.lastActedKind = "repair-env";
        const cliPath = this.resolveCliAbsolutePath();
        if (cliPath === undefined) {
          seat.awareness = "env-broken";
          return;
        }
        const payload = appendBootstrapMarker(
          buildRepairEnvNudge(cliPath, bindingId),
          bindingId,
        );
        void this.writer?.(bindingId, payload);
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

  /**
   * Deliver the SAME compiled doctrine the seat would receive at spawn —
   * buildInjectionText(ctx) resolved from the seat's current edge context.
   * Marker is a transport tag appended by the delivery layer, not content.
   */
  private async deliverDoctrine(bindingId: string): Promise<void> {
    const ctx = await this.resolveContext(bindingId);
    const body = buildInjectionText(ctx);
    if (body === null) return;
    const payload = appendBootstrapMarker(body, bindingId);
    void this.writer?.(bindingId, payload);
  }

  private async resolveContext(
    bindingId: string,
  ): Promise<InjectionContext> {
    if (this.contextProvider !== undefined) {
      try {
        return await this.contextProvider(bindingId);
      } catch {
        // Fall through to the base context — a seat is always a seat.
      }
    }
    return { seatBound: true, connected: false, seatRef: bindingId };
  }

  private resolveCliAbsolutePath(): string | undefined {
    const prefixes = vellumCliPathPrefixes();
    for (const prefix of prefixes) {
      const candidate = `${prefix}/vellum-command`;
      try {
        if (existsSync(candidate)) return candidate;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  /** Resolve the binary path for tests / callers. */
  resolveCliPathForTest(): string | undefined {
    return this.resolveCliAbsolutePath();
  }
}

const seatStateOf = (seat: SeatSupervision): SeatSignal => seat.state;

/** Process-wide supervisor singleton (wired by main/vellum/ipc.ts). */
export const injectionSupervisor = new InjectionSupervisor();
