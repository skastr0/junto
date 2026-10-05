/**
 * One file's diff in a review, with the operator's comments on its lines.
 *
 * The diff library draws the rows; comments ride its own annotation rows
 * (lineAnnotations, renderAnnotation) and the add button its gutter utility,
 * so nothing here overlays the diff. A comment is on one line, or on the
 * range of lines selected on one side. It joins the repository's pending
 * review; nothing is sent from here.
 */
import { useMemo, useState, type KeyboardEvent } from "react";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { PatchDiff } from "@pierre/diffs/react";
import type { DiffLineAnnotation } from "@pierre/diffs";
import { quoteDiffLines, reviewCommentAnchor, type ReviewComment, type ReviewSide } from "@shared/git-review";
import { removeReviewComment, saveReviewComment, usePendingReview } from "../../lib/git-review";
import { claimFocusOnMount } from "../../lib/focus-ownership";
import { modKeyGlyph } from "../../lib/platform";
import { Button, IconButton, StatusDot, Textarea } from "../ui";

type Draft = {
  /** Set when an existing comment is being edited. */
  readonly id?: string;
  readonly side: ReviewSide;
  readonly line: number;
  readonly endLine: number;
  readonly text: string;
};

type Row = { readonly kind: "comment"; readonly comment: ReviewComment } | { readonly kind: "composer" };

const newId = (): string => `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

function Composer({
  anchor,
  draft,
  onChange,
  onCancel,
  onSave,
}: {
  readonly anchor: string;
  readonly draft: Draft;
  readonly onChange: (text: string) => void;
  readonly onCancel: () => void;
  readonly onSave: () => void;
}) {
  const canSave = draft.text.trim().length > 0;
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Escape") {
      // The field takes Escape first: it cancels the draft, and the surface stays open.
      event.preventDefault();
      event.stopPropagation();
      onCancel();
    } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && canSave) {
      event.preventDefault();
      onSave();
    }
  };
  return (
    <div className="git-review__row" data-testid="git-review-composer">
      <div className="git-review__anchor">{anchor}</div>
      <Textarea
        ref={claimFocusOnMount}
        dense
        value={draft.text}
        aria-label={`Comment on ${anchor}`}
        placeholder="Comment on this line"
        aria-keyshortcuts="Meta+Enter Control+Enter"
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <div className="git-review__actions">
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
}: {
  /** The repository's top level: the pending review it belongs to. */
  readonly root: string;
  /** This file's section of the patch. */
  readonly section: string;
  readonly path: string;
  readonly themeType: "light" | "dark";
}) {
  const review = usePendingReview(root);
  const comments = useMemo(() => review.comments.filter((comment) => comment.file === path), [review.comments, path]);
  const [draft, setDraft] = useState<Draft | null>(null);
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
    setDraft({ side, line: inSelection ? selected.start : line, endLine: inSelection ? selected.end : line, text: "" });
  };

  const save = (): void => {
    if (!draft || draft.text.trim().length === 0) return;
    const existing = draft.id ? comments.find((comment) => comment.id === draft.id) : undefined;
    saveReviewComment(root, {
      id: draft.id ?? newId(),
      file: path,
      side: draft.side,
      line: draft.line,
      endLine: draft.endLine,
      quote: quoteDiffLines(section, draft.side, draft.line, draft.endLine),
      text: draft.text.trim(),
      to: existing?.to ?? [],
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
              onChange={(text) => setDraft({ ...draft, text })}
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
              <span className="git-review__tools">
                <IconButton
                  size="xs"
                  aria-label={`Edit comment on ${anchor}`}
                  title="Edit"
                  onClick={() => setDraft({ id: comment.id, side: comment.side, line: comment.line, endLine: comment.endLine, text: comment.text })}
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
