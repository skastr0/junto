import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Plus, X } from "lucide-react";
import { parseMentionHref } from "@shared/mention";
import { titleOf } from "@shared/model/title";
import type { NodeId } from "@shared/physics/schema";
import {
  betweenLine,
  groupSeatThreads,
  loadMoreSeatThreads,
  loadOlderMessages,
  markSeatThreadRead,
  previewText,
  threadTime,
  useSeatThreadMessages,
  useSeatThreads,
  useSeatUnread,
  type SeatAddress,
  type SeatThreadSummary,
} from "../../lib/seat-threads";
import { mentionChipOf, openMention, subjectChipOf, type MentionChip } from "../../lib/mention-open";
import { stripAuthorPreamble, threadHeadline } from "../../lib/thread-text";
import { useCanvas } from "../../lib/use-model";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { Eyebrow } from "../ui/Eyebrow";
import { IconButton } from "../ui/IconButton";
import { PaneHeader, TwoPane } from "../ui/TwoPane";
import { FocusSurface } from "../FocusSurface";
import { AgentPortrait } from "../AgentPortrait";
import { ArtifactMarkdown } from "../work/ArtifactMarkdown";
import { ResourceChip, ResourceGlyphMark, mentionMark } from "../ui/ResourceChip";
import { MessageAttachments } from "./MessageAttachments";
import { ThreadComposer } from "./ThreadComposer";
import { rehypeThreadCodeWells, rehypeThreadInlineIds } from "./thread-inline-ids";
import "./seat-threads.css";

/**
 * The Threads button in a seat's header, left of Params. It carries the
 * operator's unread count for that seat, on every device: reading a thread in
 * the popup, or on the phone, clears it. The count is the seat's total, not the
 * part of it the popup happens to have paged in.
 */
export function SeatThreadsButton({ seat, name }: { readonly seat: SeatAddress; readonly name: string }) {
  const [open, setOpen] = useState(false);
  const unread = useSeatUnread(seat);
  return (
    <>
      <Button
        size="xs"
        variant="chrome"
        title={unread === 0 ? "Threads" : `Threads, ${String(unread)} unread`}
        aria-haspopup="dialog"
        data-testid="seat-threads-button"
        data-unread={unread > 0 ? "true" : undefined}
        onClick={() => setOpen(true)}
      >
        Threads
        {unread > 0 ? (
          <span className="seat-threads__unread-count" data-testid="seat-threads-button-unread" aria-label={`${String(unread)} unread`}>
            {unread > 99 ? "99+" : unread}
          </span>
        ) : null}
      </Button>
      {open ? <SeatThreadsPopup seat={seat} name={name} onClose={() => setOpen(false)} /> : null}
    </>
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
 * The seat's threads, a workspace focus modal: it sizes to the frame,
 * maximizes, and its list collapses (TwoPane). The list holds two groups,
 * With you and Between seats, under New thread; the chat takes the rest,
 * oldest at the top, the operator's own on the right. A thread between seats
 * is read only.
 */
export function SeatThreadsPopup({
  seat,
  name,
  onClose,
}: {
  readonly seat: SeatAddress;
  readonly name: string;
  readonly onClose: () => void;
}) {
  const { threads, loaded, error, next, loadingMore } = useSeatThreads(seat);
  const portraitOf = usePortraitOf(seat.canvasName);
  const listRef = useRef<HTMLElement>(null);
  // The next older page when the list is scrolled near its end, or when what
  // is read does not yet fill the column and so cannot be scrolled. After a
  // failed page only the reader's next scroll asks again. A folded list has
  // no height and asks for nothing until it shows again.
  const fillList = (retry: boolean) => {
    const list = listRef.current;
    if (!list || list.clientHeight === 0 || next === undefined || loadingMore || (error !== "" && !retry)) return;
    if (list.scrollHeight - list.scrollTop - list.clientHeight < LIST_NEAR_END) void loadMoreSeatThreads(seat);
  };
  useEffect(() => fillList(false), [threads, next, loadingMore, error]);
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
  const shown: Selection | undefined =
    selection?.kind === "new" ||
    selection?.sent === true ||
    (selection && threads.some((thread) => thread.threadId === selection.threadId))
      ? selection
      : (() => {
          const threadId = firstThread(threads);
          return threadId === undefined ? undefined : { kind: "thread", threadId };
        })();
  const thread = shown?.kind === "thread" ? threads.find((candidate) => candidate.threadId === shown.threadId) : undefined;

  // A thread on screen is read, on this device and every other: the modal opens
  // on one, and every pick shows one. Mail that lands in it while it is on
  // screen reads too, so the row never counts what the operator is looking at.
  // Main writes nothing when the point has not moved, so re-marking on each
  // render costs nothing (0.11.3).
  const shownThreadId = shown?.kind === "thread" ? shown.threadId : undefined;
  const shownUnread = thread?.unread ?? 0;
  const { canvasName, seatId } = seat;
  useEffect(() => {
    if (shownThreadId === undefined) return;
    void markSeatThreadRead({ canvasName, seatId }, shownThreadId);
  }, [canvasName, seatId, shownThreadId, shownUnread]);

  const row = (item: SeatThreadSummary) => (
    <li key={item.threadId}>
      <button
        type="button"
        className="seat-threads__row"
        data-selected={shown?.kind === "thread" && shown.threadId === item.threadId ? "true" : undefined}
        data-unread={item.unread > 0 ? "true" : undefined}
        data-testid="seat-threads-row"
        data-thread-id={item.threadId}
        aria-current={shown?.kind === "thread" && shown.threadId === item.threadId ? "true" : undefined}
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
          <span className="seat-threads__row-time">{threadTime(item.lastAt)}</span>
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

  const close = (
    <IconButton size="sm" aria-label="Close threads" title="Close" onClick={onClose}>
      <X size={15} strokeWidth={1.8} />
    </IconButton>
  );
  const sidebar = (
    <>
      <PaneHeader eyebrow={`Threads, ${name}`} />
      <Button
        size="sm"
        variant="chrome"
        className="seat-threads__new"
        data-selected={shown?.kind === "new" ? "true" : undefined}
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
    <FocusSurface measure="workspace" height="immersive" label={`Threads, ${name}`} panelClassName="seat-threads" onClose={onClose}>
      <div className="seat-threads__shell" data-testid="seat-threads">
        <TwoPane sidebar={sidebar} sidebarLabel="Threads" mainLabel={thread?.title ?? "Thread"}>
          <div className="seat-threads__chat">
            {shown?.kind === "new" ? (
              <NewThread
                seat={seat}
                name={name}
                close={close}
                onCancel={() => setSelection(undefined)}
                onSent={(threadId) => setSelection({ kind: "thread", threadId, sent: true })}
              />
            ) : thread ? (
              <ThreadChat seat={seat} name={name} thread={thread} close={close} onLeave={onClose} />
            ) : (
              <>
                <ChatHead title="Threads" close={close} />
                <p className="seat-threads__empty">
                  {loaded && shown?.kind !== "thread" ? "Pick a thread, or start one." : "Reading threads…"}
                </p>
              </>
            )}
          </div>
        </TwoPane>
      </div>
    </FocusSurface>
  );
}

/** One mention or subject, drawn as a chip; opening it leaves the threads first. */
function MentionChipView({ chip, onLeave, testId }: { readonly chip: MentionChip; readonly onLeave: () => void; readonly testId: string }) {
  const { ref, kind, label, number } = chip;
  // A gone seat or page: its link cannot say which, so it is its words, struck.
  if (kind === undefined) return <del data-testid={testId} data-missing="true">{label}</del>;
  const open = ref === undefined ? undefined : () => {
    onLeave();
    openMention(ref);
  };
  const mark = ref !== undefined ? mentionMark(ref) : { kind };
  return <ResourceChip {...mark} label={label} number={number} missing={ref === undefined} {...(open === undefined ? {} : { onOpen: open })} data-testid={testId} />;
}

/**
 * The chat's head: one line of subject, clamped with the whole of it on
 * hover, the thread's facts under it, and Close at the corner.
 */
function ChatHead({
  title,
  full,
  meta,
  close,
}: {
  readonly title: ReactNode;
  /** The subject in words, for the hover when the line is cut. */
  readonly full?: string;
  readonly meta?: ReactNode;
  readonly close: ReactNode;
}) {
  return (
    <header className="seat-threads__chat-head">
      <div className="seat-threads__chat-line">
        <h2 className="seat-threads__chat-title" title={full}>
          {title}
        </h2>
        {close}
      </div>
      {meta ? <div className="seat-threads__chat-meta">{meta}</div> : null}
    </header>
  );
}

function ThreadChat({
  seat,
  name,
  thread,
  close,
  onLeave,
}: {
  readonly seat: SeatAddress;
  readonly name: string;
  readonly thread: SeatThreadSummary;
  readonly close: ReactNode;
  /** Opening a mention leaves the threads for what it names. */
  readonly onLeave: () => void;
}) {
  const nodes = useCanvas(seat.canvasName).nodes;
  const kindOf = useCallback((id: NodeId) => nodes.get(id)?.kind, [nodes]);
  // A mention link in a message is a chip; any other app link is not drawn as one.
  const renderLink = useCallback(
    (href: string, label: string) => {
      const target = parseMentionHref(href);
      if (target === undefined) return undefined;
      return <MentionChipView chip={mentionChipOf({ target, label }, kindOf)} onLeave={onLeave} testId="seat-threads-mention" />;
    },
    [kindOf, onLeave],
  );
  const portraitOf = usePortraitOf(seat.canvasName);
  const { messages, loaded, error, older, loadingMore } = useSeatThreadMessages(seat, thread.threadId);
  const streamRef = useRef<HTMLDivElement>(null);
  const held = useRef<{ threadId: string; first?: string; last?: string; height: number } | undefined>(undefined);
  // The newest at the bottom, in view, on open and as mail arrives. An older
  // page laid in above keeps what the reader was looking at where it was.
  useLayoutEffect(() => {
    const stream = streamRef.current;
    if (!stream) return;
    const before = held.current;
    const first = messages[0]?.messageId;
    const last = messages.at(-1)?.messageId;
    if (before?.threadId !== thread.threadId || last !== before.last) stream.scrollTop = stream.scrollHeight;
    else if (first !== before.first) stream.scrollTop += stream.scrollHeight - before.height;
    held.current = { threadId: thread.threadId, first, last, height: stream.scrollHeight };
  }, [thread.threadId, messages]);
  const fillStream = (retry: boolean) => {
    const stream = streamRef.current;
    if (!stream || older === undefined || loadingMore || (error !== "" && !retry)) return;
    if (stream.scrollTop < CHAT_NEAR_TOP) void loadOlderMessages(seat, thread.threadId);
  };
  useEffect(() => fillStream(false), [messages, older, loadingMore, error]);
  const subject = thread.subject ? subjectChipOf(thread.subject, thread.title, kindOf) : undefined;
  const count = `${thread.messageCount} ${thread.messageCount === 1 ? "message" : "messages"}`;
  const lastId = messages.at(-1)?.messageId;
  return (
    <>
      <ChatHead
        title={
          subject ? (
            <MentionChipView chip={subject} onLeave={onLeave} testId="seat-threads-subject" />
          ) : (
            <Headline text={thread.title} known={thread.participants} />
          )
        }
        full={thread.title}
        close={close}
        meta={
          <>
            {thread.participants.map((who) => (
              <Chip key={who} tone={who === "you" ? "cyan" : "steel"}>
                {who}
              </Chip>
            ))}
            <span>
              {count}, started {threadTime(thread.startedAt)}
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
                  <time className="seat-threads__message-time" dateTime={new Date(message.at).toISOString()}>
                    {threadTime(message.at)}
                  </time>
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

function NewThread({
  seat,
  name,
  close,
  onCancel,
  onSent,
}: {
  readonly seat: SeatAddress;
  readonly name: string;
  readonly close: ReactNode;
  readonly onCancel: () => void;
  readonly onSent: (threadId: string) => void;
}) {
  return (
    <>
      <ChatHead title="New thread" close={close} meta={<span>Its first line becomes the thread's name in the list.</span>} />
      <div className="seat-threads__stream">
        <p className="seat-threads__empty">Nothing sent yet.</p>
      </div>
      <ThreadComposer seat={seat} name={name} mode="new" onCancel={onCancel} onSent={onSent} />
    </>
  );
}
