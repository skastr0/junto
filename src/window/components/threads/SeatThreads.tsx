import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  type SeatAddress,
  type SeatThreadSummary,
} from "../../lib/seat-threads";
import { deepActiveElement, focusPrimaryControl, recentGestureKind } from "../../lib/focus-ownership";
import { mentionChipOf, openMention, subjectChipOf, type MentionChip } from "../../lib/mention-open";
import { stripAuthorPreamble, threadHeadline } from "../../lib/thread-text";
import { useCanvas } from "../../lib/use-model";
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
import { ThreadComposer } from "./ThreadComposer";
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

/**
 * A thread's line as it is drawn: its words, with each long id as the token
 * whose whole value stays in the document (the stylesheet cuts what the eye
 * sees). A row is a button whose name is this text, so nothing here may cut an
 * id into a string.
 */
function Headline({ text, known }: { readonly text: string; readonly known: ReadonlyArray<string> }) {
  return (
    <>
      {threadHeadline(previewText(text), known).map((segment, index) =>
        segment.id === undefined ? (
          segment.text
        ) : (
          <span key={`${segment.id}-${String(index)}`} className="seat-threads__id">
            {segment.id}
          </span>
        ),
      )}
    </>
  );
}

/** How far from the list's end, in pixels, the next older page is asked for. */
const LIST_NEAR_END = 400;
/** How far from the chat's top, in pixels, the next older page is asked for. */
const CHAT_NEAR_TOP = 240;
/** Two messages from one seat this close together share a head: the second folds. */
const FOLD_MS = 10 * 60 * 1000;

type Selection =
  | {
      readonly kind: "thread";
      readonly threadId: string;
      /** Just started here: held while the list has not read it yet. */
      readonly sent?: true;
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
    selection?.sent === true ||
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
          <Headline text={item.last.text} known={[item.last.author]} />
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
            onSent={(threadId) => setSelection({ kind: "thread", threadId, sent: true })}
          />
        ) : thread ? (
          <ThreadChat seat={seat} name={name} thread={thread} shown={shown} yields={yields} />
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
  yields,
}: {
  readonly seat: SeatAddress;
  /** The seat's name, for the reply field's hint. */
  readonly name: string;
  readonly thread: SeatThreadSummary;
  /** False while the chat is in the document and not on screen: it then has no box to scroll or fill. */
  readonly shown?: boolean;
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
  const { messages, loaded, error, older, loadingMore } = useSeatThreadMessages(seat, thread.threadId);
  // A thread on screen is read, on this device and every other, wherever the
  // chat is laid. Mail that lands in it while it is on screen reads too, so
  // nothing counts what the operator is looking at. A chat that is not on
  // screen (behind Terminal) reads nothing: its thread stays unread until it
  // shows again. Main writes nothing when the point has not moved, so
  // re-marking costs nothing (0.11.3).
  const { canvasName, seatId } = seat;
  const { threadId, unread } = thread;
  useEffect(() => {
    if (!shown) return;
    void markSeatThreadRead({ canvasName, seatId }, threadId);
  }, [canvasName, seatId, threadId, unread, shown]);
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
  const subject = thread.subject ? subjectChipOf(thread.subject, thread.title, kindOf) : undefined;
  const count = `${thread.messageCount} ${thread.messageCount === 1 ? "message" : "messages"}`;
  const lastId = messages.at(-1)?.messageId;
  return (
    <>
      <ChatHead
        title={
          subject ? (
            <MentionChipView chip={subject} testId="seat-threads-subject" />
          ) : (
            <Headline text={thread.title} known={thread.participants} />
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
          {messages.map((message, index) => {
            const previous = messages[index - 1];
            // The same seat writing twice in a row says its name once; the folded
            // head stays in the document, so a reader still hears who is speaking.
            const folded = previous !== undefined && previous.author === message.author && message.at - previous.at < FOLD_MS;
            return (
              <article
                key={message.messageId}
                className="seat-threads__message"
                data-mine={message.mine ? "true" : undefined}
                data-folded={folded ? "true" : undefined}
                data-testid="seat-threads-message"
              >
                <div className={folded ? "seat-threads__message-head sr-only" : "seat-threads__message-head"}>
                  {message.mine ? null : (
                    <AgentPortrait identity={portraitOf(message.author)} size={20} frame="round" badge={false} outline={false} />
                  )}
                  <strong>{message.mine ? "You" : message.author}</strong>{" "}
                  <ThreadTime className="seat-threads__message-time" form="message" at={message.at} />
                </div>
                {message.text !== "" || message.attachments === undefined ? (
                  <div className={message.mine ? "seat-threads__block" : "seat-threads__body"}>
                    <ArtifactMarkdown
                      source={stripAuthorPreamble(message.text, [message.author])}
                      className="seat-threads__prose"
                      renderLink={renderLink}
                      rehypePlugins={THREAD_MARKDOWN_PLUGINS}
                    />
                  </div>
                ) : null}
                {message.attachments ? <MessageAttachments files={message.attachments} /> : null}
              </article>
            );
          })}
        </div>
      </div>
      {thread.canReply ? (
        <ThreadComposer
          key={thread.threadId}
          seat={seat}
          name={name}
          mode="reply"
          threadId={thread.threadId}
          inReplyTo={lastId}
          yields={yields}
        />
      ) : (
        <footer className="seat-threads__readonly" data-testid="seat-threads-readonly">
          <Chip tone="steel">read only</Chip>
          <span>
            {betweenLine(thread.participants)} You are not in this thread, so you read it and do not write in it.
          </span>
        </footer>
      )}
    </>
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
  readonly onSent: (threadId: string) => void;
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
