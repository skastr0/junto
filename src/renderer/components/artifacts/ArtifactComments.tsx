import { useEffect, useRef, useState } from "react";
import type { MentionRef } from "@shared/mention";
import type { NodeKind } from "@shared/model/kinds";
import type { NodeId } from "@shared/physics/schema";
import { MessageSquare, PanelRightClose } from "lucide-react";
import type { Anchor } from "@shared/thread-subject";
import type { SubjectThread } from "../../lib/subject-threads-source";
import type { MentionCandidate } from "../../lib/mention-draft";
import { AgentPortrait } from "../AgentPortrait";
import { Button, Eyebrow, IconButton, PaneHeader } from "../ui";
import { PostText } from "../tasks/TaskThread";
import { MentionCombobox } from "../ui/MentionCombobox";
import { actorLabel, ageLabel, anchorLabel } from "./artifacts-pane-model";
import { commentCount, commentSeats } from "./comments-rail-model";
import "./artifact-comments.css";

/** Faces the collapsed edge stacks before it says "+N". */
const EDGE_SEATS = 4;

/**
 * The comments rail collapsed: a thin edge that says whether the artifact has
 * comments, how many, and which seats took part, by their portraits. The
 * whole edge is one toggle; Cmd+Shift+M is the same toggle from the keyboard.
 */
export function ArtifactCommentsEdge({
  threads,
  seatName,
  onOpen,
}: {
  readonly threads: ReadonlyArray<SubjectThread>;
  readonly seatName?: (nodeId: string) => string | undefined;
  readonly onOpen: () => void;
}) {
  const count = commentCount(threads);
  const seats = commentSeats(threads);
  const shown = seats.slice(0, EDGE_SEATS);
  const names = seats.map((id) => seatName?.(id) ?? id);
  return (
    <button
      type="button"
      data-comments-toggle=""
      className="artifact-comments-edge"
      data-has-comments={count > 0 ? "true" : undefined}
      aria-label={count > 0 ? `Comments, ${String(count)}` : "Comments"}
      aria-expanded={false}
      aria-keyshortcuts="Meta+Shift+M"
      title={names.length > 0 ? `Open comments, from ${names.join(", ")}` : "Open comments"}
      onClick={onOpen}
    >
      <MessageSquare size={14} aria-hidden className="artifact-comments-edge__mark" />
      {count > 0 ? (
        <span className="artifact-comments-edge__count" data-testid="comments-edge-count">
          {count}
        </span>
      ) : null}
      {shown.length > 0 ? (
        <span className="artifact-comments-edge__seats" aria-hidden>
          {shown.map((id) => (
            <span key={id} className="artifact-comments-edge__seat" data-testid="comments-edge-seat" data-seat-id={id}>
              <AgentPortrait identity={id} size={20} frame="round" outline={false} badge={false} />
            </span>
          ))}
          {seats.length > shown.length ? (
            <span className="artifact-comments-edge__more">+{seats.length - shown.length}</span>
          ) : null}
        </span>
      ) : null}
    </button>
  );
}

/**
 * The comments rail: the artifact's threads in time order, each hung on a
 * place in it (0.10 has no resolved state for a thread). A
 * draft anchor (a selection, cells or an area picked in the editor) opens a
 * new thread there; without one a new thread is on the whole artifact.
 * Composers take mentions of the seats in reach of the node (03).
 */
export function ArtifactComments({
  threads,
  draftAnchor,
  now,
  onStart,
  onReply,
  onClearAnchor,
  onFocusAnchor,
  seatName,
  canvasName,
  mentionable,
  nodeKindOf,
  onOpenMention,
  onCollapse,
  reveal,
}: {
  readonly canvasName: string;
  /** Collapses the rail to its edge; absent, the rail has no collapse. */
  readonly onCollapse?: () => void;
  /** A thread to bring into view and flash: a marker in the artifact was pressed. */
  readonly reveal?: { readonly threadId: string; readonly nonce: number };
  /** Seats in reach of the Artifacts node: the only ones a comment may name. */
  readonly mentionable: ReadonlyArray<MentionCandidate>;
  readonly threads: ReadonlyArray<SubjectThread>;
  /** A seat's name by its node id, for post authors. */
  readonly seatName?: (nodeId: string) => string | undefined;
  readonly draftAnchor: Anchor | undefined;
  readonly now: number;
  /** Post; resolves to the refusal in words, or null when posted. A refused text stays in its composer. */
  readonly onStart: (text: string, anchor: Anchor | undefined) => Promise<string | null>;
  readonly onReply: (threadId: string, text: string) => Promise<string | null>;
  /** Reads a mention link's node, to draw it as a chip. */
  readonly nodeKindOf: (nodeId: NodeId) => NodeKind | undefined;
  readonly onOpenMention: (ref: MentionRef) => void;
  readonly onClearAnchor: () => void;
  readonly onFocusAnchor?: (anchor: Anchor | undefined) => void;
}) {
  const [draft, setDraft] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);

  const start = async (): Promise<void> => {
    const text = draft.trim();
    if (text.length === 0) return;
    const refused = await onStart(text, draftAnchor).catch(() => "Not posted: the comment could not reach Junto. Try again.");
    setRefusal(refused);
    // Only what was sent clears: text typed while it was in flight stays.
    if (refused === null) setDraft((now) => (now.trim() === text ? "" : now));
  };

  return (
    <div className="artifact-comments">
      <PaneHeader
        eyebrow={`Comments, ${commentCount(threads)}`}
        actions={
          onCollapse ? (
            <IconButton
              data-comments-toggle=""
              aria-label="Comments"
              aria-expanded
              aria-keyshortcuts="Meta+Shift+M"
              title="Collapse comments"
              size="sm"
              onClick={onCollapse}
            >
              <PanelRightClose size={14} aria-hidden />
            </IconButton>
          ) : undefined
        }
      />
      <div className="artifact-comments__new">
        <div className="artifact-comments__anchor">
          <Eyebrow tone={draftAnchor ? "cyan" : "faint"} size="xs">
            On {anchorLabel(draftAnchor)}
          </Eyebrow>
          {draftAnchor ? (
            <Button size="xs" variant="subtle" onClick={onClearAnchor}>
              Whole artifact instead
            </Button>
          ) : null}
        </div>
        <MentionCombobox
          dense
          rows={3}
          aria-label="New comment"
          placeholder={draftAnchor ? "Comment on this place, @ names a seat" : "Comment on the artifact, @ names a seat"}
          value={draft}
          onValueChange={(next) => setDraft(next)}
          canvasName={canvasName}
          candidates={mentionable}
          listLabel={() => "Seats in reach of these artifacts"}
          noun={{ one: "seat", other: "seats" }}
          aria-keyshortcuts="Meta+Enter Control+Enter"
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              void start();
            }
          }}
        />
        {refusal ? (
          <p className="artifact-comments__refusal" role="alert">
            {refusal}
          </p>
        ) : null}
        <Button size="sm" variant="primary" disabled={draft.trim().length === 0} onClick={() => void start()}>
          Comment
        </Button>
      </div>
      {threads.length === 0 ? (
        <p className="artifact-comments__empty">
          No comments yet. Select a place in the artifact to comment on it.
        </p>
      ) : (
        <ol className="artifact-comments__threads" aria-label="Threads">
          {threads.map((thread) => (
            <ThreadView
              key={thread.threadId}
              thread={thread}
              now={now}
              seatName={seatName}
              canvasName={canvasName}
              mentionable={mentionable}
              nodeKindOf={nodeKindOf}
              onOpenMention={onOpenMention}
              onReply={(text) => onReply(thread.threadId, text)}
              onFocus={onFocusAnchor ? () => onFocusAnchor(thread.anchor) : undefined}
              reveal={reveal?.threadId === thread.threadId ? reveal.nonce : undefined}
            />
          ))}
        </ol>
      )}
    </div>
  );
}

function ThreadView({
  thread,
  now,
  onReply,
  onFocus,
  seatName,
  canvasName,
  mentionable,
  nodeKindOf,
  onOpenMention,
  reveal,
}: {
  readonly canvasName: string;
  /** Changes each time a marker for this thread is pressed. */
  readonly reveal?: number;
  readonly mentionable: ReadonlyArray<MentionCandidate>;
  readonly nodeKindOf: (nodeId: NodeId) => NodeKind | undefined;
  readonly onOpenMention: (ref: MentionRef) => void;
  readonly thread: SubjectThread;
  readonly now: number;
  readonly seatName?: (nodeId: string) => string | undefined;
  readonly onReply: (text: string) => Promise<string | null>;
  readonly onFocus?: () => void;
}) {
  const [reply, setReply] = useState("");
  const [refusal, setRefusal] = useState<string | null>(null);
  const itemRef = useRef<HTMLLIElement>(null);
  const [flash, setFlash] = useState(false);
  // Scrolls, never focuses: the operator's keyboard stays where it was.
  useEffect(() => {
    if (reveal === undefined) return;
    itemRef.current?.scrollIntoView({ block: "nearest" });
    setFlash(true);
  }, [reveal]);
  const send = async (): Promise<void> => {
    const text = reply.trim();
    if (text.length === 0) return;
    const refused = await onReply(text).catch(() => "Not posted: the reply could not reach Junto. Try again.");
    setRefusal(refused);
    if (refused === null) setReply((now) => (now.trim() === text ? "" : now));
  };
  return (
    <li
      ref={itemRef}
      className="artifact-thread"
      data-thread-id={thread.threadId}
      data-revealed={flash ? "true" : undefined}
      onAnimationEnd={() => setFlash(false)}
    >
      <div className="artifact-thread__head">
        <button type="button" className="artifact-thread__anchor" onClick={onFocus} disabled={onFocus === undefined}>
          <MessageSquare size={12} aria-hidden />
          <span>{anchorLabel(thread.anchor)}</span>
        </button>
      </div>
      <ol className="artifact-thread__posts">
        {thread.posts.map((post) => (
          <li key={post.messageId} className="artifact-thread__post">
            <span className="artifact-thread__author">{actorLabel(post.author, seatName)}</span>
            <span className="artifact-thread__age">{ageLabel(post.at, now)}</span>
            <PostText className="artifact-thread__text" text={post.text} nodeKindOf={nodeKindOf} onOpen={onOpenMention} />
          </li>
        ))}
      </ol>
      <div className="artifact-thread__reply">
          <MentionCombobox
            dense
            rows={2}
            aria-label="Reply"
            placeholder="Reply"
            value={reply}
            onValueChange={(next) => setReply(next)}
            canvasName={canvasName}
            candidates={mentionable}
            listLabel={() => "Seats in reach of these artifacts"}
            noun={{ one: "seat", other: "seats" }}
            aria-keyshortcuts="Meta+Enter Control+Enter"
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void send();
              }
            }}
          />
          {refusal ? (
            <p className="artifact-comments__refusal" role="alert">
              {refusal}
            </p>
          ) : null}
          {reply.trim().length > 0 ? (
            <Button size="xs" variant="chrome" onClick={() => void send()}>
              Reply
            </Button>
          ) : null}
        </div>
    </li>
  );
}

