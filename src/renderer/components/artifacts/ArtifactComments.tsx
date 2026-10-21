import { useState, type ReactNode } from "react";
import type { MentionRef } from "@shared/mention";
import type { NodeKind } from "@shared/model/kinds";
import type { NodeId } from "@shared/physics/schema";
import { MessageSquare } from "lucide-react";
import type { Anchor } from "@shared/thread-subject";
import type { SubjectThread } from "../../lib/subject-threads-source";
import type { MentionCandidate } from "../../lib/mention-draft";
import { Button, Eyebrow, PaneHeader, ResourceChip } from "../ui";
import { mentionLabelKind } from "../tasks/mention-chip";
import { textPieces } from "../tasks/mention-text";
import { MentionCombobox } from "../ui/MentionCombobox";
import { actorLabel, ageLabel, anchorLabel } from "./artifacts-pane-model";

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
}: {
  readonly canvasName: string;
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
    const refused = await onStart(text, draftAnchor);
    setRefusal(refused);
    if (refused === null) setDraft("");
  };

  return (
    <div className="artifact-comments">
      <PaneHeader eyebrow={`Comments, ${threads.length}`} />
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
}: {
  readonly canvasName: string;
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
  const send = async (): Promise<void> => {
    const text = reply.trim();
    if (text.length === 0) return;
    const refused = await onReply(text);
    setRefusal(refused);
    if (refused === null) setReply("");
  };
  return (
    <li className="artifact-thread">
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
            <PostText text={post.text} nodeKindOf={nodeKindOf} onOpen={onOpenMention} />
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

/** A post's text, its mentions drawn as chips that open what they name. */
function PostText({
  text,
  nodeKindOf,
  onOpen,
}: {
  readonly text: string;
  readonly nodeKindOf: (nodeId: NodeId) => NodeKind | undefined;
  readonly onOpen: (ref: MentionRef) => void;
}) {
  return (
    <p className="artifact-thread__text">
      {textPieces(text, nodeKindOf).map((piece, index): ReactNode => {
        switch (piece.kind) {
          case "text":
            return <span key={index}>{piece.text}</span>;
          case "gone":
            return <ResourceChip key={index} kind="seat" label={piece.label.replace(/^[@#]/u, "")} missing />;
          case "mention": {
            const chip = mentionLabelKind(piece.ref, piece.label);
            return (
              <ResourceChip
                key={index}
                kind={chip.kind}
                label={chip.label}
                {...(chip.number === undefined ? {} : { number: chip.number })}
                onOpen={() => onOpen(piece.ref)}
              />
            );
          }
        }
      })}
    </p>
  );
}
