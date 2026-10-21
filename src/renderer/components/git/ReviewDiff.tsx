/**
 * One file's diff in a review, with the operator's comments on its lines.
 *
 * The diff library draws the rows; comments ride its own annotation rows
 * (lineAnnotations, renderAnnotation) and the plus is its own gutter button,
 * so nothing here overlays the diff. A comment is on one line, or on a range
 * of lines on one side: press the plus and drag, or mark the lines first. It joins the repository's pending
 * review; nothing is sent from here.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { use$ } from "@legendapp/state/react";
import {
  commentableLines,
  quoteDiffLines,
  reviewCommentAnchor,
  type ReviewCandidate,
  type ReviewComment,
  type ReviewSide,
} from "@shared/git-review";
import { mentionLinksOf } from "@shared/mention";
import type { NodeId } from "@shared/physics/schema";
import {
  keepReviewDraft,
  noteReviewComposer,
  removeReviewComment,
  saveReviewComment,
  takeReviewDraft,
  usePendingReview,
} from "../../lib/git-review";
import { claimFocus } from "../../lib/focus-ownership";
import { keyAria, keyIs } from "../../lib/key-match";
import { modKeyGlyph } from "../../lib/platform";
import type { MentionCandidate } from "../../lib/mention-draft";
import { withRegionDetail } from "../../lib/mention-sources";
import { state$ } from "../../lib/state";
import { Button, DiffView, IconButton, ResourceChip, StatusDot, type DiffLineAnnotation } from "../ui";
import { MentionCombobox } from "../ui/MentionCombobox";

type Draft = {
  /** Set when an existing comment is being edited. */
  readonly id?: string;
  readonly side: ReviewSide;
  readonly line: number;
  readonly endLine: number;
  /** The comment as written: each mentioned agent a link in it. */
  readonly text: string;
};

type Row = { readonly kind: "comment"; readonly comment: ReviewComment } | { readonly kind: "composer" };

/**
 * Who a comment goes to: the candidates its text mentions, once each. The
 * text is the only record; deleting a mention takes its agent off.
 */
const mentionedAgents = (text: string, candidates: ReadonlyArray<ReviewCandidate>): ReadonlyArray<string> => {
  const known = new Set(candidates.map((candidate) => candidate.nodeId));
  return [...new Set(mentionLinksOf(text).map((link) => link.target.nodeId as string))].filter((id) => known.has(id));
};

/** A comment's text as read: each mention link as its label. */
const shownComment = (text: string): string => {
  let out = "";
  let at = 0;
  for (const link of mentionLinksOf(text)) {
    out += text.slice(at, link.start) + link.label;
    at = link.end;
  }
  return out + text.slice(at);
};

const newId = (): string => `c_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

function Composer({
  anchor,
  draft,
  candidates,
  offline,
  lines,
  onLine,
  onChange,
  onCancel,
  onSave,
}: {
  readonly anchor: string;
  readonly draft: Draft;
  /** Who can be mentioned: the agents in the review's region. */
  readonly candidates: ReadonlyArray<ReviewCandidate>;
  readonly offline: ReadonlySet<string>;
  /** The lines this comment can sit on, on its side: set when it was started without pointing at a line. */
  readonly lines?: ReadonlyArray<number> | undefined;
  readonly onLine?: ((line: number) => void) | undefined;
  readonly onChange: (next: Pick<Draft, "text">) => void;
  readonly onCancel: () => void;
  readonly onSave: () => void;
}) {
  const canSave = draft.text.trim().length > 0;
  const canvasName = use$(state$.canvasName);
  const field = useRef<HTMLTextAreaElement | null>(null);
  // The press on the plus (or on Edit) asked for this field: it takes the
  // keyboard once, as the answer to that gesture, even from the note field.
  useEffect(() => {
    claimFocus(field.current, "gesture", { preventScroll: true });
  }, []);
  const offered = useMemo<ReadonlyArray<MentionCandidate>>(() => {
    const regionPath = new Map(candidates.map((candidate) => [candidate.nodeId, candidate.regionPath]));
    return withRegionDetail(
      candidates.map((candidate) => ({
        ref: { kind: "seat", nodeId: candidate.nodeId as NodeId },
        label: `@${candidate.name}`,
        ...(offline.has(candidate.nodeId) ? { note: "not running, mail wakes it" } : {}),
      })),
      (nodeId) => regionPath.get(nodeId) ?? [],
    );
  }, [candidates, offline]);

  // The list has taken its own keys; what reaches here is the composer's.
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
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
  const goesTo = mentionedAgents(draft.text, candidates);
  return (
    <div className="git-review__row" data-testid="git-review-composer">
      <div className="git-review__anchor">
        {anchor}
        {lines && lines.length > 1 && onLine ? (
          <label className="git-review__line">
            line
            <select
              className="git-review__line-pick"
              value={draft.line}
              aria-label="Line this comment is on"
              onChange={(event) => onLine(Number(event.target.value))}
            >
              {lines.map((line) => (
                <option key={line} value={line}>
                  {line}
                </option>
              ))}
            </select>
          </label>
        ) : null}
      </div>
      <MentionCombobox
        fieldRef={field}
        dense
        value={draft.text}
        onValueChange={(text) => onChange({ text })}
        canvasName={canvasName}
        candidates={offered}
        listLabel={() => "Agents to mention"}
        noun={{ one: "agent", other: "agents" }}
        aria-label={`Comment on ${anchor}`}
        placeholder={`Comment on ${draft.line === draft.endLine ? "this line" : "these lines"}, @ to send it to another agent`}
        aria-keyshortcuts={keyAria("message.send")}
        onKeyDown={onKeyDown}
      />
      <div className="git-review__actions">
        {goesTo.length > 0 ? (
          <span className="git-review__to">
            Goes to{" "}
            {candidates
              .filter((candidate) => goesTo.includes(candidate.nodeId))
              .map((candidate) => <ResourceChip key={candidate.nodeId} kind="seat" seat={candidate.nodeId} label={candidate.name} />)}
          </span>
        ) : null}
        <Button size="md" variant="chrome" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="md" variant="primary" disabled={!canSave} title={`${modKeyGlyph()}+↵`} onClick={onSave}>
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
  candidates,
  offline,
}: {
  /** The repository's top level: the pending review it belongs to. */
  readonly root: string;
  /** This file's section of the patch. */
  readonly section: string;
  readonly path: string;
  /** Who a comment can mention. */
  readonly candidates: ReadonlyArray<ReviewCandidate>;
  /** Candidates whose session is not running; they are still mailable. */
  readonly offline: ReadonlySet<string>;
}) {
  const review = usePendingReview(root);
  const comments = useMemo(() => review.comments.filter((comment) => comment.file === path), [review.comments, path]);
  const [draft, setDraft] = useState<Draft | null>(null);
  // What opened the composer (the Edit button, the file's Comment button): the
  // keyboard goes back there when it closes, never to the page.
  const opener = useRef<HTMLElement | null>(null);
  const fileButton = useRef<HTMLButtonElement | null>(null);
  // Set when the composer was started without pointing at a line: it can be moved.
  const [movable, setMovable] = useState(false);
  const lines = useMemo(() => commentableLines(section), [section]);
  const close = (): void => {
    setDraft(null);
    setMovable(false);
    const back = opener.current?.isConnected ? opener.current : fileButton.current;
    opener.current = null;
    // After the composer has left the page.
    requestAnimationFrame(() => claimFocus(back, "gesture", { preventScroll: true }));
  };
  const cancel = (): void => {
    // Escape and Cancel never cost the words: they are kept for this line.
    if (draft && !draft.id) keepReviewDraft(root, path, draft.side, draft.line, draft.text);
    close();
  };
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

  /**
   * Open a comment on lines `first` to `last` of one side. A single line
   * inside a marked range means that range: a person who marked lines and
   * pressed the plus on one of them gets them all.
   */
  const beginOn = (side: ReviewSide, first: number, last: number, fromKeyboard = false): void => {
    const marked = first === last && selected !== null && selected.side === side && first >= selected.start && first <= selected.end;
    const start = marked ? selected.start : first;
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setMovable(fromKeyboard);
    setDraft({ side, line: start, endLine: marked ? selected.end : last, text: takeReviewDraft(root, path, side, start) });
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
      to: mentionedAgents(draft.text, candidates),
    });
    close();
  };

  return (
    <>
    {lines.first ? (
      <div className="git-review__file-tools">
        <Button
          ref={fileButton}
          size="xs"
          variant="subtle"
          data-testid="git-review-comment-on-file"
          // The plus in the gutter needs a pointer; this starts a comment from the keyboard.
          onClick={() => beginOn(lines.first!.side, lines.first!.line, lines.first!.line, true)}
        >
          Comment on {path.split("/").pop()}
        </Button>
      </div>
    ) : null}
    <DiffView<Row>
      patch={section}
      onLineSelected={(range) => {
        if (range === null || (range.endSide !== undefined && range.endSide !== range.side)) {
          setSelected(null);
          return;
        }
        setSelected({
          side: range.side ?? "additions",
          start: Math.min(range.start, range.end),
          end: Math.max(range.start, range.end),
        });
      }}
      lineAnnotations={annotations}
      onGutterPress={(range) => {
        // One side only: a press that ends on the other side is on the line it ended on.
        const side = range.endSide ?? range.side ?? "additions";
        const oneSide = range.side === undefined || range.endSide === undefined || range.side === range.endSide;
        beginOn(side, oneSide ? Math.min(range.start, range.end) : range.end, Math.max(range.start, range.end));
      }}
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
              lines={movable ? lines[draft.side] : undefined}
              onLine={(line) => setDraft({ ...draft, line, endLine: line })}
              onChange={(next) => setDraft({ ...draft, ...next })}
              onCancel={cancel}
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
                  onClick={(event) => {
                    opener.current = event.currentTarget;
                    setMovable(false);
                    setDraft({
                      id: comment.id,
                      side: comment.side,
                      line: comment.line,
                      endLine: comment.endLine,
                      text: comment.text,
                    });
                  }}
                >
                  <Pencil size={12} />
                </IconButton>
                <IconButton
                  size="xs"
                  aria-label={`Remove comment on ${anchor}`}
                  title="Remove"
                  onClick={() => {
                    // One press removes it, but its words are kept for this line: the plus brings them back.
                    keepReviewDraft(root, path, comment.side, Math.min(comment.line, comment.endLine), comment.text);
                    removeReviewComment(root, comment.id);
                    claimFocus(fileButton.current, "gesture", { preventScroll: true });
                  }}
                >
                  <Trash2 size={12} />
                </IconButton>
              </span>
            </div>
            <p className="git-review__text">{shownComment(comment.text)}</p>
          </div>
        );
      }}
    />
    </>
  );
}
