import { useLayoutEffect, useRef, useState } from "react";
import { Plus, X } from "lucide-react";
import {
  betweenLine,
  groupSeatThreads,
  mentionParts,
  participantsLine,
  threadTime,
  useSeatThreadMentionables,
  useSeatThreadMessages,
  useSeatThreads,
  type SeatAddress,
  type SeatThreadSummary,
} from "../../lib/seat-threads";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { Dialog } from "../ui/Dialog";
import { Eyebrow } from "../ui/Eyebrow";
import { IconButton } from "../ui/IconButton";
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
  const { threads, loaded, error } = useSeatThreads(seat);
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
        <span className="seat-threads__row-title">{item.title}</span>
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
        <nav className="seat-threads__list" aria-label={`Threads of ${name}`}>
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
            <ThreadChat seat={seat} name={name} thread={thread} />
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

function ThreadChat({
  seat,
  name,
  thread,
}: {
  readonly seat: SeatAddress;
  readonly name: string;
  readonly thread: SeatThreadSummary;
}) {
  const { messages, loaded, error } = useSeatThreadMessages(seat, thread.threadId);
  // An @ names a seat as a reference: those wired to this seat, and those in the thread.
  const mentionables = useSeatThreadMentionables(seat);
  const names = [...mentionables.map((candidate) => candidate.name), ...thread.participants, name];
  const streamRef = useRef<HTMLDivElement>(null);
  // The newest at the bottom, in view: on open and as messages arrive.
  useLayoutEffect(() => {
    const stream = streamRef.current;
    if (stream) stream.scrollTop = stream.scrollHeight;
  }, [thread.threadId, messages.length]);
  const count = `${thread.messageCount} ${thread.messageCount === 1 ? "message" : "messages"}`;
  const lastId = messages.at(-1)?.messageId;
  return (
    <>
      <header className="seat-threads__chat-head">
        <h3 className="seat-threads__chat-title">{thread.title}</h3>
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
      <div ref={streamRef} className="seat-threads__stream" data-testid="seat-threads-stream">
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
            <div className="seat-threads__bubble">
              {mentionParts(message.text, names).map((part, index) =>
                part.mention ? (
                  <span key={index} className="seat-threads__mention" data-testid="seat-threads-mention">
                    {part.text}
                  </span>
                ) : (
                  part.text
                ),
              )}
            </div>
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
