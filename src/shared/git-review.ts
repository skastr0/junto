/**
 * A review of a diff, written by the operator and sent to agents as mail.
 *
 * Comments collect as a pending review; one action sends them. Each recipient
 * gets exactly one mail holding every comment addressed to it, never one mail
 * per comment. The mail stands alone: it says what was reviewed, and for each
 * comment the file, the lines, the diff lines it refers to, and the comment.
 *
 * Pure: no git, no storage, no delivery. Plain text, no middle dots.
 */

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

export type ReviewMail = {
  /** The recipient's id. */
  readonly to: string;
  readonly text: string;
  /** How many comments this mail carries. */
  readonly comments: number;
};

/**
 * One mail per recipient. A comment that mentions recipients goes to each of
 * them; any other comment, and the overall note, goes to the review's own
 * recipient. With no recipient of its own, unaddressed comments have nowhere
 * to go: they come back in `unaddressed` and nothing is sent for them.
 */
export const reviewMails = (input: {
  readonly review: PendingReview;
  /** The review's own recipient: the session it was opened from, or the one chosen. */
  readonly defaultTo: string | undefined;
  /** What was reviewed, as one line (gitReviewedState). */
  readonly reviewed: string;
  /** The repository's name, as the operator reads it. */
  readonly repository: string;
  /** A recipient's name, for a mention read back in the text. */
  readonly nameOf: (id: string) => string;
}): { readonly mails: ReadonlyArray<ReviewMail>; readonly unaddressed: ReadonlyArray<ReviewComment> } => {
  const { review, defaultTo } = input;
  const byRecipient = new Map<string, ReviewComment[]>();
  const unaddressed: ReviewComment[] = [];
  for (const comment of review.comments) {
    const recipients = comment.to.length > 0 ? [...new Set(comment.to)] : defaultTo ? [defaultTo] : [];
    if (recipients.length === 0) {
      unaddressed.push(comment);
      continue;
    }
    for (const id of recipients) byRecipient.set(id, [...(byRecipient.get(id) ?? []), comment]);
  }
  const note = review.note.trim();
  if (note && defaultTo && !byRecipient.has(defaultTo)) byRecipient.set(defaultTo, []);

  const mails: ReviewMail[] = [];
  for (const [to, comments] of byRecipient) {
    const lines: string[] = [
      "Code review from the operator.",
      `Reviewed: ${input.reviewed}, repository ${input.repository}.`,
      "",
    ];
    if (note && to === defaultTo) lines.push(`Overall: ${note}`, "");
    comments.forEach((comment, index) => {
      const others = comment.to.filter((id) => id !== to).map(input.nameOf);
      lines.push(`${index + 1}. ${comment.file}, ${lineRange(comment)}`);
      const shown = comment.quote.slice(0, REVIEW_QUOTE_MAX);
      for (const line of shown) lines.push(`   ${line}`);
      if (comment.quote.length > shown.length) lines.push(`   (${comment.quote.length - shown.length} more lines)`);
      lines.push(`   Comment: ${comment.text.trim()}`);
      if (others.length > 0) lines.push(`   Also sent to: ${others.join(", ")}`);
      lines.push("");
    });
    lines.push(
      comments.length === 0
        ? "No line comments in this review."
        : `${comments.length} ${comments.length === 1 ? "comment" : "comments"} in this review. The line numbers are from the state named above; check them against your working copy.`,
    );
    mails.push({ to, text: lines.join("\n"), comments: comments.length });
  }
  return { mails, unaddressed };
};
