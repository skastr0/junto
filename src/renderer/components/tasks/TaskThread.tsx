import { useCallback, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { MessageSquare } from "lucide-react";
import type { MentionRef } from "@shared/mention";
import type { NodeKind } from "@shared/model/kinds";
import type { NodeId } from "@shared/physics/schema";
import type { TaskId, TaskNodeId, TaskView } from "@shared/task-model";
import { useResourcesInReach, useSeatsInReach } from "../../lib/mention-sources";
import {
  newPostOpId,
  subjectThreadsSource,
  useSubjectThreads,
  type SubjectThread,
} from "../../lib/subject-threads-source";
import { nodeAt } from "../../lib/use-model";
import { selectNode } from "../../lib/state";
import { openWorkDetail } from "../../lib/work-detail-open";
import { Button, Eyebrow, ResourceChip } from "../ui";
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
      selectNode(ref.nodeId);
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
function PostText({
  text,
  nodeKindOf,
  onOpen,
}: {
  readonly text: string;
  readonly nodeKindOf: (nodeId: NodeId) => NodeKind | undefined;
  readonly onOpen: (ref: MentionRef) => void;
}) {
  const pieces = textPieces(text, nodeKindOf);
  return (
    <p className="task-thread__text">
      {pieces.map((piece, index): ReactNode => {
        switch (piece.kind) {
          case "text":
            return <span key={index}>{piece.text}</span>;
          case "gone":
            return <ResourceChip key={index} kind="seat" label={piece.label.replace(/^[@#]/, "")} missing />;
          case "mention": {
            const chip = mentionLabelKind(piece.ref, piece.label);
            return <ResourceChip key={index} kind={chip.kind} label={chip.label} number={chip.number} onOpen={() => onOpen(piece.ref)} />;
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
    <ol className="task-thread__posts" aria-label="Comments">
      {posts.map((post) => (
        <li key={post.messageId} className="task-thread__post" data-testid="task-thread-post">
          <div className="task-thread__meta">
            <strong>{actorLabel(post.author, seatName)}</strong>
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
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const setField = useCallback((element: HTMLTextAreaElement | null) => {
    void element;
  }, []);
  const ready = text.trim().length > 0 && !sending;

  const send = async (): Promise<void> => {
    if (!ready) return;
    setSending(true);
    setFailure(null);
    const outcome = await subjectThreadsSource().post(canvasName, { kind: "task", nodeId: node, taskId }, { text: text.trim(), opId: newPostOpId() });
    setSending(false);
    if (outcome.ok) setText("");
    else setFailure(outcome.message);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void send();
    }
  };

  return (
    <section className="task-thread" aria-label="Comments" data-testid="task-thread">
      <header className="task-thread__head">
        <MessageSquare size={13} aria-hidden />
        <Eyebrow tone="steel">Comments, {threads.reduce((sum, thread) => sum + thread.posts.length, 0)}</Eyebrow>
      </header>
      <ThreadPosts threads={threads} now={now} seatName={seatName} nodeKindOf={nodeKindOf} onOpen={openMention} />
      <MentionCombobox
        fieldRef={setField}
        dense
        value={text}
        onValueChange={(next) => {
          setText(next);
          setFailure(null);
        }}
        canvasName={canvasName}
        candidates={candidates}
        listLabel={(trigger) => (trigger === "@" ? "Seats in reach of this task" : "Tasks and pages in reach")}
        noun={{ one: "match", other: "matches" }}
        placeholder="Comment on this task. @ names a seat, # a task or page"
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
