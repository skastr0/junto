import { useState } from "react";
import { MessageSquare, Send } from "lucide-react";
import type { Message, Part, Task } from "@shared/work-model";
import { messageIdTimeMs } from "@shared/message-delivery";
import { Button } from "../ui/Button";
import { Chip, type ChipTone } from "../ui/Chip";
import { Textarea } from "../ui/Field";
import { ContentMedia } from "./ContentMedia";
import "./task-thread.css";

export type TaskThreadKind =
  | "brief"
  | "update"
  | "defect"
  | "incoming"
  | "comment"
  | "receipt"
  | "verdict";

export type TaskThreadEntry = {
  readonly message: Message;
  readonly kind: TaskThreadKind;
  readonly author: string;
  readonly timeMs: number | undefined;
};

const textOf = (message: Message): string =>
  message.parts
    .flatMap((part) => (part.kind === "text" ? [part.text] : []))
    .join("\n")
    .trim();

const metadataText = (message: Message, key: string): string | undefined => {
  const value = message.metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

export const taskThreadKind = (
  message: Message,
  index: number,
): TaskThreadKind => {
  if (index === 0) return "brief";
  const explicit = metadataText(message, "junto.taskThread.kind");
  if (
    explicit === "update" ||
    explicit === "defect" ||
    explicit === "incoming" ||
    explicit === "comment" ||
    explicit === "receipt" ||
    explicit === "verdict"
  ) {
    return explicit;
  }
  const mailKind = metadataText(message, "mailKind");
  if (mailKind === "receipt") return "receipt";
  if (mailKind === "prompt") return "comment";
  if (message.metadata?.reviewVerdict !== undefined) return "verdict";
  const text = textOf(message);
  if (/^defect(?:\s+from)?\b/iu.test(text)) return "defect";
  if (/^sent on\s+from\b/iu.test(text)) return "incoming";
  if (message.metadata?.taskComment === true || message.metadata?.factoryMail === true) {
    return "comment";
  }
  return message.role === "user" ? "comment" : "update";
};

const claimedSeatFrom = (text: string): string | undefined =>
  /^claimed by (seat_[a-f0-9]{64})\b/iu.exec(text)?.[1];

const sourceNodeFrom = (text: string): string | undefined =>
  /^(?:sent on|defect) from "([^"]+)"/iu.exec(text)?.[1];

/**
 * Chronological thread projection. Attribution stays derived from message
 * metadata and the claim messages already in Task.history; nothing new is
 * stored on the task.
 */
export const buildTaskThread = (
  task: Task,
  names: {
    readonly seat: (seatId: string) => string | undefined;
    readonly node: (nodeId: string) => string | undefined;
  },
): ReadonlyArray<TaskThreadEntry> => {
  let activeSeat: string | undefined;
  return task.history.map((message, index) => {
    const text = textOf(message);
    const claimedSeat = claimedSeatFrom(text);
    if (claimedSeat !== undefined) activeSeat = claimedSeat;
    const fromNode = metadataText(message, "fromSeat");
    const sourceNode = sourceNodeFrom(text);
    const author =
      fromNode === "operator"
        ? "Operator"
        : fromNode !== undefined
          ? names.node(fromNode) ?? fromNode
          : index === 0 || message.role === "user"
            ? "Operator"
            : claimedSeat !== undefined
              ? names.seat(claimedSeat) ?? claimedSeat
              : activeSeat !== undefined
                ? names.seat(activeSeat) ?? activeSeat
                : sourceNode !== undefined
                  ? names.node(sourceNode) ?? sourceNode
                  : task.claimedBy !== undefined
                    ? names.seat(task.claimedBy) ?? task.claimedBy
                    : "Agent";
    return {
      message,
      kind: taskThreadKind(message, index),
      author,
      timeMs: messageIdTimeMs(message.messageId),
    };
  });
};

const kindTone = (kind: TaskThreadKind): ChipTone => {
  if (kind === "brief") return "amber";
  if (kind === "defect") return "crimson";
  if (kind === "incoming") return "violet";
  if (kind === "comment") return "cyan";
  if (kind === "receipt") return "violet";
  if (kind === "verdict") return "amber";
  return "steel";
};

const formatTime = (timeMs: number | undefined): string =>
  timeMs === undefined
    ? "Time unavailable"
    : new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(timeMs);

function ThreadPart({
  part,
  index,
}: {
  readonly part: Part;
  readonly index: number;
}) {
  if (part.kind === "text") {
    return <p className="task-thread__text">{part.text}</p>;
  }
  if (part.kind === "content") {
    return (
      <div className="task-thread__attachment">
        <ContentMedia
          contentRef={part.ref}
          alt={part.ref.displayName ?? `Thread attachment ${index + 1}`}
        />
      </div>
    );
  }
  if (part.kind === "url") {
    return (
      <a
        className="task-thread__link"
        href={part.url}
        target="_blank"
        rel="noreferrer"
      >
        {part.url}
      </a>
    );
  }
  if (part.kind === "raw" && part.mediaType?.startsWith("image/")) {
    return (
      <img
        className="task-thread__image"
        src={`data:${part.mediaType};base64,${part.bytesBase64}`}
        alt={`Thread attachment ${index + 1}`}
      />
    );
  }
  if (part.kind === "raw") {
    return (
      <span className="task-thread__attachment-label">
        Attachment, {part.mediaType ?? "binary data"}
      </span>
    );
  }
  return (
    <pre className="task-thread__data">{JSON.stringify(part.data, null, 2)}</pre>
  );
}

export function TaskThread({
  task,
  pending,
  seatName,
  nodeName,
  onComment,
}: {
  readonly task: Task;
  readonly pending: boolean;
  readonly seatName: (seatId: string) => string | undefined;
  readonly nodeName: (nodeId: string) => string | undefined;
  readonly onComment: (text: string) => Promise<boolean>;
}) {
  const [comment, setComment] = useState("");
  const entries = buildTaskThread(task, { seat: seatName, node: nodeName });
  const submit = async () => {
    const text = comment.trim();
    if (!text || pending) return;
    if (await onComment(text)) setComment("");
  };

  return (
    <section className="task-thread" aria-label="Task thread">
      <header className="task-thread__heading">
        <div>
          <span>Work record</span>
          <h3>
            <MessageSquare size={13} aria-hidden />
            Thread
          </h3>
        </div>
        <span>{`${entries.length} ${entries.length === 1 ? "message" : "messages"}`}</span>
      </header>

      <ol className="task-thread__messages">
        {entries.map((entry) => (
          <li
            key={entry.message.messageId}
            className="task-thread__message"
            data-kind={entry.kind}
          >
            <div className="task-thread__timeline" aria-hidden>
              <span />
            </div>
            <article>
              <header>
                <strong>{entry.author}</strong>
                <Chip tone={kindTone(entry.kind)}>{entry.kind}</Chip>
                <time
                  dateTime={
                    entry.timeMs === undefined
                      ? undefined
                      : new Date(entry.timeMs).toISOString()
                  }
                >
                  {formatTime(entry.timeMs)}
                </time>
              </header>
              <div className="task-thread__parts">
                {entry.message.parts.map((part, index) => (
                  <ThreadPart
                    key={`${entry.message.messageId}-${part.kind}-${index}`}
                    part={part}
                    index={index}
                  />
                ))}
              </div>
            </article>
          </li>
        ))}
      </ol>

      <div className="task-thread__composer">
        <label htmlFor={`task-comment-${task.id}`}>Add to the thread</label>
        <Textarea
          id={`task-comment-${task.id}`}
          aria-label="Add a task comment"
          value={comment}
          disabled={pending}
          rows={3}
          placeholder="Leave context for the current owner…"
          aria-keyshortcuts="Meta+Enter Control+Enter"
          onChange={(event) => setComment(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey)) return;
            event.preventDefault();
            void submit();
          }}
        />
        <div>
          <span>Notifies the current owner when one is active.</span>
          <Button
            size="sm"
            variant="primary"
            disabled={pending || !comment.trim()}
            title="⌘↵ / Ctrl+Enter"
            onClick={() => void submit()}
          >
            <Send size={12} />
            Comment
          </Button>
        </div>
      </div>
    </section>
  );
}
