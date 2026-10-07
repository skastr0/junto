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
 * One more line may open a session: when a seat offboards with `--continue`,
 * the fresh session Junto starts for it is told to pick up its handoff. That
 * is the seat's own request, not a nudge. It is typed once, as the session's
 * first message, when the harness shows an empty composer and no dialog.
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
import { CONTINUATION_LINE } from "@shared/seat-sessions";
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
  /** The session's record is being read right now. */
  loading: boolean;
  /** The operator typed into this generation's terminal. */
  operatorTyped: boolean;
  /** A draft the operator typed was seen in the composer. */
  operatorDraft: boolean;
  /** Printable characters the operator typed since their last Enter. */
  typedSinceEnter: number;
  /** When the operator last pressed Enter on what reads as a message. */
  submittedAt: number | undefined;
  /** A first real message went into this generation's session. */
  firstMessageSeen: boolean;
  /** A counted turn is running. */
  inTurn: boolean;
  /** Turns started since the first message, or since the last nudge. */
  turnsWaited: number;
  nudgesDelivered: number;
  /** The seat ran `junto offboard`: this session waits to be closed. */
  closing: boolean;
  /** One transport request owns this generation's next nudge receipt. */
  nudgeInFlight: boolean;
};

/** Typed text shorter than this before Enter may be a dialog answer, not a message. */
const MESSAGE_MIN_CHARS = 2;
/** A turn that follows the operator's Enter starts within this; later ones are not theirs. */
const SUBMIT_TO_TURN_MS = 15_000;
/** Why the seat's input box is keeping the continuation line out. */
export type ContinuationHold = "draft" | "dialog" | "unreadable";

/** How soon a continuation line the terminal refused is offered again. */
const CONTINUATION_RETRY_MS = 1_000;
/** How long mail for a fresh session waits for its continuation line to go first. */
const CONTINUATION_FIRST_MS = 10_000;

/** Printable characters in operator bytes: escape sequences and controls are keys, not text. */
const printableCount = (data: string): number =>
  // CSI and SS3 sequences (arrows, paste markers, function keys), then controls.
  data.replace(/\u001b(?:\[[0-9;?]*[ -/]*[@-~]|O.|.)/g, "").replace(/[\u0000-\u001f\u007f]/g, "").length;

export type NoticeWriter = (bindingId: string, text: string) => boolean | Promise<boolean>;
/** The composer as the drive's own gate reads it; null is unreadable. */
export type ComposerLookup = (bindingId: string) => "empty" | "draft" | null;
/**
 * Read back whether the binding's current harness session already onboarded.
 * `undefined` means it cannot be told yet (the seat's canvas is not readable
 * right after a start, the seat is not bound yet): that is not "no". The
 * supervisor asks again and types nothing until it knows.
 */
export type OnboardedLoader = (bindingId: string) => Promise<boolean | undefined>;
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
  /**
   * Seats whose next generation continues an offboarded session, with the
   * generation that offboarded (never the one to tell).
   */
  private readonly continuations = new Map<
    string,
    { readonly notEpoch: string | undefined; freshSince?: number; holdTimer?: ReturnType<typeof setTimeout> }
  >();
  private readonly continuationClearedListeners = new Set<(bindingId: string) => void>();
  private readonly continuationHolds = new Map<string, ContinuationHold>();
  private readonly continuationHeldListeners = new Set<(bindingId: string, hold: ContinuationHold, line: string) => void>();
  private writer: NoticeWriter | undefined;
  private readonly continuationRetries = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly continuationWaits = new Map<string, string>();
  private continuationLog: ((message: string) => void) | undefined;
  private continuationWriter: NoticeWriter | undefined;
  private continuationSettled: ((bindingId: string) => void) | undefined;
  private composer: ComposerLookup | undefined;
  private loader: OnboardedLoader | undefined;
  private recorder: OnboardedRecorder | undefined;
  private now: () => number = Date.now;

  setWriter(writer: NoticeWriter): void {
    this.writer = writer;
  }

  /**
   * How the continuation line is typed: the drive's gated write, which types
   * only into an idle seat with a proven-empty composer.
   */
  setContinuationWriter(writer: NoticeWriter): void {
    this.continuationWriter = writer;
  }

  /** Told when a seat is no longer owed its continuation line. */
  setContinuationSettled(listener: (bindingId: string) => void): void {
    this.continuationSettled = listener;
  }

  /**
   * Why a continuation line is still owed, said once per reason: a session
   * left silent after `--continue` must be explainable from the log.
   */
  private noteContinuationWait(bindingId: string, reason: string): void {
    if (this.continuationWaits.get(bindingId) === reason) return;
    this.continuationWaits.set(bindingId, reason);
    this.continuationLog?.(`${bindingId}: the continuation line is waiting: ${reason}`);
  }

  /** Where the supervisor says why a continuation line is waiting, and that it was typed. */
  setContinuationLog(log: (message: string) => void): void {
    this.continuationLog = log;
  }

  /** Ask again shortly for a continuation line the terminal would not take. */
  private retryContinuation(bindingId: string): void {
    if (this.continuationRetries.has(bindingId)) return;
    const timer = setTimeout(() => {
      this.continuationRetries.delete(bindingId);
      const seat = this.seats.get(bindingId);
      if (seat === undefined || !this.continuations.has(bindingId)) return;
      this.loadStatus(bindingId, seat);
      this.evaluate(bindingId, seat);
    }, CONTINUATION_RETRY_MS);
    timer.unref?.();
    this.continuationRetries.set(bindingId, timer);
  }

  /** The close that owed a continuation failed: forget it, type nothing. */
  disarmContinuation(bindingId: string): void {
    this.dropContinuation(bindingId);
  }

  private settleContinuation(bindingId: string): void {
    if (this.continuationWaits.delete(bindingId)) {
      this.continuationLog?.(`${bindingId}: the continuation line is no longer waiting`);
    }
    this.dropContinuation(bindingId);
    try {
      this.continuationSettled?.(bindingId);
    } catch (error) {
      console.error("[supervisor] continuation listener failed:", error);
    }
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
    this.continuations.clear();
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
      loading: false,
      operatorTyped: false,
      operatorDraft: false,
      typedSinceEnter: 0,
      submittedAt: undefined,
      firstMessageSeen: false,
      inTurn: false,
      turnsWaited: 0,
      nudgesDelivered: 0,
      closing: false,
      nudgeInFlight: false,
    };
    this.seats.set(bindingId, seat);
    if (early) {
      this.publish(bindingId, "onboarded");
      this.record(bindingId, seat);
      return seat;
    }
    this.loadStatus(bindingId, seat);
    return seat;
  }

  /**
   * Ask the session's record whether it onboarded. Until the record can be
   * read the status stays unknown, and unknown types nothing: taking "cannot
   * tell" for "no" nudged seats that had onboarded, after a restart.
   */
  private loadStatus(bindingId: string, seat: SeatSupervision): void {
    if (seat.onboarding !== "unknown" || seat.loading) return;
    const settle = (onboarded: boolean | undefined): void => {
      seat.loading = false;
      // A newer generation, or an onboard that landed meanwhile, wins.
      if (this.seats.get(bindingId) !== seat || seat.onboarding !== "unknown") return;
      // Not readable yet: the next event for this seat asks again.
      if (onboarded === undefined) return;
      seat.onboarding = onboarded ? "onboarded" : "not-onboarded";
      seat.recorded = onboarded;
      this.publish(bindingId, seat.onboarding);
      this.evaluate(bindingId, seat);
    };
    if (this.loader === undefined) {
      settle(false);
      return;
    }
    seat.loading = true;
    void this.loader(bindingId).then(settle, () => settle(undefined));
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

  /**
   * `junto offboard` ran from the seat's own process: its notes are saved and
   * the session waits to be closed at its next idle moment. From here to the
   * end of this generation it is not nudged; a nudge would start a turn in a
   * session that is about to end. The generation that replaces it is new.
   */
  noteOffboardSaved(bindingId: string | undefined): void {
    if (!bindingId) return;
    const seat = this.seats.get(bindingId);
    if (seat !== undefined) seat.closing = true;
  }

  /** `junto onboard` ran in the harness session this binding is running now. */
  isOnboarded(bindingId: string): boolean {
    return (
      this.seats.get(bindingId)?.onboarding === "onboarded" ||
      this.onboardedEarly.has(bindingId)
    );
  }

  /**
   * Operator bytes routed to the PTY (from the terminal write IPC). A message
   * the operator typed and sent, followed by a turn, is a first message.
   *
   * "Sent" is read off the bytes, not off a draft frame: a fast typist or a
   * paste can reach Enter before the observer ever paints the draft, and some
   * harnesses paint a draft the probes cannot read. Enter counts when the
   * composer reads as a draft or as empty (the paint lags the keys), or when
   * the operator typed a message's worth of text before it. A lone Enter or a
   * one-key answer on a screen the probes cannot read is a dialog being
   * answered, and a seat in attention is one by definition.
   */
  noteUserInput(bindingId: string, at: number = this.now(), data = ""): void {
    this.userInputBindings.set(bindingId, at);
    const seat = this.seats.get(bindingId);
    if (seat === undefined) return;
    seat.operatorTyped = true;
    const verdict = this.composer?.(bindingId);
    if (verdict === "draft") seat.operatorDraft = true;
    const enter = data.search(/[\r\n]/);
    seat.typedSinceEnter += printableCount(enter === -1 ? data : data.slice(0, enter));
    if (enter === -1) return;
    const reads = verdict === "draft" || seat.operatorDraft || (verdict === "empty" && seat.typedSinceEnter > 0);
    if (seat.state !== "attention" && (reads || seat.typedSinceEnter >= MESSAGE_MIN_CHARS)) {
      seat.submittedAt = at;
    }
    seat.typedSinceEnter = printableCount(data.slice(enter + 1));
  }

  /**
   * The seat's input box became typeable again after the drive held a write
   * for it (a fresh keystroke, a draft, a dialog, an unread box). A nudge
   * that was held then goes out now: held is not dropped, and it has not
   * been counted.
   */
  noteWritable(bindingId: string): void {
    const seat = this.seats.get(bindingId);
    if (seat !== undefined) this.evaluate(bindingId, seat);
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
    this.loadStatus(bindingId, seat);
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
   * The seat offboarded with `--continue` and Junto is starting its fresh
   * session: tell that session, once, to read its handoff. The only caller is
   * the continuation ledger, on behalf of the offboard closer (and again for
   * what a previous run still owed); a seat started any other way is told
   * nothing.
   */
  armContinuation(bindingId: string, offboarded: string | undefined): void {
    this.continuations.set(bindingId, { notEpoch: offboarded });
    const seat = this.seats.get(bindingId);
    if (seat !== undefined) this.evaluate(bindingId, seat);
  }

  /**
   * The generation live on a binding now. Read before a rotation, it names
   * the generation that offboarded; by the time the rotation returns, the
   * fresh one may already be up.
   */
  generationOf(bindingId: string): string | undefined {
    return this.seats.get(bindingId)?.epoch;
  }

  /**
   * Mail for this seat waits, briefly, for its continuation line. The line
   * was owed first and is the fresh session's first message; mail typed
   * ahead of it starts a turn that can keep the line out for as long as the
   * turn runs. Bounded: mail is never held hostage by a line that cannot land.
   */
  continuationHoldsMail(bindingId: string): boolean {
    const armed = this.continuations.get(bindingId);
    const seat = this.seats.get(bindingId);
    // The generation that offboarded is never told, so its mail is not held.
    // A fresh one the supervisor has not heard of yet is held all the same:
    // mail can hear a seat come up first.
    if (armed === undefined || (seat !== undefined && seat.epoch === armed.notEpoch)) return false;
    if (armed.freshSince === undefined) {
      armed.freshSince = this.now();
      armed.holdTimer = setTimeout(() => this.tellContinuationCleared(bindingId), CONTINUATION_FIRST_MS);
      armed.holdTimer.unref?.();
    }
    return this.now() - armed.freshSince < CONTINUATION_FIRST_MS;
  }

  /**
   * Told when the continuation line is held by the seat's input box, once
   * per reason, so the seat can say so the way it says held mail.
   */
  subscribeContinuationHeld(listener: (bindingId: string, hold: ContinuationHold, line: string) => void): () => void {
    this.continuationHeldListeners.add(listener);
    return () => {
      this.continuationHeldListeners.delete(listener);
    };
  }

  private tellContinuationHeld(bindingId: string, hold: ContinuationHold): void {
    if (this.continuationHolds.get(bindingId) === hold) return;
    this.continuationHolds.set(bindingId, hold);
    for (const listener of [...this.continuationHeldListeners]) {
      try {
        listener(bindingId, hold, CONTINUATION_LINE);
      } catch {
        // A listener's failure is its own; the line is still owed.
      }
    }
  }

  /** Told when mail for a seat no longer waits for its continuation line. */
  subscribeContinuationCleared(listener: (bindingId: string) => void): () => void {
    this.continuationClearedListeners.add(listener);
    return () => {
      this.continuationClearedListeners.delete(listener);
    };
  }

  private tellContinuationCleared(bindingId: string): void {
    for (const listener of [...this.continuationClearedListeners]) {
      try {
        listener(bindingId);
      } catch {
        // A listener's failure is its own; the line's state is unchanged.
      }
    }
  }

  private dropContinuation(bindingId: string): boolean {
    const armed = this.continuations.get(bindingId);
    if (armed === undefined) return false;
    if (armed.holdTimer !== undefined) clearTimeout(armed.holdTimer);
    this.continuations.delete(bindingId);
    this.continuationHolds.delete(bindingId);
    this.tellContinuationCleared(bindingId);
    return true;
  }

  /** A fresh session is still waiting to be told to continue. */
  continuationPending(bindingId: string): boolean {
    return this.continuations.has(bindingId);
  }

  /**
   * Type the continuation line into the fresh generation when it can take
   * it. True while the continuation owns this seat's next write, so no nudge
   * goes out ahead of it.
   */
  private continueSession(bindingId: string, seat: SeatSupervision): boolean {
    const armed = this.continuations.get(bindingId);
    if (armed === undefined || armed.notEpoch === seat.epoch) return false;
    // Every wait below is asked about again unprompted: a seat at rest, or
    // one deep in a turn, may say nothing more for a long time.
    const wait = (reason: string): true => {
      this.noteContinuationWait(bindingId, reason);
      this.retryContinuation(bindingId);
      return true;
    };
    if (seat.onboarding === "unknown") {
      return wait("it is not yet known whether the fresh session has onboarded");
    }
    if (seat.onboarding === "onboarded") {
      // It already read its handoff: nothing left to say.
      this.settleContinuation(bindingId);
      return false;
    }
    // Typed where mail would be: at an idle, empty box, or into a turn that
    // something else already started (the operator's prompt can reach the
    // fresh session first, and that turn may run for hours). Never on a
    // dialog, a draft, or a box that cannot be read at rest.
    const composer = this.composerOf(bindingId);
    const typeable =
      (seat.state === "idle" && composer === "empty") || (seat.state === "working" && composer !== "draft");
    if (!typeable) {
      // Said on the seat as held mail is: the operator's draft, a dialog, or
      // a box that cannot be read are theirs to clear.
      const hold =
        composer === "draft"
          ? "draft"
          : seat.state === "attention"
            ? "dialog"
            : seat.state === "idle" && composer === "unreadable"
              ? "unreadable"
              : undefined;
      if (hold !== undefined) this.tellContinuationHeld(bindingId, hold);
      return wait(`its input box cannot take it (seat ${seat.state}, box ${composer})`);
    }
    const writer = this.continuationWriter;
    if (writer === undefined) return wait("nothing is wired to type it");
    seat.nudgeInFlight = true;
    const settle = (accepted: boolean): void => {
      if (this.seats.get(bindingId) !== seat) return;
      seat.nudgeInFlight = false;
      if (!accepted) {
        // Refused for now (the terminal is not ready, the operator is
        // typing). A seat at rest tells nothing more, so ask again unprompted.
        wait(`the terminal refused it (seat ${seat.state}, box ${composer})`);
        return;
      }
      this.settleContinuation(bindingId);
      // The session's first message, and the turn it starts. The nudge
      // policy counts from here: that turn is not one of its own.
      seat.firstMessageSeen = true;
      seat.inTurn = true;
      seat.turnsWaited = 0;
    };
    try {
      const result = writer(bindingId, CONTINUATION_LINE);
      if (typeof result === "boolean") settle(result);
      else void result.then(settle, () => settle(false));
    } catch {
      settle(false);
    }
    return true;
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
    this.loadStatus(event.bindingId, seat);
    const previous = seat.state;
    seat.state = event.state as SeatSignal;
    if (event.state === "working" && previous !== "working") {
      // The operator sent a message and a turn began: that was the first.
      // A draft that left the composer says the same where no Enter was seen.
      const sent =
        seat.submittedAt !== undefined && this.now() - seat.submittedAt <= SUBMIT_TO_TURN_MS;
      if (!seat.firstMessageSeen && (sent || seat.operatorDraft)) seat.firstMessageSeen = true;
      seat.submittedAt = undefined;
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
    if (this.continueSession(bindingId, seat)) return;
    const ctx: InteractionContext = {
      seat: seat.state,
      composer: this.composerOf(bindingId),
      onboarding: seat.onboarding,
      firstMessageSeen: seat.firstMessageSeen,
      turnsWaited: seat.turnsWaited,
      nudgesDelivered: seat.nudgesDelivered,
      closing: seat.closing,
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
