import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { parseMentionHref } from "@shared/mention";
import type { SeatOpenView } from "@shared/settings";
import { titleOf } from "@shared/model/title";
import type { NodeId } from "@shared/physics/schema";
import {
  betweenLine,
  groupSeatThreads,
  loadMoreSeatThreads,
  loadOlderMessages,
  markSeatThreadRead,
  previewText,
  useSeatThreadMessages,
  useSeatThreads,
  useSeatUnread,
  WAITING_AFTER_MS,
  type SeatAddress,
  type SeatThreadSummary,
} from "../../lib/seat-threads";
import { claimFocus, deepActiveElement, focusPrimaryControl, isFocusClaimInFlight, recentGestureKind } from "../../lib/focus-ownership";
import { openNeedsYouOn } from "../../lib/operator-feed";
import { mentionChipOf, openMention, subjectChipOf, type MentionChip } from "../../lib/mention-open";
import { stripAuthorPreamble } from "../../lib/thread-text";
import { useCanvas } from "../../lib/use-model";
import { crossedLiveWords } from "@shared/signal-crossing";
import { answerHeldWords } from "../../lib/feed-exchange";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { Eyebrow } from "../ui/Eyebrow";
import { FocusWindowContext } from "../ui/FocusWindow";
import { InspectorTabs } from "../ui/InspectorTabs";
import { PaneHeader, TwoPane } from "../ui/TwoPane";
import { AgentPortrait } from "../AgentPortrait";
import { ArtifactMarkdown } from "../work/ArtifactMarkdown";
import { ResourceChip, ResourceGlyphMark, mentionMark } from "../ui/ResourceChip";
import { MessageAttachments } from "./MessageAttachments";
import { ThreadComposer, type SentMail } from "./ThreadComposer";
import { ThreadHeadline, threadHeadlineText } from "./ThreadHeadline";
import {
  AnswerTo,
  ReplyAnswers,
  RowSignal,
  sentArrived,
  sentWaiting,
  SignalFrame,
  signalName,
  ThreadSaid,
  WaitingMark,
  type Said,
} from "./ThreadSignal";
import { ThreadTime } from "./ThreadTime";
import { rehypeThreadCodeWells, rehypeThreadInlineIds } from "./thread-inline-ids";
import "./seat-threads.css";

/**
 * The switch in a seat's header, left of Params: Terminal and Threads, the two
 * views of the seat's stage. Its Threads half carries the operator's unread
 * count for that seat, on every device, whichever view shows: reading a thread
 * here, or on the phone, clears it. The count is the seat's total, not the
 * part of it the list happens to have paged in.
 */
export function SeatViewSwitch({
  seat,
  view,
  onSelect,
  controls,
}: {
  readonly seat: SeatAddress;
  readonly view: SeatOpenView;
  readonly onSelect: (view: SeatOpenView) => void;
  /** The id of the stage the two views share. */
  readonly controls: string;
}) {
  const unread = useSeatUnread(seat);
  // The Threads half is named with what its pill counts, in words: the pill
  // caps at 99+, and that is said as it is meant.
  const counted = unread > 99 ? "Threads, more than 99 unread" : `Threads, ${String(unread)} unread`;
  return (
    <InspectorTabs
      frame="chrome"
      label="Seat view"
      testId="seat-view"
      controls={controls}
      active={view}
      onSelect={(id) => onSelect(id === "threads" ? "threads" : "terminal")}
      tabs={[
        { id: "terminal", label: "Terminal" },
        { id: "threads", label: "Threads", badge: unread, ...(unread > 0 ? { title: counted } : {}) },
      ]}
    />
  );
}

/**
 * The seat's threads, laid over the stage of its open view: the same box the
 * terminal has, so the frame never moves on a switch. The seat's own header
 * closes and maximizes; nothing here does. Nothing is read until Threads first
 * shows. From then it stays in the document while the seat is open, hidden
 * behind Terminal, so a draft, the thread picked and the place read to are
 * there on the way back.
 */
export function SeatThreadsStage({
  seat,
  name,
  shown,
}: {
  readonly seat: SeatAddress;
  readonly name: string;
  /** Threads is the view on screen. Behind Terminal nothing is marked read. */
  readonly shown: boolean;
}) {
  const [opened, setOpened] = useState(shown);
  if (shown && !opened) setOpened(true);
  const shell = useRef<HTMLDivElement>(null);
  // Showing Threads puts the keyboard in the reply, when it is first shown
  // (the field takes it as it mounts) and each time after. Shown by a key on
  // the switch, the keyboard stays on the switch for as long as it is there,
  // so Left and Right keep moving between the two views.
  const byKey = useRef(false);
  const seen = useRef(shown);
  if (seen.current !== shown) {
    seen.current = shown;
    byKey.current = shown && recentGestureKind() === "key";
  }
  const yields = useCallback((): boolean => {
    // Behind Terminal nothing here takes the keyboard.
    if (!seen.current) return true;
    if (!byKey.current) return false;
    const active = deepActiveElement();
    if (active?.getAttribute("role") !== "tab") return false;
    const stage = document.getElementById(active.getAttribute("aria-controls") ?? "");
    return stage !== null && stage.contains(shell.current);
  }, []);
  useEffect(() => {
    if (shown && !yields()) focusPrimaryControl(shell.current);
  }, [shown, yields]);
  return (
    <div ref={shell} className="seat-threads__shell" data-testid="seat-threads" hidden={!shown} inert={!shown}>
      {opened ? (
        // The list's header offers no Maximize of its own: the seat's header has it.
        <FocusWindowContext.Provider value={null}>
          <SeatThreads seat={seat} name={name} shown={shown} yields={yields} />
        </FocusWindowContext.Provider>
      ) : null}
    </div>
  );
}

/** The markdown passes a thread needs, held once so a message's render stays memoized. */
const THREAD_MARKDOWN_PLUGINS = [rehypeThreadInlineIds, rehypeThreadCodeWells];

/**
 * A seat's portrait identity, read back from the name a thread carries: a seat
 * is its node id, so the canvas says which node wears that name, and a peer or
 * a removed seat wears the portrait its name draws.
 */
function usePortraitOf(canvasName: string): (author: string) => string {
  const nodes = useCanvas(canvasName).nodes;
  return useMemo(() => {
    const byTitle = new Map<string, string>();
    for (const node of nodes.values()) {
      if (node.kind === "agent" || node.kind === "peer") byTitle.set(titleOf(node), node.id);
    }
    return (author: string): string => byTitle.get(author) ?? author;
  }, [nodes]);
}

/** How far from the list's end, in pixels, the next older page is asked for. */
const LIST_NEAR_END = 400;
/** How far from the chat's top, in pixels, the next older page is asked for. */
const CHAT_NEAR_TOP = 240;
/** How long a chat is in the document before it says how the send that started its thread went. */
const SAID_AFTER_MOUNT_MS = 150;

/** Two messages from one seat this close together share a head: the second folds. */
const FOLD_MS = 10 * 60 * 1000;

type Selection =
  | {
      readonly kind: "thread";
      readonly threadId: string;
      /** Just started here, by this mail: held while the list has not read it yet. */
      readonly sent?: SentMail;
    }
  | { readonly kind: "new" };

/** The first thread to show: the newest with you, else the newest between seats. */
const firstThread = (threads: ReadonlyArray<SeatThreadSummary>): string | undefined => {
  const { withYou, betweenSeats } = groupSeatThreads(threads);
  return (withYou[0] ?? betweenSeats[0])?.threadId;
};

/**
 * The seat's threads: a list that collapses (TwoPane) beside one chat. The
 * list holds two groups, With you and Between seats, under New thread; the
 * chat takes the rest, oldest at the top, the operator's own on the right. A
 * thread between seats is read only.
 */
function SeatThreads({
  seat,
  name,
  shown,
  yields,
}: {
  readonly seat: SeatAddress;
  readonly name: string;
  readonly shown: boolean;
  readonly yields: () => boolean;
}) {
  const { threads, loaded, error, next, loadingMore } = useSeatThreads(seat);
  const portraitOf = usePortraitOf(seat.canvasName);
  const listRef = useRef<HTMLElement>(null);
  // The next older page when the list is scrolled near its end, or when what
  // is read does not yet fill the column and so cannot be scrolled. After a
  // failed page only the reader's next scroll asks again. A folded list has
  // no height and asks for nothing until it shows again, and neither does a
  // list behind Terminal.
  const fillList = (retry: boolean) => {
    const list = listRef.current;
    if (!shown || !list || list.clientHeight === 0 || next === undefined || loadingMore || (error !== "" && !retry)) return;
    if (list.scrollHeight - list.scrollTop - list.clientHeight < LIST_NEAR_END) void loadMoreSeatThreads(seat);
  };
  useEffect(() => fillList(false), [threads, next, loadingMore, error, shown]);
  // Unfolded, or grown by Maximize: fill what is in view now.
  const fillListNow = useRef(fillList);
  fillListNow.current = fillList;
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const observer = new ResizeObserver(() => fillListNow.current(false));
    observer.observe(list);
    return () => observer.disconnect();
  }, []);
  const [selection, setSelection] = useState<Selection>();
  const { withYou, betweenSeats } = groupSeatThreads(threads);

  // Nothing picked yet: pick once the list arrives. A thread that left the
  // list is let go; one just started here waits for the list to read it.
  const picked: Selection | undefined =
    selection?.kind === "new" ||
    selection?.sent !== undefined ||
    (selection && threads.some((thread) => thread.threadId === selection.threadId))
      ? selection
      : (() => {
          const threadId = firstThread(threads);
          return threadId === undefined ? undefined : { kind: "thread", threadId };
        })();
  const thread = picked?.kind === "thread" ? threads.find((candidate) => candidate.threadId === picked.threadId) : undefined;

  const row = (item: SeatThreadSummary) => (
    <li key={item.threadId}>
      <button
        type="button"
        className="seat-threads__row"
        data-selected={picked?.kind === "thread" && picked.threadId === item.threadId ? "true" : undefined}
        data-unread={item.unread > 0 ? "true" : undefined}
        data-testid="seat-threads-row"
        data-thread-id={item.threadId}
        aria-current={picked?.kind === "thread" && picked.threadId === item.threadId ? "true" : undefined}
        onClick={() => setSelection({ kind: "thread", threadId: item.threadId })}
      >
        <span className="seat-threads__row-top">
          {item.last.author === "you" ? (
            <span className="seat-threads__row-you" aria-hidden="true">
              Y
            </span>
          ) : (
            <AgentPortrait identity={portraitOf(item.last.author)} size={18} frame="round" badge={false} outline={false} />
          )}
          <span className="seat-threads__row-who">{item.last.author === "you" ? "You" : item.last.author}</span>
          {item.openSignal ? <RowSignal kind={item.openSignal.kind} /> : null}
          {item.unread > 0 ? (
            <span
              className="seat-threads__row-unread"
              data-testid="seat-threads-row-unread"
              title={`${String(item.unread)} unread`}
              aria-label={`${String(item.unread)} unread`}
            >
              {item.unread > 99 ? "99+" : item.unread}
            </span>
          ) : null}
          <ThreadTime className="seat-threads__row-time" at={item.lastAt} />
        </span>
        {item.subject && item.subject.kind !== "file" ? (
          <span className="seat-threads__row-subject">
            <ResourceGlyphMark kind={item.subject.kind} />
            {previewText(item.title)}
          </span>
        ) : null}
        <span className="seat-threads__row-preview">
          <ThreadHeadline text={item.last.text} known={[item.last.author]} />
        </span>
      </button>
    </li>
  );

  const sidebar = (
    <>
      <PaneHeader eyebrow="Threads" />
      <Button
        size="sm"
        variant="chrome"
        className="seat-threads__new"
        data-selected={picked?.kind === "new" ? "true" : undefined}
        data-testid="seat-threads-new"
        onClick={() => setSelection({ kind: "new" })}
      >
        <Plus size={13} strokeWidth={1.8} /> New thread
      </Button>
      <nav ref={listRef} className="seat-threads__list" aria-label={`Threads of ${name}`} onScroll={() => fillList(true)}>
        {error ? (
          <p className="seat-threads__note seat-threads__note--error" role="alert">
            {error}
          </p>
        ) : null}
        {loaded && threads.length === 0 && !error ? <p className="seat-threads__note">No threads yet.</p> : null}
        {withYou.length > 0 ? (
          <section aria-label="With you">
            <Eyebrow tone="steel">With you</Eyebrow>
            <ul className="seat-threads__group" data-testid="seat-threads-with-you">
              {withYou.map(row)}
            </ul>
          </section>
        ) : null}
        {betweenSeats.length > 0 ? (
          <section aria-label="Between seats">
            <Eyebrow tone="steel">Between seats</Eyebrow>
            <ul className="seat-threads__group" data-testid="seat-threads-between-seats">
              {betweenSeats.map(row)}
            </ul>
          </section>
        ) : null}
        {next !== undefined ? (
          <p className="seat-threads__note" data-testid="seat-threads-more">
            Reading older threads…
          </p>
        ) : null}
      </nav>
    </>
  );

  return (
    <TwoPane sidebar={sidebar} sidebarLabel="Threads" mainLabel={thread?.title ?? "Thread"}>
      <div className="seat-threads__chat">
        {picked?.kind === "new" ? (
          <NewThread
            seat={seat}
            name={name}
            yields={yields}
            onCancel={() => setSelection(undefined)}
            onSent={(threadId, sent) => setSelection({ kind: "thread", threadId, sent })}
          />
        ) : thread ? (
          <ThreadChat
            seat={seat}
            name={name}
            thread={thread}
            shown={shown}
            // A row the operator pressed, or a thread they just started. The
            // first of the list, shown because nothing was picked, is not.
            picked={selection?.kind === "thread" && selection.threadId === thread.threadId}
            started={selection?.kind === "thread" && selection.threadId === thread.threadId ? selection.sent : undefined}
            yields={yields}
          />
        ) : (
          <>
            <ChatHead title="Threads" />
            <p className="seat-threads__empty">
              {loaded && picked?.kind !== "thread" ? "Pick a thread, or start one." : "Reading threads…"}
            </p>
          </>
        )}
      </div>
    </TwoPane>
  );
}

/** One mention or subject, drawn as a chip. Opening it opens what it names; the threads stay where they are. */
function MentionChipView({ chip, testId }: { readonly chip: MentionChip; readonly testId: string }) {
  const { ref, kind, label, number } = chip;
  // A gone seat or page: its link cannot say which, so it is its words, struck.
  if (kind === undefined) return <del data-testid={testId} data-missing="true">{label}</del>;
  const open = ref === undefined ? undefined : () => openMention(ref);
  const mark = ref !== undefined ? mentionMark(ref) : { kind };
  return <ResourceChip {...mark} label={label} number={number} missing={ref === undefined} {...(open === undefined ? {} : { onOpen: open })} data-testid={testId} />;
}

/**
 * The chat's head: one line of subject, clamped with the whole of it on
 * hover, and the thread's facts under it.
 */
export function ChatHead({
  title,
  full,
  meta,
}: {
  readonly title: ReactNode;
  /** The subject in words, for the hover when the line is cut. */
  readonly full?: string;
  readonly meta?: ReactNode;
}) {
  return (
    <header className="seat-threads__chat-head">
      <h2 className="seat-threads__chat-title" title={full}>
        {title}
      </h2>
      {meta ? <div className="seat-threads__chat-meta">{meta}</div> : null}
    </header>
  );
}

/**
 * One thread as a chat: its head, its messages oldest first with the
 * operator's own on the right, and the reply field, or the line that says why
 * there is none. It takes a seat and a thread and knows nothing of what holds
 * it; lay it in a column that gives it a height (`seat-threads__chat`).
 */
export function ThreadChat({
  seat,
  name,
  thread,
  shown = true,
  picked = true,
  started,
  yields,
}: {
  readonly seat: SeatAddress;
  /** The seat's name, for the reply field's hint. */
  readonly name: string;
  readonly thread: SeatThreadSummary;
  /** False while the chat is in the document and not on screen: it then has no box to scroll or fill. */
  readonly shown?: boolean;
  /**
   * The operator chose this thread: a press or a key moved the selection to
   * it, or a link opened it. False for a thread that shows only because it
   * is first in a list: it shows, scrolls and pages all the same, and is
   * read at the operator's first act in it.
   */
  readonly picked?: boolean;
  /**
   * The thread was just started from here, by this mail. Its chat did not
   * exist when the send came back, so the chat says how it went once it is
   * in the document.
   */
  readonly started?: SentMail;
  /** Asked as the reply field mounts: true leaves the keyboard where the operator has it. */
  readonly yields?: () => boolean;
}) {
  const nodes = useCanvas(seat.canvasName).nodes;
  const kindOf = useCallback((id: NodeId) => nodes.get(id)?.kind, [nodes]);
  // A mention link in a message is a chip; any other app link is not drawn as one.
  const renderLink = useCallback(
    (href: string, label: string) => {
      const target = parseMentionHref(href);
      if (target === undefined) return undefined;
      return <MentionChipView chip={mentionChipOf({ target, label }, kindOf)} testId="seat-threads-mention" />;
    },
    [kindOf],
  );
  const portraitOf = usePortraitOf(seat.canvasName);
  const { messages, loaded, error, older, loadingMore, headSignal } = useSeatThreadMessages(seat, thread.threadId);
  // A thread is read when the operator picks it or acts in it: a press, a
  // key or a scroll inside its chat, or focus they move into it. One that
  // shows only because it is first in a list is not: an unread the operator
  // never chose stays unread, and the other mistake costs one click. Focus
  // counts because a screen reader's cursor moves the keyboard with it and
  // sends the page no key and no press; focus the code places (a claim
  // through focus-ownership, as a view opens) does not, and neither does the
  // window handing the keyboard back where it was. From then on, wherever
  // the chat is laid, mail
  // that lands in it while it is on screen reads too, so nothing counts what
  // the operator is looking at. A chat that is not on screen (behind
  // Terminal) reads nothing: its thread stays unread until it shows again.
  // Main writes nothing when the point has not moved, so re-marking costs
  // nothing (0.11.3).
  const { canvasName, seatId } = seat;
  const { threadId, unread } = thread;
  const [actedIn, setActedIn] = useState<string>();
  const chosen = picked || actedIn === threadId;
  const act = chosen ? undefined : () => setActedIn(threadId);
  // What held the keyboard here when the window itself lost it.
  const leftWith = useRef<EventTarget | null>(null);
  const focusIn = chosen
    ? undefined
    : (event: { readonly target: EventTarget }) => {
        if (isFocusClaimInFlight()) return;
        const back = leftWith.current === event.target;
        leftWith.current = null;
        if (!back) setActedIn(threadId);
      };
  const focusOut = chosen
    ? undefined
    : (event: { readonly target: EventTarget }) => {
        leftWith.current = document.hasFocus() ? null : event.target;
      };
  useEffect(() => {
    if (!shown || !chosen) return;
    void markSeatThreadRead({ canvasName, seatId }, threadId);
  }, [canvasName, seatId, threadId, unread, shown, chosen]);
  const streamRef = useRef<HTMLDivElement>(null);
  const held = useRef<{ threadId: string; first?: string; last?: string; height: number } | undefined>(undefined);
  // The newest at the bottom, in view, on open and as mail arrives. An older
  // page laid in above keeps what the reader was looking at where it was.
  // Behind Terminal nothing is held, so mail that landed there is at the
  // bottom, in view, when Threads shows again.
  useLayoutEffect(() => {
    const stream = streamRef.current;
    if (!stream || !shown) return;
    const before = held.current;
    const first = messages[0]?.messageId;
    const last = messages.at(-1)?.messageId;
    if (before?.threadId !== thread.threadId || last !== before.last) stream.scrollTop = stream.scrollHeight;
    else if (first !== before.first) stream.scrollTop += stream.scrollHeight - before.height;
    held.current = { threadId: thread.threadId, first, last, height: stream.scrollHeight };
  }, [thread.threadId, messages, shown]);
  const fillStream = (retry: boolean) => {
    const stream = streamRef.current;
    if (!shown || !stream || older === undefined || loadingMore || (error !== "" && !retry)) return;
    if (stream.scrollTop < CHAT_NEAR_TOP) void loadOlderMessages(seat, thread.threadId);
  };
  useEffect(() => fillStream(false), [messages, older, loadingMore, error, shown]);
  // What the chat says aloud: every send from here says its outcome once. A
  // seat that has the mail in time is said to have it ("pty-lead has it.");
  // one that does not within a second is said to be away, and then, when it
  // takes the mail, to have it. Both are of this thread, so another thread
  // shown in the same chat starts silent. History is never said: only mail
  // sent from here is followed.
  const [spoken, setSpoken] = useState<Said & { readonly threadId: string }>();
  const say = useCallback((text: string) => setSpoken((was) => ({ threadId, text, turn: (was?.turn ?? 0) + 1 })), [threadId]);
  // The mail sent from here whose outcome is not said yet, by id.
  const followed = useRef(new Set<string>());
  // The mail sent from here whose waiting mark is held back until it has had its second.
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  // The signals this thread already says crossed, on the signal itself: their answer says nothing more.
  const crossedSignals = useMemo(() => {
    const ids = new Set<string>();
    for (const message of messages) if (message.signal?.crossed === true) ids.add(message.signal.signalId);
    if (headSignal?.crossed === true) ids.add(headSignal.signalId);
    return ids;
  }, [messages, headSignal]);
  const messagesNow = useRef(messages);
  messagesNow.current = messages;
  // Whether the chat is on screen when a timer fires, not when it was set.
  const shownNow = useRef(shown);
  shownNow.current = shown;
  useEffect(() => {
    const ids = followed.current;
    const waits = timers.current;
    return () => {
      ids.clear();
      for (const timer of waits.values()) clearTimeout(timer);
      waits.clear();
    };
  }, [threadId]);
  const follow = useCallback(
    (messageId: string) => {
      followed.current.add(messageId);
      timers.current.set(
        messageId,
        setTimeout(() => {
          timers.current.delete(messageId);
          if (!followed.current.has(messageId)) return;
          const mail = messagesNow.current.find((message) => message.messageId === messageId);
          if (mail !== undefined && mail.waiting !== true) {
            // The list showed it taken before the send's own answer came back, so
            // the arrival effect passed it by: its arrival is said here.
            followed.current.delete(messageId);
            if (shownNow.current) say(sentArrived(name));
            return;
          }
          // Said only while the thread is on screen, as its arrival is.
          if (shownNow.current) say(sentWaiting(name));
        }, WAITING_AFTER_MS),
      );
    },
    [name, say],
  );
  useEffect(() => {
    for (const message of messages) {
      if (message.waiting === true || !followed.current.delete(message.messageId)) continue;
      const timer = timers.current.get(message.messageId);
      if (timer !== undefined) clearTimeout(timer);
      timers.current.delete(message.messageId);
      // Said only while the thread is on screen. Behind Terminal it is not
      // said, then or later, and the waiting it answered is let go.
      if (shown) say(sentArrived(name));
      else setSpoken(undefined);
    }
  }, [messages, name, say, shown]);
  // A signal that changes under the operator is said once: only while the
  // thread is on screen, and never for history. The first sight of a signal
  // only records where it stands. Answered is the operator's own act and is
  // not said (nothing in a thread dismisses a signal: Hand in opens Needs you,
  // which says its own); several changes at once are one saying.
  const signalStates = useRef(new Map<string, string>());
  useEffect(() => {
    const states = signalStates.current;
    return () => states.clear();
  }, [threadId]);
  useEffect(() => {
    const states = signalStates.current;
    const now = [
      ...(headSignal === undefined ? [] : [{ signal: headSignal, author: name }]),
      ...messages.flatMap((message) => (message.signal === undefined ? [] : [{ signal: message.signal, author: message.author }])),
    ];
    const changed: string[] = [];
    for (const { signal, author } of now) {
      // Where it stands; a crossing is one standing whichever face of it is read (withdrawn or answered), so it is said once.
      const standing = signal.crossed === true ? "crossed" : signal.state;
      const was = states.get(signal.signalId);
      states.set(signal.signalId, standing);
      if (!shown || was === undefined || was === standing) continue;
      const headline = threadHeadlineText(signal.text, thread.participants);
      // A crossing is said as the signal's line says it, the seat's own statement, whichever way it closed.
      if (signal.crossed === true) changed.push(crossedLiveWords(author, headline));
      else if (signal.state === "withdrawn") changed.push(`${author} withdrew: ${headline}`);
      else if (signal.state === "dismissed") changed.push(`Dismissed: ${headline}`);
    }
    // Each saying ends on a headline, so the next starts after a full stop
    // unless the headline brought its own.
    if (changed.length > 0) say(changed.reduce((all, one) => `${all}${/[.!?]$/.test(all) ? " " : ". "}${one}`));
  }, [messages, headSignal, shown, name, thread.participants, say]);
  // A thread just started from here, by this mail. Its chat is new, so `name`
  // and `shown` as it mounted are the ones that count for the 150 ms below. The region is said reliably
  // only when it is in the document before its words, so its outcome comes a
  // moment after the chat: that the seat has it, or, as for any send, the
  // waiting line when it has not within a second.
  const startedId = started?.messageId;
  useEffect(() => {
    if (startedId === undefined) return;
    const timer = setTimeout(() => {
      const mail = messagesNow.current.find((message) => message.messageId === startedId);
      if (mail !== undefined && mail.waiting !== true) {
        if (shown) say(sentArrived(name));
        return;
      }
      follow(startedId);
    }, SAID_AFTER_MOUNT_MS);
    return () => clearTimeout(timer);
    // The chat's own start: later changes of what it shows are not another start.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startedId]);
  // The signals raised in this thread that are still open, earliest first:
  // what a reply will answer, and what stays open until work is handed in.
  // The signal at the thread's head is not among them: its answer is what
  // started the thread.
  const answersId = useId();
  const openSignals = useMemo(
    () => messages.flatMap((message) => (!message.mine && message.signal?.state === "open" ? [message.signal] : [])),
    [messages],
  );
  const showSignal = (signalId: string): void => {
    const marked = streamRef.current?.querySelectorAll<HTMLElement>("[data-signal-id]") ?? [];
    for (const one of marked) {
      if (one.dataset.signalId !== signalId) continue;
      one.scrollIntoView?.({ block: "nearest" });
      // The reply line's button was pressed: the keyboard goes to the signal,
      // so its kind and state line is read, not left on a button that says
      // only what it brings into view. The scroll above is the only scroll.
      claimFocus(one, "gesture", { preventScroll: true });
      return;
    }
  };
  const subject = thread.subject ? subjectChipOf(thread.subject, thread.title, kindOf) : undefined;
  const count = `${thread.messageCount} ${thread.messageCount === 1 ? "message" : "messages"}`;
  const lastId = messages.at(-1)?.messageId;
  return (
    <div
      className="seat-threads__acts"
      data-testid="seat-threads-acts"
      onPointerDown={act}
      onKeyDown={act}
      onWheel={act}
      onTouchMove={act}
      onFocus={focusIn}
      onBlur={focusOut}
    >
      <ChatHead
        title={
          subject ? (
            <MentionChipView chip={subject} testId="seat-threads-subject" />
          ) : (
            <ThreadHeadline text={thread.title} known={thread.participants} />
          )
        }
        full={thread.title}
        meta={
          <>
            {thread.participants.map((who) => (
              <Chip key={who} tone={who === "you" ? "cyan" : "steel"}>
                {who}
              </Chip>
            ))}
            <span>
              {count}, started <ThreadTime form="message" at={thread.startedAt} />
            </span>
          </>
        }
      />
      <div
        ref={streamRef}
        className="seat-threads__stream"
        data-testid="seat-threads-stream"
        role="group"
        aria-label={`Messages in ${previewText(thread.title)}`}
        tabIndex={0}
        onScroll={() => fillStream(true)}
      >
        <div className="seat-threads__column">
          {older !== undefined ? (
            <p className="seat-threads__note seat-threads__note--center" data-testid="seat-threads-older">
              Reading earlier messages…
            </p>
          ) : null}
          {error ? (
            <p className="seat-threads__note seat-threads__note--error" role="alert">
              {error}
            </p>
          ) : null}
          {loaded && messages.length === 0 && !error ? <p className="seat-threads__empty">Nothing sent yet.</p> : null}
          {/* The signal whose answer started the thread, where the thread
              starts: it was raised before any mail here, so it has no message
              of its own. Its seat is the one this chat is with. */}
          {headSignal !== undefined && older === undefined ? (
            <article className="seat-threads__message" data-testid="seat-threads-head-signal" data-signal-id={headSignal.signalId} tabIndex={-1} aria-label={signalName(headSignal, thread.participants)}>
              <SignalFrame signal={headSignal} author={name} known={thread.participants} onHandIn={openNeedsYouOn}>
                <div className="seat-threads__message-head">
                  <AgentPortrait identity={portraitOf(name)} size={20} frame="round" badge={false} outline={false} />
                  <strong>{name}</strong>{" "}
                  <ThreadTime className="seat-threads__message-time" form="message" at={headSignal.at} />
                </div>
                <div className="seat-threads__body">
                  <ArtifactMarkdown
                    source={stripAuthorPreamble(headSignal.text, [name])}
                    className="seat-threads__prose"
                    renderLink={renderLink}
                    rehypePlugins={THREAD_MARKDOWN_PLUGINS}
                  />
                </div>
              </SignalFrame>
            </article>
          ) : null}
          {messages.map((message, index) => {
            const previous = messages[index - 1];
            // A seat's mail that is a signal reads as one: the message, in a frame.
            const signal = message.mine ? undefined : message.signal;
            // The same seat writing twice in a row says its name once; the folded
            // head stays in the document, so a reader still hears who is speaking.
            // A signal keeps its head, and so does the mail after it: the frame
            // ends the run.
            const folded =
              previous !== undefined &&
              previous.author === message.author &&
              message.at - previous.at < FOLD_MS &&
              signal === undefined &&
              previous.signal === undefined;
            const head = (
              <div className={folded ? "seat-threads__message-head sr-only" : "seat-threads__message-head"}>
                {message.mine ? null : (
                  <AgentPortrait identity={portraitOf(message.author)} size={20} frame="round" badge={false} outline={false} />
                )}
                <strong>{message.mine ? "You" : message.author}</strong>{" "}
                <ThreadTime className="seat-threads__message-time" form="message" at={message.at} />
              </div>
            );
            const words =
              message.text !== "" || message.attachments === undefined ? (
                <div className={message.mine ? "seat-threads__block" : "seat-threads__body"}>
                  <ArtifactMarkdown
                    source={stripAuthorPreamble(message.text, [message.author])}
                    className="seat-threads__prose"
                    renderLink={renderLink}
                    rehypePlugins={THREAD_MARKDOWN_PLUGINS}
                  />
                </div>
              ) : null;
            const files = message.attachments ? <MessageAttachments files={message.attachments} /> : null;
            return (
              <article
                key={message.messageId}
                className="seat-threads__message"
                data-mine={message.mine ? "true" : undefined}
                data-folded={folded ? "true" : undefined}
                data-signal-id={signal?.signalId}
                // A signal is where the reply line's button takes the keyboard.
                tabIndex={signal === undefined ? undefined : -1}
                aria-label={signal === undefined ? undefined : signalName(signal, thread.participants)}
                data-testid="seat-threads-message"
              >
                {signal !== undefined ? (
                  <SignalFrame signal={signal} author={message.author} known={thread.participants} onHandIn={openNeedsYouOn}>
                    {head}
                    {words}
                    {files}
                  </SignalFrame>
                ) : (
                  <>
                    {head}
                    {/* The operator's mail that answered a signal says which, above its words. */}
                    {message.mine && message.answers ? <AnswerTo text={message.answers.text} known={thread.participants} /> : null}
                    {words}
                    {files}
                    {/* The operator's own mail that its seat does not have yet. */}
                    {message.mine && message.waiting && !message.held ? <WaitingMark name={name} messageId={message.messageId} /> : null}
                    {/* An answer its seat withdrew the signal before it arrived: kept from the seat, said in the crossed note's own style. */}
                    {message.mine && message.held && !(message.answers !== undefined && crossedSignals.has(message.answers.signalId)) ? (
                      <p className="seat-threads__signal-note seat-threads__signal-note--held" data-testid="seat-threads-answer-held">{answerHeldWords(name)}</p>
                    ) : null}
                  </>
                )}
              </article>
            );
          })}
        </div>
      </div>
      <ThreadSaid said={spoken?.threadId === threadId ? spoken : undefined} />
      {thread.canReply ? (
        <ThreadComposer
          key={thread.threadId}
          seat={seat}
          name={name}
          mode="reply"
          threadId={thread.threadId}
          inReplyTo={lastId}
          yields={yields}
          above={<ReplyAnswers id={answersId} open={openSignals} known={thread.participants} onShow={showSignal} onHandIn={openNeedsYouOn} />}
          // The block is there exactly while a signal is open: ReplyAnswers says nothing with none.
          {...(openSignals.length > 0 ? { describedBy: answersId } : {})}
          onSent={(_threadId, mail) => follow(mail.messageId)}
        />
      ) : (
        <footer className="seat-threads__readonly" data-testid="seat-threads-readonly">
          <Chip tone="steel">read only</Chip>
          <span>
            {betweenLine(thread.participants)} You are not in this thread, so you read it and do not write in it.
          </span>
        </footer>
      )}
    </div>
  );
}

/** A thread not yet started: the chat's shape with nothing sent, and the field that starts it. */
export function NewThread({
  seat,
  name,
  onCancel,
  onSent,
  yields,
}: {
  readonly seat: SeatAddress;
  readonly name: string;
  /** Asked as the field mounts: true leaves the keyboard where the operator has it. */
  readonly yields?: () => boolean;
  readonly onCancel: () => void;
  readonly onSent: (threadId: string, mail: SentMail) => void;
}) {
  return (
    <>
      <ChatHead title="New thread" meta={<span>Its first line becomes the thread's name in the list.</span>} />
      <div className="seat-threads__stream">
        <p className="seat-threads__empty">Nothing sent yet.</p>
      </div>
      <ThreadComposer seat={seat} name={name} mode="new" onCancel={onCancel} onSent={onSent} yields={yields} />
    </>
  );
}
