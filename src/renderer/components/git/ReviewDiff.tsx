/**
 * One file's diff in a review, with the operator's comments on its lines.
 *
 * The diff library draws the rows; comments ride its own annotation rows
 * (lineAnnotations, renderAnnotation) and the add button its gutter utility,
 * so nothing here overlays the diff. A comment is on one line, or on the
 * range of lines selected on one side. It joins the repository's pending
 * review; nothing is sent from here.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { PatchDiff } from "@pierre/diffs/react";
import type { DiffLineAnnotation } from "@pierre/diffs";
import {
  applyMention,
  filterMentionCandidates,
  mentionedIn,
  mentionQueryAt,
  quoteDiffLines,
  reviewCandidateLabel,
  reviewCommentAnchor,
  type ReviewCandidate,
  type ReviewComment,
  type ReviewSide,
} from "@shared/git-review";
import { noteReviewComposer, removeReviewComment, saveReviewComment, usePendingReview } from "../../lib/git-review";
import { claimFocusOnMount } from "../../lib/focus-ownership";
import { keyAria, keyIs } from "../../lib/key-match";
import { modKeyGlyph } from "../../lib/platform";
import { AgentPortrait } from "../AgentPortrait";
import { Button, IconButton, StatusDot, Textarea } from "../ui";

type Draft = {
  /** Set when an existing comment is being edited. */
  readonly id?: string;
  readonly side: ReviewSide;
  readonly line: number;
  readonly endLine: number;
  readonly text: string;
  /** Agents picked from the mention list while writing; one counts only while its @Name is still in the text. */
  readonly picked: ReadonlyArray<{ readonly nodeId: string; readonly name: string }>;
};

type Row = { readonly kind: "comment"; readonly comment: ReviewComment } | { readonly kind: "composer" };

const newId = (): string => `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

function Composer({
  anchor,
  draft,
  candidates,
  offline,
  onChange,
  onCancel,
  onSave,
}: {
  readonly anchor: string;
  readonly draft: Draft;
  /** Who can be mentioned: the agents in the review's region. */
  readonly candidates: ReadonlyArray<ReviewCandidate>;
  readonly offline: ReadonlySet<string>;
  readonly onChange: (next: Pick<Draft, "text" | "picked">) => void;
  readonly onCancel: () => void;
  readonly onSave: () => void;
}) {
  const canSave = draft.text.trim().length > 0;
  const field = useRef<HTMLTextAreaElement | null>(null);
  const [caret, setCaret] = useState(draft.text.length);
  const [active, setActive] = useState(0);
  // Escape closes the list for the @word it was open on; typing on reopens it.
  const [closedFor, setClosedFor] = useState<string | null>(null);
  const typing = mentionQueryAt(draft.text, caret);
  const offered = typing && closedFor !== `${typing.start}:${typing.query}` ? filterMentionCandidates(candidates, typing.query) : [];
  const listOpen = typing !== undefined && offered.length > 0;
  const at = Math.min(active, Math.max(0, offered.length - 1));

  const pick = (candidate: ReviewCandidate): void => {
    if (!typing) return;
    const next = applyMention(draft.text, typing, candidate.name);
    onChange({
      text: next.text,
      picked: [...draft.picked.filter((entry) => entry.nodeId !== candidate.nodeId), { nodeId: candidate.nodeId, name: candidate.name }],
    });
    setCaret(next.caret);
    setActive(0);
    requestAnimationFrame(() => field.current?.setSelectionRange(next.caret, next.caret));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (listOpen) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setActive((at + (event.key === "ArrowDown" ? 1 : offered.length - 1)) % offered.length);
        return;
      }
      if ((event.key === "Enter" && !event.metaKey && !event.ctrlKey) || event.key === "Tab") {
        event.preventDefault();
        pick(offered[at]!);
        return;
      }
      if (event.key === "Escape") {
        // Closes the list only: the draft and the surface stay.
        event.preventDefault();
        event.stopPropagation();
        setClosedFor(`${typing.start}:${typing.query}`);
        return;
      }
    }
    if (event.key === "Escape") {
      // The field takes Escape first: it cancels the draft, and the surface stays open.
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    } else if (keyIs(event, "message.send") && canSave) {
      event.preventDefault();
      onSave();
    }
  };
  const mentioned = mentionedIn(draft.text, draft.picked);
  return (
    <div className="git-review__row" data-testid="git-review-composer">
      <div className="git-review__anchor">{anchor}</div>
      <Textarea
        ref={(element) => {
          field.current = element;
          claimFocusOnMount(element);
        }}
        dense
        value={draft.text}
        aria-label={`Comment on ${anchor}`}
        placeholder="Comment on this line, @ to send it to another agent"
        aria-keyshortcuts={keyAria("message.send")}
        aria-expanded={listOpen}
        aria-controls={listOpen ? "git-review-mentions" : undefined}
        onChange={(event) => {
          setCaret(event.target.selectionStart ?? event.target.value.length);
          onChange({ text: event.target.value, picked: draft.picked });
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
        onKeyDown={onKeyDown}
      />
      {listOpen ? (
        <ul id="git-review-mentions" className="git-review__mentions" role="listbox" aria-label="Agents to mention">
          {offered.map((candidate, index) => (
            <li
              key={candidate.nodeId}
              role="option"
              aria-selected={index === at}
              data-active={index === at ? "true" : "false"}
              className="git-review__mention"
              // Press, not click: the field must keep its focus and its caret.
              onPointerDown={(event) => {
                event.preventDefault();
                pick(candidate);
              }}
            >
              <AgentPortrait identity={candidate.nodeId} size={18} frame="round" outline={false} badge={false} />
              {reviewCandidateLabel(candidate, candidates)}
              {offline.has(candidate.nodeId) ? <span className="git-review__to">offline, mail wakes it</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
      <div className="git-review__actions">
        {mentioned.length > 0 ? (
          <span className="git-review__to">
            Goes to {draft.picked.filter((entry) => mentioned.includes(entry.nodeId)).map((entry) => entry.name).join(", ")}
          </span>
        ) : null}
        <Button size="sm" variant="chrome" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" variant="primary" disabled={!canSave} title={`${modKeyGlyph()}+↵`} onClick={onSave}>
          {draft.id ? "Save comment" : "Add comment"}
        </Button>
      </div>
    </div>
  );
}

export function ReviewDiff({
  root,
  section,
  path,
  themeType,
  candidates,
  offline,
}: {
  /** The repository's top level: the pending review it belongs to. */
  readonly root: string;
  /** This file's section of the patch. */
  readonly section: string;
  readonly path: string;
  readonly themeType: "light" | "dark";
  /** Who a comment can mention. */
  readonly candidates: ReadonlyArray<ReviewCandidate>;
  /** Candidates whose session is not running; they are still mailable. */
  readonly offline: ReadonlySet<string>;
}) {
  const review = usePendingReview(root);
  const comments = useMemo(() => review.comments.filter((comment) => comment.file === path), [review.comments, path]);
  const [draft, setDraft] = useState<Draft | null>(null);
  // While a composer is open here, the surface's send button steps back.
  const composing = draft !== null;
  useEffect(() => {
    if (!composing) return undefined;
    noteReviewComposer(root, 1);
    return () => noteReviewComposer(root, -1);
  }, [composing, root]);
  // The lines selected on one side, if any: a comment added inside them covers them all.
  const [selected, setSelected] = useState<{ readonly side: ReviewSide; readonly start: number; readonly end: number } | null>(null);

  const annotations = useMemo<DiffLineAnnotation<Row>[]>(() => {
    const rows: DiffLineAnnotation<Row>[] = comments
      .filter((comment) => comment.id !== draft?.id)
      .map((comment) => ({
        side: comment.side,
        lineNumber: Math.max(comment.line, comment.endLine),
        metadata: { kind: "comment", comment },
      }));
    if (draft) rows.push({ side: draft.side, lineNumber: Math.max(draft.line, draft.endLine), metadata: { kind: "composer" } });
    return rows;
  }, [comments, draft]);

  const begin = (side: ReviewSide, line: number): void => {
    const inSelection = selected !== null && selected.side === side && line >= selected.start && line <= selected.end;
    setDraft({ side, line: inSelection ? selected.start : line, endLine: inSelection ? selected.end : line, text: "", picked: [] });
  };

  const save = (): void => {
    if (!draft || draft.text.trim().length === 0) return;
    saveReviewComment(root, {
      id: draft.id ?? newId(),
      file: path,
      side: draft.side,
      line: draft.line,
      endLine: draft.endLine,
      quote: quoteDiffLines(section, draft.side, draft.line, draft.endLine),
      text: draft.text.trim(),
      to: mentionedIn(draft.text, draft.picked),
    });
    setDraft(null);
  };

  return (
    <PatchDiff<Row>
      patch={section}
      disableWorkerPool
      options={{
        theme: { dark: "pierre-dark", light: "pierre-light" },
        themeType,
        overflow: "scroll",
        enableGutterUtility: true,
        enableLineSelection: true,
        onLineSelected: (range) => {
          if (range === null || (range.endSide !== undefined && range.endSide !== range.side)) {
            setSelected(null);
            return;
          }
          setSelected({
            side: range.side ?? "additions",
            start: Math.min(range.start, range.end),
            end: Math.max(range.start, range.end),
          });
        },
      }}
      lineAnnotations={annotations}
      renderGutterUtility={(getHoveredLine) => (
        <IconButton
          size="xs"
          aria-label="Add comment"
          title="Add comment"
          onClick={() => {
            const hovered = getHoveredLine();
            if (hovered) begin(hovered.side, hovered.lineNumber);
          }}
        >
          <Plus size={12} />
        </IconButton>
      )}
      renderAnnotation={(annotation) => {
        const row = annotation.metadata;
        if (row.kind === "composer") {
          if (!draft) return null;
          return (
            <Composer
              anchor={reviewCommentAnchor({ file: path, line: draft.line, endLine: draft.endLine })}
              draft={draft}
              candidates={candidates}
              offline={offline}
              onChange={(next) => setDraft({ ...draft, ...next })}
              onCancel={() => setDraft(null)}
              onSave={save}
            />
          );
        }
        const { comment } = row;
        const anchor = reviewCommentAnchor(comment);
        return (
          <div className="git-review__row" data-testid="git-review-comment" data-comment-id={comment.id}>
            <div className="git-review__anchor">
              <StatusDot tone="cyan" />
              {anchor}
              {comment.to.length > 0 ? (
                <span className="git-review__to">
                  to {candidates.filter((candidate) => comment.to.includes(candidate.nodeId)).map((candidate) => candidate.name).join(", ") || "a mentioned agent"}
                </span>
              ) : null}
              <span className="git-review__tools">
                <IconButton
                  size="xs"
                  aria-label={`Edit comment on ${anchor}`}
                  title="Edit"
                  onClick={() =>
                    setDraft({
                      id: comment.id,
                      side: comment.side,
                      line: comment.line,
                      endLine: comment.endLine,
                      text: comment.text,
                      // The agents it already goes to, by the names they have now.
                      picked: candidates.filter((candidate) => comment.to.includes(candidate.nodeId)).map(({ nodeId, name }) => ({ nodeId, name })),
                    })
                  }
                >
                  <Pencil size={12} />
                </IconButton>
                <IconButton
                  size="xs"
                  aria-label={`Remove comment on ${anchor}`}
                  title="Remove"
                  onClick={() => removeReviewComment(root, comment.id)}
                >
                  <Trash2 size={12} />
                </IconButton>
              </span>
            </div>
            <p className="git-review__text">{comment.text}</p>
          </div>
        );
      }}
    />
  );
}
