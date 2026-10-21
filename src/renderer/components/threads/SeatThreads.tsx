import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import type { NodeId } from "@shared/physics/schema";
import {
  betweenLine,
  groupSeatThreads,
  loadMoreSeatThreads,
  loadOlderMessages,
  participantsLine,
  threadTime,
  useSeatThreadMessages,
  useSeatThreads,
  type SeatAddress,
  type SeatThreadSummary,
} from "../../lib/seat-threads";
import { mentionChipParts, openMention, subjectChipOf, type MentionChip } from "../../lib/mention-open";
import { useCanvas } from "../../lib/use-model";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { Dialog } from "../ui/Dialog";
import { Eyebrow } from "../ui/Eyebrow";
import { IconButton } from "../ui/IconButton";
import { ResourceChip, ResourceGlyphMark } from "../ui/ResourceChip";
import { MessageAttachments } from "./MessageAttachments";
import { ThreadComposer } from "./ThreadComposer";
import "./seat-threads.css";

/**
 * The Threads button in a seat's header, left of Params. Plain: mail has no
 * operator read state, so it counts nothing.
 */
export function SeatThreadsButton({ seat, name }: { readonly seat: SeatAddress; readonly name: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="xs"
        variant="chrome"
        title="Threads"
        aria-haspopup="dialog"
        data-testid="seat-threads-button"
        onClick={() => setOpen(true)}
      >
        Threads
      </Button>
      {open ? <SeatThreadsPopup seat={seat} name={name} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

/** How far from the list's end, in pixels, the next older page is asked for. */
const LIST_NEAR_END = 400;
/** How far from the chat's top, in pixels, the next older page is asked for. */
const CHAT_NEAR_TOP = 240;

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
 * The seat's threads: the list on the left fifth in two groups, With you and
 * Between seats, under New thread; the chat on the rest, oldest at the top,
 * the operator's own on the right. A thread between seats is read only.
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
  const listRef = useRef<HTMLElement>(null);
  // The next older page when the list is scrolled near its end, or when what
  // is read does not yet fill the column and so cannot be scrolled. After a
  // failed page only the reader's next scroll asks again.
  const fillList = (retry: boolean) => {
    const list = listRef.current;
    if (!list || next === undefined || loadingMore || (error !== "" && !retry)) return;
    if (list.scrollHeight - list.scrollTop - list.clientHeight < LIST_NEAR_END) void loadMoreSeatThreads(seat);
  };
  useEffect(() => fillList(false), [threads, next, loadingMore, error]);
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

  const row = (item: SeatThreadSummary) => (
    <li key={item.threadId}>
      <button
        type="button"
        className="seat-threads__row"
        data-selected={shown?.kind === "thread" && shown.threadId === item.threadId ? "true" : undefined}
        data-testid="seat-threads-row"
        data-thread-id={item.threadId}
        aria-current={shown?.kind === "thread" && shown.threadId === item.threadId ? "true" : undefined}
        onClick={() => setSelection({ kind: "thread", threadId: item.threadId })}
      >
        <span className="seat-threads__row-title">
          {item.subject ? <ResourceGlyphMark kind={item.subject.kind} /> : null}
          {item.title}
        </span>
        <span className="seat-threads__row-meta">
          <span className="seat-threads__row-who">{participantsLine(item.participants)}</span>
          <span className="seat-threads__row-time">{threadTime(item.lastAt)}</span>
        </span>
      </button>
    </li>
  );

  return (
    <Dialog
      title={
        <span className="seat-threads__title">
          <span>Threads</span>
          <span className="seat-threads__seat">{name}</span>
          <IconButton size="sm" aria-label="Close threads" title="Close" className="ml-auto" onClick={onClose}>
            <X size={15} strokeWidth={1.8} />
          </IconButton>
        </span>
      }
      onClose={onClose}
      width={1180}
      className="seat-threads"
      testId="seat-threads"
    >
      <div className="seat-threads__panes">
        <nav ref={listRef} className="seat-threads__list" aria-label={`Threads of ${name}`} onScroll={() => fillList(true)}>
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
        <div className="seat-threads__chat">
          {shown?.kind === "new" ? (
            <NewThread
              seat={seat}
              name={name}
              onCancel={() => setSelection(undefined)}
              onSent={(threadId) => setSelection({ kind: "thread", threadId, sent: true })}
            />
          ) : thread ? (
            <ThreadChat seat={seat} name={name} thread={thread} onLeave={onClose} />
          ) : shown?.kind === "thread" ? (
            <p className="seat-threads__empty">Reading threads…</p>
          ) : (
            <p className="seat-threads__empty">{loaded ? "Pick a thread, or start one." : "Reading threads…"}</p>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/** One mention or subject, drawn as a chip; opening it leaves the threads first. */
function MentionChipView({ chip, onLeave, testId }: { readonly chip: MentionChip; readonly onLeave: () => void; readonly testId: string }) {
  const { ref, kind, ...drawn } = chip;
  // A gone seat or page: its link cannot say which, so it is its words, struck.
  if (kind === undefined) return <del data-testid={testId} data-missing="true">{drawn.label}</del>;
  const open = ref === undefined ? undefined : () => {
    onLeave();
    openMention(ref);
  };
  return <ResourceChip {...drawn} kind={kind} missing={ref === undefined} {...(open === undefined ? {} : { onOpen: open })} data-testid={testId} />;
}

function ThreadChat({
  seat,
  name,
  thread,
  onLeave,
}: {
  readonly seat: SeatAddress;
  readonly name: string;
  readonly thread: SeatThreadSummary;
  /** Opening a mention leaves the threads for what it names. */
  readonly onLeave: () => void;
}) {
  const nodes = useCanvas(seat.canvasName).nodes;
  const kindOf = (id: NodeId) => nodes.get(id)?.kind;
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
      <header className="seat-threads__chat-head">
        <h3 className="seat-threads__chat-title">{subject ? <MentionChipView chip={subject} onLeave={onLeave} testId="seat-threads-subject" /> : thread.title}</h3>
        <div className="seat-threads__chat-meta">
          {thread.participants.map((who) => (
            <Chip key={who} tone={who === "you" ? "cyan" : "steel"}>
              {who}
            </Chip>
          ))}
          <span>
            {count}, started {threadTime(thread.startedAt)}
          </span>
        </div>
      </header>
      <div ref={streamRef} className="seat-threads__stream" data-testid="seat-threads-stream" onScroll={() => fillStream(true)}>
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
        {messages.map((message) => (
          <article
            key={message.messageId}
            className="seat-threads__message"
            data-mine={message.mine ? "true" : undefined}
            data-testid="seat-threads-message"
          >
            <div className="seat-threads__message-head">
              <strong>{message.author}</strong> {threadTime(message.at)}
            </div>
            {message.text !== "" || message.attachments === undefined ? (
              <div className="seat-threads__bubble">
                {mentionChipParts(message.text, kindOf).map((part, index) => {
                  if ("text" in part) return part.text;
                  return <MentionChipView key={index} chip={part.chip} onLeave={onLeave} testId="seat-threads-mention" />;
                })}
              </div>
            ) : null}
            {message.attachments ? <MessageAttachments files={message.attachments} /> : null}
          </article>
        ))}
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
  onCancel,
  onSent,
}: {
  readonly seat: SeatAddress;
  readonly name: string;
  readonly onCancel: () => void;
  readonly onSent: (threadId: string) => void;
}) {
  return (
    <>
      <header className="seat-threads__chat-head">
        <h3 className="seat-threads__chat-title">New thread</h3>
        <div className="seat-threads__chat-meta">
          <span>Its first line becomes the thread's name in the list.</span>
        </div>
      </header>
      <div className="seat-threads__stream">
        <p className="seat-threads__empty">Nothing sent yet.</p>
      </div>
      <ThreadComposer seat={seat} name={name} mode="new" onCancel={onCancel} onSent={onSent} />
    </>
  );
}
