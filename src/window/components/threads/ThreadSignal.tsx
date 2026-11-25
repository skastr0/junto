import { Check, Clock, CornerDownRight, Undo2, X, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { FEED_KIND_LABEL } from "@shared/operator-feed";
import type { AgentSignalState, SeatRaiseKind } from "@shared/wire/agent-signals";
import { waitingForSeats } from "../../lib/seat-threads";
import { KIND_ICON } from "../feed/FeedCardView";
import { Button } from "../ui/Button";
import { ThreadHeadline, threadHeadlineText } from "./ThreadHeadline";

// How a signal reads inside a thread, from props alone: no store, no IPC. A
// seat raises a signal as its next message in a thread, so the thread shows
// it as that message in a frame that says its kind and where it stands, the
// operator's answer says what it answered, and the reply field says what a
// reply will answer before it is sent. The glyph, the hue and the name of a
// kind are the feed's own, so a signal is the same kind here as on its card.
// A line that speaks of one signal names it by its own headline, which also
// says which one when a thread holds several. A headline is a whole sentence
// with its own end, so it always comes last, after a colon.

/** What a signal asks the operator to hand in, when a reply alone does not close it. */
export type SignalAsks = "document" | "proof" | "secret";

/** A signal as a thread carries it. */
export type ThreadSignal = {
  readonly signalId: string;
  readonly kind: SeatRaiseKind;
  readonly state: AgentSignalState;
  /** Its one sentence, as the seat raised it. */
  readonly text: string;
  /** Present on a signal that asks for work: it stays open until the work is handed in. */
  readonly asks?: SignalAsks;
  /** Withdrawn by its seat before the operator's answer reached it. */
  readonly crossed?: true;
};

/** The feed's name for a kind, as it starts a line: "Waiting on you". */
export const signalKindWord = (kind: SeatRaiseKind): string => {
  const word = FEED_KIND_LABEL[kind];
  return `${word.charAt(0).toUpperCase()}${word.slice(1)}`;
};

/** Where a signal stands. Only an open one is in ink; a closed one carries its glyph. */
const STATE: Readonly<Record<AgentSignalState, { readonly word: string; readonly icon?: LucideIcon }>> = {
  open: { word: "Open" },
  answered: { word: "Answered", icon: Check },
  dismissed: { word: "Dismissed", icon: X },
  withdrawn: { word: "Withdrawn", icon: Undo2 },
};

/**
 * What a signal's message is called when the keyboard lands on it: its kind
 * and where it stands, then its headline, as the feed names a card.
 */
export const signalName = (signal: ThreadSignal, known: ReadonlyArray<string>): string =>
  `${signalKindWord(signal.kind)}, ${STATE[signal.state].word.toLowerCase()}: ${threadHeadlineText(signal.text, known)}`;

const ASKS_WORD: Readonly<Record<SignalAsks, string>> = {
  document: "a document",
  proof: "proof",
  secret: "a secret",
};

/** A signal named inside a sentence: its headline, on one line, cut where the line ends. */
function SignalHeadline({ text, known }: { readonly text: string; readonly known: ReadonlyArray<string> }) {
  return (
    <span className="seat-threads__signal-headline" data-testid="seat-threads-signal-headline">
      <ThreadHeadline text={text} known={known} />
    </span>
  );
}

/**
 * In a thread's list row, before the unread count: the thread has an open
 * signal. The kind's glyph in its ink, and the words for a screen reader.
 */
export function RowSignal({ kind }: { readonly kind: SeatRaiseKind }) {
  const KindIcon = KIND_ICON[kind];
  return (
    <span className="seat-threads__row-signal" data-signal-kind={kind} data-testid="seat-threads-row-signal">
      <KindIcon size={12} strokeWidth={2.25} aria-hidden />
      <span className="sr-only">open, {FEED_KIND_LABEL[kind]}</span>
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
  author,
  known,
  onHandIn,
  children,
}: {
  readonly signal: ThreadSignal;
  /** The seat that raised it, by name. */
  readonly author: string;
  /** Who is in the thread, so Hand in is named by the signal's headline without a leading name. */
  readonly known: ReadonlyArray<string>;
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
        <span className="seat-threads__signal-kind">{signalKindWord(signal.kind)}</span>
        <span className="sr-only">, </span>
        <span className="seat-threads__signal-state" data-testid="seat-threads-signal-state">
          {StateIcon ? <StateIcon size={11} strokeWidth={2.25} aria-hidden /> : null}
          {state.word}
        </span>
      </p>
      {children}
      {signal.state === "withdrawn" && signal.crossed ? (
        // The answer and the withdrawal crossed. Nothing failed, so it is said plainly, here on the signal, as the seat's own statement (it is not fact the operator's machine can check).
        <p className="seat-threads__signal-note" data-testid="seat-threads-signal-crossed">
          {author} says it withdrew this before your answer reached it.
        </p>
      ) : null}
      {signal.state === "open" && signal.asks !== undefined ? (
        <Button
          size="sm"
          variant="chrome"
          className="seat-threads__signal-hand-in"
          data-testid="seat-threads-signal-hand-in"
          aria-label={`Hand in: ${threadHeadlineText(signal.text, known)}`}
          onClick={() => onHandIn(signal.signalId)}
        >
          Hand in
        </Button>
      ) : null}
    </div>
  );
}

/** Above the operator's message that closed a signal: what it answered, by that signal's headline. */
export function AnswerTo({
  text,
  known,
}: {
  /** The answered signal's sentence. */
  readonly text: string;
  /** Who is in the thread, so a name at the head of the sentence is not read as part of it. */
  readonly known: ReadonlyArray<string>;
}) {
  return (
    <p className="seat-threads__answer-to" data-testid="seat-threads-answer-to">
      <CornerDownRight size={11} strokeWidth={2.25} aria-hidden />
      <span className="seat-threads__signal-lead">Answer to:</span>{" "}
      <SignalHeadline text={text} known={known} />
    </p>
  );
}

/**
 * Under the operator's own message that has not reached its seat. It stays
 * until the message is delivered and then goes: no timer, the read says so.
 * Plain words, not a status: a thread can hold many of them, and its history
 * is never said aloud. The send that comes back waiting is said by `ThreadSaid`.
 */
export function WaitingMark({ name }: { readonly name: string }) {
  return (
    <p className="seat-threads__waiting" data-testid="seat-threads-waiting">
      <Clock size={11} strokeWidth={2.25} aria-hidden />
      <span>{waitingForSeats([name])}</span>
    </p>
  );
}

/** A line said aloud, and which saying it is: the same words said twice are two sayings. */
export type Said = { readonly text: string; readonly turn: number };

/** What is said when the operator's send comes back with its seat away. */
export const sentWaiting = (name: string): string => `Sent. ${waitingForSeats([name])}`;

/** What is said when mail sent here, that was waiting, reaches its seat. */
export const sentArrived = (name: string): string => `${name} has it.`;

/**
 * The one place a thread speaks to a screen reader. It is in the document for
 * its host's life and empty until there is something to say, because a live
 * region that arrives with its words is not reliably said. Each saying is a
 * new node inside it, so the same words twice are said twice.
 */
export function ThreadSaid({ said }: { readonly said: Said | undefined }) {
  return (
    <div className="sr-only" role="status" aria-live="polite" data-testid="seat-threads-said">
      {said === undefined ? null : <span key={said.turn}>{said.text}</span>}
    </div>
  );
}

/**
 * In the reply field's frame, above the field: what a reply will answer. A
 * reply answers every open plain signal in the thread, so they are said as
 * one line, a button that brings the earliest into view: the one signal by
 * its headline, several by their count. A signal that asks for work is not
 * closed by a reply: it says what closes it, with Hand in. Nothing open,
 * nothing said. It reads the thread's live state, so it goes as the signals
 * close, not when Send is pressed.
 */
export function ReplyAnswers({
  id,
  open,
  known,
  onShow,
  onHandIn,
}: {
  /** The block's id: the reply field is described by it, while it is there. */
  readonly id?: string;
  /** The thread's open signals, earliest first. */
  readonly open: ReadonlyArray<ThreadSignal>;
  /** Who is in the thread. */
  readonly known: ReadonlyArray<string>;
  /** Bring this signal's message into view. */
  readonly onShow: (signalId: string) => void;
  readonly onHandIn: (signalId: string) => void;
}) {
  const plain = open.filter((signal) => signal.asks === undefined);
  const asking = open.filter((signal) => signal.asks !== undefined);
  const first = plain[0];
  if (first === undefined && asking.length === 0) return null;
  return (
    <div id={id} className="thread-composer__answers" data-testid="thread-composer-answers">
      {first !== undefined ? (
        <button
          type="button"
          className="thread-composer__answers-line thread-composer__answers-line--show"
          data-testid="thread-composer-answers-plain"
          // The name as one sentence: the pieces are laid side by side, so a
          // name read off them could run two words together.
          aria-label={
            plain.length === 1
              ? `Your reply answers: ${threadHeadlineText(first.text, known)}`
              : `Your reply answers ${String(plain.length)} open signals`
          }
          onClick={() => onShow(first.signalId)}
        >
          <CornerDownRight size={11} strokeWidth={2.25} aria-hidden />
          {plain.length === 1 ? (
            <>
              <span className="seat-threads__signal-lead">Your reply answers:</span>{" "}
              <SignalHeadline text={first.text} known={known} />
            </>
          ) : (
            <span className="seat-threads__signal-lead">Your reply answers {plain.length} open signals</span>
          )}
        </button>
      ) : null}
      {asking.map((signal) =>
        signal.asks === undefined ? null : (
          <p key={signal.signalId} className="thread-composer__answers-line" data-testid="thread-composer-answers-work">
            <CornerDownRight size={11} strokeWidth={2.25} aria-hidden />
            <span className="seat-threads__signal-lead">Stays open until {ASKS_WORD[signal.asks]} is handed in:</span>{" "}
            <SignalHeadline text={signal.text} known={known} />{" "}
            <Button
              size="sm"
              variant="chrome"
              className="thread-composer__answers-hand-in"
              data-testid="thread-composer-answers-hand-in"
              aria-label={`Hand in: ${threadHeadlineText(signal.text, known)}`}
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
