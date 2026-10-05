/**
 * Injection supervisor — a seat's onboarding status and the nudge toward it.
 *
 * Nothing is sent to a seat at session start. A seat is onboarded once its
 * own process ran `junto onboard` in its current harness session; until then
 * the supervisor may type one sentence pointing there, at most twice per
 * generation, on the cadence in term/intervention/policy.ts. The status
 * follows the harness session: a resumed session reads back what it recorded,
 * so a seat that onboarded before a restart is not nudged again.
 *
 * The nudge does not wait for a turn to end, which can be hours: it is
 * interjected as soon as the message that started the turn is in and nothing
 * of the operator's is in its way (no draft, no dialog). The transport is the
 * drive's interjecting write, the one mail uses: it types mid-turn and yields
 * only to the operator composing in the seat.
 *
 * Driven by events, never wall clock: seat-state transitions, PTY snapshots
 * (composer changes), operator input, mail written into the seat, and the
 * `junto onboard` call itself.
 */

import type { ObserverGridSnapshot } from "./observer/types";
import {
  decideIntervention,
  type ComposerSignal,
  type InteractionContext,
  type OnboardingSignal,
  type SeatSignal,
} from "./intervention/policy";
import { buildOnboardNudge } from "@shared/managed-terminal-injection";
import type { AgentSeatStateEvent } from "@shared/agent-seat-state";
import type {
  SeatOnboardingEvent,
  SeatOnboardingStatus,
} from "@shared/seat-onboarding-status";

type SeatSupervision = {
  readonly epoch: string;
  state: SeatSignal;
  onboarding: OnboardingSignal;
  /** The onboarded status reached the session's record (or needs no record). */
  recorded: boolean;
  /** The operator typed into this generation's terminal. */
  operatorTyped: boolean;
  /** A draft the operator typed was seen in the composer. */
  operatorDraft: boolean;
  /** A first real message went into this generation's session. */
  firstMessageSeen: boolean;
  /** A counted turn is running. */
  inTurn: boolean;
  /** Turns started since the first message, or since the last nudge. */
  turnsWaited: number;
  nudgesDelivered: number;
  /** One transport request owns this generation's next nudge receipt. */
  nudgeInFlight: boolean;
};

export type NoticeWriter = (bindingId: string, text: string) => boolean | Promise<boolean>;
/** The composer as the drive's own gate reads it; null is unreadable. */
export type ComposerLookup = (bindingId: string) => "empty" | "draft" | null;
/** Read back whether the binding's current harness session already onboarded. */
export type OnboardedLoader = (bindingId: string) => Promise<boolean>;
/** Record the binding's current harness session as onboarded; false = not yet possible. */
export type OnboardedRecorder = (bindingId: string) => Promise<boolean>;
export type OnboardingListener = (event: SeatOnboardingEvent) => void;

/**
 * Pure per-seat supervision state. The class owns state + event handling;
 * PTY writes and the session record go through injected callbacks so this
 * module never imports the drive or the seat-session store.
 */
export class InjectionSupervisor {
  private readonly seats = new Map<string, SeatSupervision>();
  /** `junto onboard` calls that arrived before the seat's first event. */
  private readonly onboardedEarly = new Set<string>();
  /** Last settled status per binding, for a renderer that starts late. */
  private readonly statuses = new Map<string, SeatOnboardingEvent>();
  private readonly userInputBindings = new Map<string, number>();
  private readonly listeners = new Set<OnboardingListener>();
  private writer: NoticeWriter | undefined;
  private composer: ComposerLookup | undefined;
  private loader: OnboardedLoader | undefined;
  private recorder: OnboardedRecorder | undefined;
  private now: () => number = Date.now;

  setWriter(writer: NoticeWriter): void {
    this.writer = writer;
  }

  setComposerLookup(lookup: ComposerLookup): void {
    this.composer = lookup;
  }

  /** Where onboarding is remembered across generations of one harness session. */
  setOnboardedRecord(record: {
    readonly load: OnboardedLoader;
    readonly save: OnboardedRecorder;
  }): void {
    this.loader = record.load;
    this.recorder = record.save;
  }

  setNow(now: () => number): void {
    this.now = now;
  }

  /** Test seam. */
  clearForTest(): void {
    this.seats.clear();
    this.onboardedEarly.clear();
    this.statuses.clear();
  }

  subscribeOnboarding(listener: OnboardingListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Every seat's last settled status. */
  currentOnboarding(): ReadonlyArray<SeatOnboardingEvent> {
    return [...this.statuses.values()];
  }

  private publish(bindingId: string, status: SeatOnboardingStatus): void {
    if (this.statuses.get(bindingId)?.status === status) return;
    const event = { bindingId, status, at: this.now() };
    this.statuses.set(bindingId, event);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error("[supervisor] onboarding listener failed:", error);
      }
    }
  }

  private ensure(bindingId: string, epoch: string): SeatSupervision {
    const existing = this.seats.get(bindingId);
    if (existing !== undefined && existing.epoch === epoch) return existing;
    const early = this.onboardedEarly.delete(bindingId);
    const seat: SeatSupervision = {
      epoch,
      state: "unknown",
      onboarding: early ? "onboarded" : "unknown",
      recorded: false,
      operatorTyped: false,
      operatorDraft: false,
      firstMessageSeen: false,
      inTurn: false,
      turnsWaited: 0,
      nudgesDelivered: 0,
      nudgeInFlight: false,
    };
    this.seats.set(bindingId, seat);
    if (early) {
      this.publish(bindingId, "onboarded");
      this.record(bindingId, seat);
      return seat;
    }
    const settle = (onboarded: boolean): void => {
      // A newer generation, or an onboard that landed meanwhile, wins.
      if (this.seats.get(bindingId) !== seat || seat.onboarding !== "unknown") return;
      seat.onboarding = onboarded ? "onboarded" : "not-onboarded";
      seat.recorded = onboarded;
      this.publish(bindingId, seat.onboarding);
      this.evaluate(bindingId, seat);
    };
    if (this.loader === undefined) settle(false);
    else void this.loader(bindingId).then(settle, () => settle(false));
    return seat;
  }

  private record(bindingId: string, seat: SeatSupervision): void {
    if (seat.recorded || seat.onboarding !== "onboarded") return;
    const recorder = this.recorder;
    if (recorder === undefined) {
      seat.recorded = true;
      return;
    }
    void recorder(bindingId).then(
      (saved) => {
        if (saved && this.seats.get(bindingId) === seat) seat.recorded = true;
      },
      () => {},
    );
  }

  /**
   * `junto onboard` ran from the seat's own process (process-bind proof) in
   * the binding's live generation. The only thing that onboards a seat.
   */
  noteOnboarded(bindingId: string | undefined): void {
    if (!bindingId) return;
    const seat = this.seats.get(bindingId);
    if (seat === undefined) {
      // The call may precede the seat's first event.
      this.onboardedEarly.add(bindingId);
      this.publish(bindingId, "onboarded");
      return;
    }
    seat.onboarding = "onboarded";
    this.publish(bindingId, "onboarded");
    this.record(bindingId, seat);
  }

  /** `junto onboard` ran in the harness session this binding is running now. */
  isOnboarded(bindingId: string): boolean {
    return (
      this.seats.get(bindingId)?.onboarding === "onboarded" ||
      this.onboardedEarly.has(bindingId)
    );
  }

  /**
   * Operator bytes routed to the PTY (from the terminal write IPC). A draft
   * the operator typed, followed by a turn, is a first message.
   */
  noteUserInput(bindingId: string, at: number = this.now()): void {
    this.userInputBindings.set(bindingId, at);
    const seat = this.seats.get(bindingId);
    if (seat === undefined) return;
    seat.operatorTyped = true;
    if (this.composer?.(bindingId) === "draft") seat.operatorDraft = true;
  }

  /** Last operator keystroke time for a binding, if any (process-local sticky). */
  lastUserInputAt(bindingId: string): number | undefined {
    return this.userInputBindings.get(bindingId);
  }

  /**
   * Mail was typed into the seat: a real message, whoever sent it, and the
   * start of a turn (or part of the one already running).
   */
  noteMailWritten(bindingId: string): void {
    const seat = this.seats.get(bindingId);
    if (seat === undefined) return;
    seat.firstMessageSeen = true;
    this.startTurn(seat);
    this.evaluate(bindingId, seat);
  }

  /** Count a turn once, however its start is learned. */
  private startTurn(seat: SeatSupervision): void {
    if (seat.inTurn) return;
    seat.inTurn = true;
    seat.turnsWaited += 1;
  }

  /**
   * A nudge reached the seat outside the cadence (the operator's button). It
   * counts as one of the generation's nudges, so the cadence does not repeat
   * what the operator just sent.
   */
  noteNudgeDelivered(bindingId: string): void {
    const seat = this.seats.get(bindingId);
    if (seat === undefined) return;
    seat.nudgesDelivered += 1;
    seat.turnsWaited = 0;
  }

  /** Seat-state machine events (idle/working/attention/gone/...). */
  noteSeatState(event: AgentSeatStateEvent): void {
    if (event.state === "gone") {
      // Generation exited: nothing of it carries over but the session's own
      // record, which the next generation reads back if it resumes.
      this.seats.delete(event.bindingId);
      this.onboardedEarly.delete(event.bindingId);
      return;
    }
    const seat = this.ensure(event.bindingId, event.epoch);
    const previous = seat.state;
    seat.state = event.state as SeatSignal;
    if (event.state === "working" && previous !== "working") {
      // The operator's draft left the composer and a turn began: it was sent.
      if (!seat.firstMessageSeen && seat.operatorDraft) seat.firstMessageSeen = true;
      if (seat.firstMessageSeen) this.startTurn(seat);
    }
    if (event.state === "idle" && seat.inTurn) {
      seat.inTurn = false;
      // A session id captured at this boundary may make the record writable.
      this.record(event.bindingId, seat);
    }
    this.evaluate(event.bindingId, seat);
  }

  /** PTY snapshot feed (observer global listener): the composer may have changed. */
  onSnapshot(snap: ObserverGridSnapshot): void {
    const seat = this.ensure(snap.bindingId, snap.epoch);
    if (
      seat.operatorTyped &&
      !seat.firstMessageSeen &&
      this.composer?.(snap.bindingId) === "draft"
    ) {
      seat.operatorDraft = true;
    }
    this.evaluate(snap.bindingId, seat);
  }

  private composerOf(bindingId: string): ComposerSignal {
    // Absent lookup = test seam, like the drive's.
    if (this.composer === undefined) return "empty";
    return this.composer(bindingId) ?? "unreadable";
  }

  private evaluate(bindingId: string, seat: SeatSupervision): void {
    if (seat.nudgeInFlight) return;
    const ctx: InteractionContext = {
      seat: seat.state,
      composer: this.composerOf(bindingId),
      onboarding: seat.onboarding,
      firstMessageSeen: seat.firstMessageSeen,
      turnsWaited: seat.turnsWaited,
      nudgesDelivered: seat.nudgesDelivered,
    };
    if (decideIntervention(ctx).kind !== "nudge") return;
    const writer = this.writer;
    if (writer === undefined) return;
    // Reserve before invoking the writer: synchronous observer callbacks and
    // later turn events must not request an overlapping nudge.
    seat.nudgeInFlight = true;
    const waitedAtSend = seat.turnsWaited;
    const settle = (accepted: boolean): void => {
      if (this.seats.get(bindingId) !== seat) return;
      seat.nudgeInFlight = false;
      // A refused nudge spends nothing: the next event tries again.
      if (!accepted) return;
      seat.nudgesDelivered += 1;
      // Turns that started while the receipt was pending still count toward
      // the next nudge.
      seat.turnsWaited = Math.max(0, seat.turnsWaited - waitedAtSend);
    };
    try {
      const result = writer(bindingId, buildOnboardNudge());
      if (typeof result === "boolean") settle(result);
      else void result.then(settle, () => settle(false));
    } catch {
      settle(false);
    }
  }
}

/** Process-wide supervisor singleton (wired by main/junto/ipc.ts). */
export const injectionSupervisor = new InjectionSupervisor();
