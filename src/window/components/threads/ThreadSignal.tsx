import { Check, Clock, CornerDownRight, Undo2, X, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { AgentSignalState, SeatRaiseKind } from "@shared/wire/agent-signals";
import { waitingForSeats } from "../../lib/seat-threads";
import { KIND_ICON } from "../feed/FeedCardView";
import { Button } from "../ui/Button";

// How a signal reads inside a thread, from props alone: no store, no IPC. A
// seat raises a signal as its next message in a thread, so the thread shows
// it as that message in a frame that says its kind and where it stands, the
// operator's answer says what it answered, and the reply field says what a
// reply will answer before it is sent. The glyph and the hue of a kind are
// the feed's own, so a signal looks the same kind here as on its card.

/** What a signal asks the operator to hand in, when a reply alone does not close it. */
export type SignalWork = "document" | "proof" | "secret";

/** A signal as a thread carries it. */
export type ThreadSignal = {
  readonly signalId: string;
  readonly kind: SeatRaiseKind;
  readonly state: AgentSignalState;
  /** Present on a signal that asks for work: it stays open until the work is handed in. */
  readonly work?: SignalWork;
};

/** The kind, as a thread names it. */
export const SIGNAL_KIND_WORD: Readonly<Record<SeatRaiseKind, string>> = {
  blocked: "Blocked",
  escalate: "Escalate",
  feedback: "Feedback",
};

/** Where a signal stands. Only an open one is in ink; a closed one carries its glyph. */
const STATE: Readonly<Record<AgentSignalState, { readonly word: string; readonly icon?: LucideIcon }>> = {
  open: { word: "Open" },
  answered: { word: "Answered", icon: Check },
  dismissed: { word: "Dismissed", icon: X },
  withdrawn: { word: "Withdrawn", icon: Undo2 },
};

const WORK_WORD: Readonly<Record<SignalWork, string>> = {
  document: "a document",
  proof: "proof",
  secret: "a secret",
};

/** The kind's word in the kind's ink. */
function KindWord({ kind }: { readonly kind: SeatRaiseKind }) {
  return (
    <span className="seat-threads__signal-kind" data-signal-kind={kind}>
      {SIGNAL_KIND_WORD[kind]}
    </span>
  );
}

/**
 * The seat's message that is a signal: the message as it always reads, held
 * in a frame whose top line says the kind and the state. Colour is never the
 * only sign: the words say both. A signal that asks for work carries Hand in
 * while it is open; a plain one has no button, since the reply answers it.
 */
export function SignalFrame({
  signal,
  onHandIn,
  children,
}: {
  readonly signal: ThreadSignal;
  /** Open Needs you on this signal, where the work is handed in. */
  readonly onHandIn: (signalId: string) => void;
  /** The message: its head, its words, its files. */
  readonly children: ReactNode;
}) {
  const KindIcon = KIND_ICON[signal.kind];
  const state = STATE[signal.state];
  const StateIcon = state.icon;
  return (
    <div
      className="seat-threads__signal"
      data-signal-kind={signal.kind}
      data-state={signal.state}
      data-testid="seat-threads-signal"
    >
      <p className="seat-threads__signal-line">
        <KindIcon size={11} strokeWidth={2.25} aria-hidden />
        <KindWord kind={signal.kind} />
        <span className="sr-only">, </span>
        <span className="seat-threads__signal-state" data-testid="seat-threads-signal-state">
          {StateIcon ? <StateIcon size={11} strokeWidth={2.25} aria-hidden /> : null}
          {state.word}
        </span>
      </p>
      {children}
      {signal.state === "open" && signal.work !== undefined ? (
        <Button
          size="sm"
          variant="chrome"
          className="seat-threads__signal-hand-in"
          data-testid="seat-threads-signal-hand-in"
          onClick={() => onHandIn(signal.signalId)}
        >
          Hand in
        </Button>
      ) : null}
    </div>
  );
}

/** Above the operator's message that closed a signal: what it answered. */
export function AnswerTo({ kind }: { readonly kind: SeatRaiseKind }) {
  return (
    <p className="seat-threads__answer-to" data-testid="seat-threads-answer-to">
      <CornerDownRight size={11} strokeWidth={2.25} aria-hidden />
      <span>Answer to {SIGNAL_KIND_WORD[kind]}</span>
    </p>
  );
}

/**
 * Under the operator's own message that has not reached its seat. It stays
 * until the message is delivered and then goes: no timer, the read says so.
 */
export function WaitingMark({ name }: { readonly name: string }) {
  return (
    <p className="seat-threads__waiting" role="status" aria-live="polite" data-testid="seat-threads-waiting">
      <Clock size={11} strokeWidth={2.25} aria-hidden />
      <span>{waitingForSeats([name])}</span>
    </p>
  );
}

/**
 * In the reply field's frame, above the field: what a reply will answer. A
 * reply answers every open plain signal in the thread, so they are said as
 * one line, a button that brings the earliest into view. A signal that asks
 * for work is not closed by a reply: it says so, with Hand in. Nothing open,
 * nothing said. It reads the thread's live state, so it goes as the signals
 * close, not when Send is pressed.
 */
export function ReplyAnswers({
  open,
  onShow,
  onHandIn,
}: {
  /** The thread's open signals, earliest first. */
  readonly open: ReadonlyArray<ThreadSignal>;
  /** Bring this signal's message into view. */
  readonly onShow: (signalId: string) => void;
  readonly onHandIn: (signalId: string) => void;
}) {
  const plain = open.filter((signal) => signal.work === undefined);
  const asking = open.filter((signal) => signal.work !== undefined);
  const first = plain[0];
  if (first === undefined && asking.length === 0) return null;
  return (
    <div className="thread-composer__answers" data-testid="thread-composer-answers">
      {first !== undefined ? (
        <button
          type="button"
          className="thread-composer__answers-line thread-composer__answers-line--show"
          data-testid="thread-composer-answers-plain"
          onClick={() => onShow(first.signalId)}
        >
          <CornerDownRight size={11} strokeWidth={2.25} aria-hidden />
          {plain.length === 1 ? (
            <span>
              Your reply answers <KindWord kind={first.kind} />
            </span>
          ) : (
            <span>Your reply answers {plain.length} open signals</span>
          )}
        </button>
      ) : null}
      {asking.map((signal) =>
        signal.work === undefined ? null : (
          <p key={signal.signalId} className="thread-composer__answers-line" data-testid="thread-composer-answers-work">
            <CornerDownRight size={11} strokeWidth={2.25} aria-hidden />
            <span>
              Your reply leaves <KindWord kind={signal.kind} /> open: it asks for {WORK_WORD[signal.work]}.
            </span>
            <Button
              size="sm"
              variant="chrome"
              className="thread-composer__answers-hand-in"
              data-testid="thread-composer-answers-hand-in"
              onClick={() => onHandIn(signal.signalId)}
            >
              Hand in
            </Button>
          </p>
        ),
      )}
    </div>
  );
}
