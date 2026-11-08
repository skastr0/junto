/**
 * A review of a diff, written by the operator and sent to agents as one mail
 * thread (plan 0.10, 03 section 4).
 *
 * Comments collect as a pending review; one action sends them. The thread
 * lives in the reviewed seat's mailbox: a root that says what was reviewed
 * and carries the overall note, then one row per line comment, anchored on
 * its lines. A seat a comment mentions receives that row in the same thread
 * (main's side of the send). Each row stands alone: the file, the lines, the
 * diff lines it refers to, and the comment.
 *
 * Pure: no git, no storage, no delivery. Plain text, no middle dots.
 */
import type { LinesAnchor } from "./thread-subject";

export type ReviewSide = "additions" | "deletions";

export type ReviewComment = {
  readonly id: string;
  /** The file's path as the patch names it. */
  readonly file: string;
  /** Which side of the diff the lines are on: the new text, or the removed text. */
  readonly side: ReviewSide;
  /** First and last line on that side, inclusive. */
  readonly line: number;
  readonly endLine: number;
  /** The diff lines the comment refers to, each with its + - or space mark. */
  readonly quote: ReadonlyArray<string>;
  readonly text: string;
  /** Recipients mentioned in the comment, by id. Empty: it goes to the review's own recipient. */
  readonly to: ReadonlyArray<string>;
};

export type PendingReview = {
  readonly comments: ReadonlyArray<ReviewComment>;
  /** One overall note with no line. It goes to the review's own recipient. */
  readonly note: string;
};

export const EMPTY_REVIEW: PendingReview = { comments: [], note: "" };

export const reviewIsEmpty = (review: PendingReview): boolean =>
  review.comments.length === 0 && review.note.trim().length === 0;

/** How many diff lines a comment quotes at most; a longer range is cut with a count. */
export const REVIEW_QUOTE_MAX = 8;

/**
 * The diff lines a range covers on one side of one file's patch section,
 * each kept with its mark. Context lines inside the range are included, so
 * the agent sees the lines as the operator saw them.
 */
export const quoteDiffLines = (
  section: string,
  side: ReviewSide,
  start: number,
  end: number,
): ReadonlyArray<string> => {
  const from = Math.min(start, end);
  const to = Math.max(start, end);
  const out: string[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const raw of section.split("\n")) {
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk || raw.startsWith("\\")) continue;
    const mark = raw[0];
    if (mark === "+") {
      if (side === "additions" && newLine >= from && newLine <= to) out.push(raw);
      newLine += 1;
    } else if (mark === "-") {
      if (side === "deletions" && oldLine >= from && oldLine <= to) out.push(raw);
      oldLine += 1;
    } else if (mark === " " || raw === "") {
      const at = side === "additions" ? newLine : oldLine;
      if (at >= from && at <= to && raw !== "") out.push(raw);
      oldLine += 1;
      newLine += 1;
    }
  }
  return out;
};

/**
 * The lines of a file's patch section that can take a comment, per side, in
 * order: every line the diff shows. A comment started from the keyboard lands
 * on the first changed line and can be moved to any of these.
 */
export const commentableLines = (
  section: string,
): { readonly additions: ReadonlyArray<number>; readonly deletions: ReadonlyArray<number>; readonly first: { readonly side: ReviewSide; readonly line: number } | undefined } => {
  const additions: number[] = [];
  const deletions: number[] = [];
  let first: { side: ReviewSide; line: number } | undefined;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const raw of section.split("\n")) {
    const hunk = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk || raw.startsWith("\\")) continue;
    const mark = raw[0];
    if (mark === "+") {
      additions.push(newLine);
      first ??= { side: "additions", line: newLine };
      newLine += 1;
    } else if (mark === "-") {
      deletions.push(oldLine);
      first ??= { side: "deletions", line: oldLine };
      oldLine += 1;
    } else if (mark === " ") {
      additions.push(newLine);
      deletions.push(oldLine);
      oldLine += 1;
      newLine += 1;
    }
  }
  return { additions, deletions, first };
};

const lineRange = (comment: Pick<ReviewComment, "line" | "endLine" | "side">): string => {
  const what = comment.side === "additions" ? "" : " (removed text)";
  return comment.line === comment.endLine
    ? `line ${comment.line}${what}`
    : `lines ${Math.min(comment.line, comment.endLine)} to ${Math.max(comment.line, comment.endLine)}${what}`;
};

/** "GitDetail.tsx 214": the quiet line above a comment. */
export const reviewCommentAnchor = (comment: Pick<ReviewComment, "file" | "line" | "endLine">): string => {
  const name = comment.file.split("/").pop() ?? comment.file;
  return comment.line === comment.endLine
    ? `${name} ${comment.line}`
    : `${name} ${Math.min(comment.line, comment.endLine)} to ${Math.max(comment.line, comment.endLine)}`;
};

/** "3 comments in 2 files", "1 comment in 1 file", and the overall note when there is one. */
export const reviewCountLine = (review: PendingReview): string => {
  const count = review.comments.length;
  const files = new Set(review.comments.map((comment) => comment.file)).size;
  const hasNote = review.note.trim().length > 0;
  if (count === 0) return hasNote ? "1 overall note" : "No comments yet";
  const comments = `${count} ${count === 1 ? "comment" : "comments"} in ${files} ${files === 1 ? "file" : "files"}`;
  return hasNote ? `${comments}, and an overall note` : comments;
};

/** One line comment as its row in the thread: its words, and the lines it hangs on. */
export type ReviewThreadRow = {
  readonly comment: ReviewComment;
  readonly text: string;
  readonly anchor: LinesAnchor;
};

export type ReviewThread = {
  /** The seat whose mailbox holds the thread, by id. */
  readonly to: string;
  /** The thread's root: what was reviewed, and the overall note. */
  readonly root: string;
  readonly rows: ReadonlyArray<ReviewThreadRow>;
};

/** A comment's lines, as its row's anchor. */
export const reviewLinesAnchor = (comment: ReviewComment): LinesAnchor => ({
  kind: "lines",
  file: comment.file,
  from: Math.min(comment.line, comment.endLine),
  to: Math.max(comment.line, comment.endLine),
  ...(comment.side === "deletions" ? { side: "deletions" as const } : {}),
});

/**
 * The review as one thread. It goes to the review's own recipient, or with
 * none, to the first agent a comment mentions; with neither it has nowhere
 * to go: undefined, and nothing is sent.
 */
export const reviewThread = (input: {
  readonly review: PendingReview;
  /** The review's own recipient: the session it was opened from, or the one chosen. */
  readonly defaultTo: string | undefined;
  /** What was reviewed, as one line (gitReviewedState). */
  readonly reviewed: string;
  /** The repository's name, as the operator reads it. */
  readonly repository: string;
}): ReviewThread | undefined => {
  const { review } = input;
  const to = input.defaultTo ?? review.comments.find((comment) => comment.to.length > 0)?.to[0];
  if (to === undefined) return undefined;
  const note = review.note.trim();
  const count = review.comments.length;
  const root = [
    "Code review from the operator.",
    `Reviewed: ${input.reviewed}, repository ${input.repository}.`,
    "",
    ...(note ? [`Overall: ${note}`, ""] : []),
    count === 0
      ? "No line comments in this review."
      : `${count} ${count === 1 ? "comment follows" : "comments follow"} in this thread, one mail each. The line numbers are from the state named above; check them against your working copy.`,
  ].join("\n");
  const rows = review.comments.map((comment): ReviewThreadRow => {
    const shown = comment.quote.slice(0, REVIEW_QUOTE_MAX);
    const lines = [
      `${comment.file}, ${lineRange(comment)}`,
      ...shown.map((line) => `   ${line}`),
      ...(comment.quote.length > shown.length ? [`   (${comment.quote.length - shown.length} more lines)`] : []),
      `Comment: ${comment.text.trim()}`,
    ];
    return { comment, text: lines.join("\n"), anchor: reviewLinesAnchor(comment) };
  });
  return { to, root, rows };
};

/** An agent a review, or one of its comments, can be sent to. */
export type ReviewCandidate = {
  readonly nodeId: string;
  readonly name: string;
  /** Its regions, outer to inner; empty in the open field. */
  readonly regionPath: ReadonlyArray<string>;
};

/** How a candidate reads in a list: its name, with its region path when another candidate shares the name. */
export const reviewCandidateLabel = (candidate: ReviewCandidate, all: ReadonlyArray<ReviewCandidate>): string => {
  const shared = all.some((other) => other.nodeId !== candidate.nodeId && other.name === candidate.name);
  return shared && candidate.regionPath.length > 0 ? `${candidate.name}, ${candidate.regionPath.join(" / ")}` : candidate.name;
};
