import { useCallback, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { MessageSquare } from "lucide-react";
import type { MentionRef } from "@shared/mention";
import type { NodeKind } from "@shared/model/kinds";
import type { NodeId } from "@shared/physics/schema";
import type { TaskId, TaskNodeId, TaskView } from "@shared/task-model";
import { useResourcesInReach, useSeatsInReach } from "../../lib/mention-sources";
import {
  newPostOpId,
  subjectThreadsLive,
  subjectThreadsSource,
  useSubjectThreads,
  type SubjectThread,
} from "../../lib/subject-threads-source";
import { nodeAt } from "../../lib/use-model";
import { selectNode, state$ } from "../../lib/state";
import { openWorkDetail } from "../../lib/work-detail-open";
import { Button, Eyebrow, ResourceChip } from "../ui";
import { mentionMark } from "../ui/ResourceChip";
import { MentionCombobox } from "../ui/MentionCombobox";
import { actorLabel } from "../artifacts/artifacts-pane-model";
import { stateLabel } from "../../lib/task-ui";
import { mentionLabelKind } from "./mention-chip";
import { textPieces } from "./mention-text";
import { agoLabel } from "./tasks-pane-model";

/** Open what a mention names: a seat or a page is selected on the canvas, a task or an artifact opens in its node. */
export const openMention = (ref: MentionRef): void => {
  switch (ref.kind) {
    case "seat":
    case "page":
      // Select it and bring it into view: it may be off screen.
      selectNode(ref.nodeId);
      state$.focusNodeId.set(ref.nodeId);
      return;
    case "task":
      openWorkDetail(ref.nodeId, { itemId: ref.taskId });
      return;
    case "artifact":
      openWorkDetail(ref.nodeId, { itemId: ref.artifactId });
      return;
  }
};

/** A post's text with its mentions drawn as chips that open. */
export function PostText({
  text,
  nodeKindOf,
  onOpen,
  className = "task-thread__text",
}: {
  readonly className?: string;
  readonly text: string;
  readonly nodeKindOf: (nodeId: NodeId) => NodeKind | undefined;
  readonly onOpen: (ref: MentionRef) => void;
}) {
  const pieces = textPieces(text, nodeKindOf);
  return (
    <p className={className}>
      {pieces.map((piece, index): ReactNode => {
        switch (piece.kind) {
          case "text":
            return <span key={index}>{piece.text}</span>;
          case "gone":
            // A mention of a node that is gone keeps the kind its trigger named: # a task, @ a seat.
            return piece.label.startsWith("#")
              ? <ResourceChip key={index} kind="task" label={piece.label.slice(1)} missing />
              : <ResourceChip key={index} kind="seat" label={piece.label.replace(/^@/, "")} missing />;
          case "mention": {
            const chip = mentionLabelKind(piece.ref, piece.label);
            return <ResourceChip key={index} {...mentionMark(piece.ref)} label={chip.label} number={chip.number} onOpen={() => onOpen(piece.ref)} />;
          }
        }
      })}
    </p>
  );
}

/** The posts of a task's thread, oldest first. Pure: a view over what it is given. */
export function ThreadPosts({
  threads,
  now,
  seatName,
  nodeKindOf,
  onOpen,
}: {
  readonly threads: ReadonlyArray<SubjectThread>;
  readonly now: number;
  readonly seatName: (nodeId: string) => string | undefined;
  readonly nodeKindOf: (nodeId: NodeId) => NodeKind | undefined;
  readonly onOpen: (ref: MentionRef) => void;
}) {
  const posts = threads.flatMap((thread) => thread.posts).sort((a, b) => a.at - b.at);
  if (posts.length === 0) return <p className="task-thread__empty">No comments yet.</p>;
  return (
    <ol className="task-thread__posts" aria-label="Posts">
      {posts.map((post) => (
        <li key={post.messageId} className="task-thread__post" data-testid="task-thread-post">
          <div className="task-thread__meta">
            <strong>{post.author.kind === "operator" ? "You" : (post.name ?? actorLabel(post.author, seatName))}</strong>
            <span>{agoLabel(post.at, now)}</span>
          </div>
          <PostText text={post.text} nodeKindOf={nodeKindOf} onOpen={onOpen} />
        </li>
      ))}
    </ol>
  );
}

/**
 * A task's comment thread (plan 03): what was said, and a field to say more.
 * `@` names a seat in reach of the task's node, `#` a task or page in reach;
 * a mention is a link that opens. Posting goes through the same path as
 * `junto task comment`, so a mention out of reach is refused in words and the
 * text stays.
 */
export function TaskThread({
  canvasName,
  node,
  taskId,
  all,
  now,
  seatName,
}: {
  readonly canvasName: string;
  readonly node: TaskNodeId;
  readonly taskId: TaskId;
  /** Every task of the canvas, for what `#` may name. */
  readonly all: ReadonlyArray<TaskView>;
  readonly now: number;
  readonly seatName: (nodeId: string) => string | undefined;
}) {
  const threads = useSubjectThreads(canvasName, { kind: "task", nodeId: node, taskId });
  const seats = useSeatsInReach(canvasName, node);
  const tasksOf = useMemo(
    () => (nodeId: NodeId) =>
      all
        .filter((view) => view.current.node === nodeId)
        .map((view) => ({
          id: view.taskId,
          title: view.title,
          ...(view.number === undefined ? {} : { number: view.number }),
          note: stateLabel(view.current.state).toLowerCase(),
        })),
    [all],
  );
  const resources = useResourcesInReach(canvasName, node, { tasksOf });
  const candidates = useMemo(() => [...seats, ...resources], [seats, resources]);
  const nodeKindOf = useCallback((nodeId: NodeId): NodeKind | undefined => nodeAt(canvasName, nodeId)?.kind, [canvasName]);
  const count = threads.reduce((sum, thread) => sum + thread.posts.length, 0);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const ready = text.trim().length > 0 && !sending;
  // One op id per post: a retry of the same text is the same post, so a resend after a lost answer posts once.
  const pendingOp = useRef<{ readonly text: string; readonly opId: string } | null>(null);

  const send = async (): Promise<void> => {
    if (!ready) return;
    const sent = text.trim();
    setSending(true);
    setFailure(null);
    const opId = pendingOp.current?.text === sent ? pendingOp.current.opId : newPostOpId();
    pendingOp.current = { text: sent, opId };
    try {
      const outcome = await subjectThreadsSource().post(canvasName, { kind: "task", nodeId: node, taskId }, { text: sent, opId });
      // Clear only what was sent: anything typed while it was in flight stays.
      if (outcome.ok) {
        pendingOp.current = null;
        setText((now) => (now.trim() === sent ? "" : now));
      } else setFailure(outcome.message);
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  // Comments that would stay in this window and never reach main or the seat are not offered.
  if (!subjectThreadsLive()) return null;

  return (
    <section className="task-thread" aria-label="Comment thread" data-testid="task-thread">
      <header className="task-thread__head">
        <MessageSquare size={13} aria-hidden />
        <Eyebrow tone="steel">Comments, {count}</Eyebrow>
        {/* New posts are said politely, by count, wherever they come from. */}
        <span className="sr-only" role="status" aria-live="polite">
          {count === 1 ? "1 comment" : `${count} comments`}
        </span>
      </header>
      <ThreadPosts threads={threads} now={now} seatName={seatName} nodeKindOf={nodeKindOf} onOpen={openMention} />
      <MentionCombobox
        dense
        value={text}
        onValueChange={(next) => {
          setText(next);
          setFailure(null);
        }}
        canvasName={canvasName}
        candidates={candidates}
        listLabel={(trigger) => (trigger === "@" ? "Seats and pages in reach of this task" : "Tasks in reach of this task")}
        noun={{ one: "match", other: "matches" }}
        placeholder="Comment on this task. @ names a seat or page, # a task"
        aria-label="Comment on this task"
        rows={3}
        onKeyDown={onKeyDown}
      />
      <div className="task-thread__foot">
        {failure === null ? null : (
          <p className="task-thread__failure" role="alert" data-testid="task-thread-failure">
            {failure}
          </p>
        )}
        <Button size="xs" variant="chrome" disabled={!ready} onClick={() => void send()}>
          Comment
        </Button>
      </div>
    </section>
  );
}
