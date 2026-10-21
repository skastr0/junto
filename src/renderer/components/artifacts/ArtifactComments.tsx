import { useState } from "react";
import { Check, MessageSquare, Undo2 } from "lucide-react";
import type { Anchor } from "@shared/thread-subject";
import type { ArtifactThread } from "../../lib/artifacts-source";
import { Button, Eyebrow, PaneHeader, Textarea } from "../ui";
import { actorLabel, ageLabel, anchorLabel } from "./artifacts-pane-model";

/**
 * The comments rail: the artifact's threads, each hung on a place in it. A
 * draft anchor (a selection, cells or an area picked in the editor) opens a
 * new thread there; without one a new thread is on the whole artifact.
 */
export function ArtifactComments({
  threads,
  draftAnchor,
  now,
  onStart,
  onReply,
  onResolve,
  onClearAnchor,
  onFocusAnchor,
}: {
  readonly threads: ReadonlyArray<ArtifactThread>;
  readonly draftAnchor: Anchor | undefined;
  readonly now: number;
  readonly onStart: (text: string, anchor: Anchor | undefined) => void;
  readonly onReply: (threadId: string, text: string) => void;
  readonly onResolve: (threadId: string, resolved: boolean) => void;
  readonly onClearAnchor: () => void;
  readonly onFocusAnchor?: (anchor: Anchor | undefined) => void;
}) {
  const [draft, setDraft] = useState("");
  const [showResolved, setShowResolved] = useState(false);
  const open = threads.filter((thread) => !thread.resolved);
  const resolved = threads.filter((thread) => thread.resolved);
  const listed = showResolved ? threads : open;

  const start = (): void => {
    const text = draft.trim();
    if (text.length === 0) return;
    onStart(text, draftAnchor);
    setDraft("");
  };

  return (
    <div className="artifact-comments">
      <PaneHeader
        eyebrow={`Comments, ${open.length} open`}
        actions={
          resolved.length > 0 ? (
            <Button size="xs" variant="subtle" aria-pressed={showResolved} onClick={() => setShowResolved(!showResolved)}>
              {showResolved ? "Hide resolved" : `Resolved ${resolved.length}`}
            </Button>
          ) : null
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
        <Textarea
          dense
          aria-label="New comment"
          placeholder={draftAnchor ? "Comment on this place" : "Comment on the artifact"}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              start();
            }
          }}
        />
        <Button size="sm" variant="primary" disabled={draft.trim().length === 0} onClick={start}>
          Comment
        </Button>
      </div>
      {listed.length === 0 ? (
        <p className="artifact-comments__empty">
          No comments yet. Select a place in the artifact to comment on it.
        </p>
      ) : (
        <ol className="artifact-comments__threads" aria-label="Threads">
          {listed.map((thread) => (
            <ThreadView
              key={thread.threadId}
              thread={thread}
              now={now}
              onReply={(text) => onReply(thread.threadId, text)}
              onResolve={() => onResolve(thread.threadId, !thread.resolved)}
              onFocus={onFocusAnchor ? () => onFocusAnchor(thread.anchor) : undefined}
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
  onResolve,
  onFocus,
}: {
  readonly thread: ArtifactThread;
  readonly now: number;
  readonly onReply: (text: string) => void;
  readonly onResolve: () => void;
  readonly onFocus?: () => void;
}) {
  const [reply, setReply] = useState("");
  const send = (): void => {
    const text = reply.trim();
    if (text.length === 0) return;
    onReply(text);
    setReply("");
  };
  return (
    <li className="artifact-thread" data-resolved={thread.resolved ? "true" : undefined}>
      <div className="artifact-thread__head">
        <button type="button" className="artifact-thread__anchor" onClick={onFocus} disabled={onFocus === undefined}>
          <MessageSquare size={12} aria-hidden />
          <span>{anchorLabel(thread.anchor)}</span>
          <span className="artifact-thread__version">v{thread.version}</span>
        </button>
        <Button size="xs" variant="subtle" onClick={onResolve}>
          {thread.resolved ? <Undo2 size={12} aria-hidden /> : <Check size={12} aria-hidden />}
          {thread.resolved ? "Reopen" : "Resolve"}
        </Button>
      </div>
      <ol className="artifact-thread__posts">
        {thread.posts.map((post) => (
          <li key={post.postId} className="artifact-thread__post">
            <span className="artifact-thread__author">{actorLabel(post.author)}</span>
            <span className="artifact-thread__age">{ageLabel(post.at, now)}</span>
            <p className="artifact-thread__text">{post.text}</p>
          </li>
        ))}
      </ol>
      {thread.resolved ? null : (
        <div className="artifact-thread__reply">
          <Textarea
            dense
            aria-label="Reply"
            placeholder="Reply"
            value={reply}
            onChange={(event) => setReply(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                send();
              }
            }}
          />
          {reply.trim().length > 0 ? (
            <Button size="xs" variant="chrome" onClick={send}>
              Reply
            </Button>
          ) : null}
        </div>
      )}
    </li>
  );
}
