import { useEffect, useMemo, useState } from "react";
import { Send } from "lucide-react";
import type { CanvasNode } from "@shared/canvas";
import type { BoardConnectedActor } from "@shared/board-actors";
import type { PadElementId, PadPatch, PadPin } from "@shared/pad";
import { boardAuthorLabel } from "../../lib/board-author";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { Textarea } from "../ui/Field";
import {
  applyMentionPick,
  filterMentionActors,
  mentionQueryAt,
  newPadPostId,
  pinReplyPatch,
  toggleMention,
  upsertPinPatch,
} from "./pad-editor-model";
import "../work/work-ledger.css";

const actorLabel = (
  nodeId: string,
  actors: ReadonlyArray<BoardConnectedActor>,
  nodes: ReadonlyArray<CanvasNode>,
): string => {
  const actor = actors.find((item) => item.nodeId === nodeId);
  if (actor) return actor.label;
  const node = nodes.find((item) => item.id === nodeId);
  return node ? boardAuthorLabel({ kind: "actor", nodeId }, nodes) : nodeId;
};

export function PadPinThread({
  pin,
  nodes,
  actors,
  onCommit,
}: {
  readonly pin: PadPin;
  readonly nodes: ReadonlyArray<CanvasNode>;
  readonly actors: ReadonlyArray<BoardConnectedActor>;
  readonly onCommit: (patches: ReadonlyArray<PadPatch>) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState("");
  const [cursor, setCursor] = useState(0);
  const [highlight, setHighlight] = useState(0);

  useEffect(() => {
    setDraft("");
    setCursor(0);
    setHighlight(0);
  }, [pin.id]);

  const mention = mentionQueryAt(draft, cursor);
  const suggestions = useMemo(
    () => (mention ? filterMentionActors(actors, mention.query) : []),
    [actors, mention],
  );

  useEffect(() => {
    setHighlight(0);
  }, [mention?.query, mention?.start]);

  const commitMentions = (mentions: ReadonlyArray<string>) =>
    onCommit([
      upsertPinPatch({
        id: pin.id,
        x: pin.x,
        y: pin.y,
        mentions: [...mentions],
        ...(pin.bounds ? { bounds: pin.bounds } : {}),
      }),
    ]);

  const pickActor = (nodeId: string) => {
    const actor = actors.find((item) => item.nodeId === nodeId);
    if (!actor) return;
    const nextMentions = pin.mentions.includes(nodeId)
      ? pin.mentions
      : toggleMention(pin.mentions, nodeId);
    if (nextMentions !== pin.mentions) void commitMentions(nextMentions);
    const replaced = applyMentionPick(draft, cursor, actor.label);
    if (replaced) {
      setDraft(replaced.text);
      setCursor(replaced.cursor);
    }
  };

  const submit = async () => {
    const text = draft.trim();
    if (!text) return;
    const ok = await onCommit([
      pinReplyPatch(pin.id as PadElementId, text, newPadPostId()),
    ]);
    if (ok) setDraft("");
  };

  return (
    <aside className="pad-pin-thread" data-testid="pad-pin-thread" aria-label="Pin thread">
      <header className="pad-pin-thread__header">
        <strong>Pin</strong>
        <span>
          {Math.round(pin.x)},{Math.round(pin.y)}
          {pin.bounds ? ` - ${Math.round(pin.bounds.w)}x${Math.round(pin.bounds.h)}` : ""}
        </span>
      </header>
      <div className="pad-pin-thread__mentions" data-testid="pad-pin-mentions">
        {pin.mentions.length === 0 ? (
          <span className="pad-pin-thread__hint">@ inbound wired seats only</span>
        ) : (
          pin.mentions.map((nodeId) => (
            <button
              key={nodeId}
              type="button"
              className="pad-pin-thread__chip"
              aria-label={`Remove mention ${actorLabel(nodeId, actors, nodes)}`}
              onClick={() => void commitMentions(toggleMention(pin.mentions, nodeId))}
            >
              <Chip tone="amber">@{actorLabel(nodeId, actors, nodes)}</Chip>
            </button>
          ))
        )}
      </div>
      <div className="board-posts pad-pin-thread__posts" aria-live="polite">
        {pin.posts.length === 0 ? (
          <div className="board-posts__empty">No posts yet. Start the conversation below.</div>
        ) : (
          pin.posts.map((post) => (
            <article key={post.postId} className="board-post" data-testid="board-post">
              <div className="board-post__avatar" aria-hidden>
                {boardAuthorLabel(post.author, nodes).slice(0, 1).toUpperCase()}
              </div>
              <div className="board-post__body">
                <header>
                  <strong>{boardAuthorLabel(post.author, nodes)}</strong>
                </header>
                <p>
                  {post.parts.flatMap((part) =>
                    part.kind === "text" ? [part.text] : [],
                  ).join("\n") || "—"}
                </p>
              </div>
            </article>
          ))
        )}
      </div>
      <form
        className="board-reply pad-pin-thread__reply"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div className="pad-mention-wrap">
          <Textarea
            aria-label="Pin reply"
            data-testid="pad-pin-reply"
            placeholder="Write a reply… @ to mention a wired seat"
            value={draft}
            rows={3}
            onChange={(event) => {
              setDraft(event.target.value);
              setCursor(event.target.selectionStart);
            }}
            onSelect={(event) => {
              setCursor(event.currentTarget.selectionStart);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                // Escape dismisses the mention menu (if open) and never
                // destroys the draft or closes the pad. The editor's global
                // handler stays out of typing targets; stopPropagation keeps
                // other window listeners out too.
                event.preventDefault();
                event.stopPropagation();
                setCursor(0);
                return;
              }
              if (mention && suggestions.length > 0) {
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setHighlight((index) => (index + 1) % suggestions.length);
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setHighlight((index) =>
                    (index - 1 + suggestions.length) % suggestions.length,
                  );
                  return;
                }
                if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
                  const pick = suggestions[highlight];
                  if (pick) {
                    event.preventDefault();
                    pickActor(pick.nodeId);
                    return;
                  }
                }
              }
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          {mention ? (
            <ul className="pad-mention-list" role="listbox" aria-label="Inbound actors" data-testid="pad-mention-list">
              {suggestions.length === 0 ? (
                <li className="pad-mention-list__empty">No inbound wired seat</li>
              ) : (
                suggestions.map((actor, index) => (
                  <li key={actor.nodeId}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={index === highlight}
                      className="pad-mention-option"
                      data-testid="pad-mention-option"
                      data-node-id={actor.nodeId}
                      onMouseDown={(event) => {
                        // Keep focus in the textarea while choosing a mention.
                        event.preventDefault();
                      }}
                      onClick={() => pickActor(actor.nodeId)}
                    >
                      <strong>{actor.label}</strong>
                      <span>{actor.nodeId}</span>
                    </button>
                  </li>
                ))
              )}
            </ul>
          ) : null}
        </div>
        <div className="board-reply__footer">
          <span>⌘ Enter to post</span>
          <Button size="sm" variant="primary" disabled={!draft.trim()} type="submit">
            <Send size={12} aria-hidden />
            Post reply
          </Button>
        </div>
      </form>
    </aside>
  );
}
