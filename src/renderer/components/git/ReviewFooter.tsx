/**
 * The one place a review is sent from: what is pending, an overall note, who
 * receives it, and the send. Each recipient gets one mail with every comment
 * addressed to it, as operator mail on the same path a message to a seat
 * takes (sendSeatMessage); nothing here writes into a terminal.
 */
import { useState } from "react";
import { gitReviewedState, type GitReviewView } from "@shared/git";
import { reviewCountLine, reviewIsEmpty, reviewMails } from "@shared/git-review";
import { askConfirm } from "../../lib/confirm";
import {
  clearPendingReview,
  keepUnsentComments,
  recordSentReview,
  usePendingReview,
  useReviewComposing,
  useSentReview,
  setReviewNote,
} from "../../lib/git-review";
import { planSeatMessageFor, sendSeatMessage } from "../../lib/seat-message";
import { Button, Textarea } from "../ui";

export type ReviewRecipient = { readonly nodeId: string; readonly name: string };

const clock = (at: number): string => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

export function ReviewFooter({
  root,
  repository,
  reviewed,
  recipient,
  nameOf,
}: {
  readonly root: string;
  /** The repository's name, as the mail says it. */
  readonly repository: string;
  /** What is on screen, so the mail can say what was reviewed. Absent while it loads. */
  readonly reviewed: { readonly view: GitReviewView; readonly branch: string; readonly head?: string; readonly base?: string } | undefined;
  /** The review's own recipient: the session it was opened from. */
  readonly recipient: ReviewRecipient | undefined;
  readonly nameOf: (nodeId: string) => string;
}) {
  const review = usePendingReview(root);
  const sent = useSentReview(root);
  const composing = useReviewComposing(root);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const empty = reviewIsEmpty(review);
  const canSend = !empty && !busy && reviewed !== undefined;

  const send = async (): Promise<void> => {
    if (!canSend || reviewed === undefined) return;
    const { mails, unaddressed } = reviewMails({
      review,
      defaultTo: recipient?.nodeId,
      reviewed: gitReviewedState(reviewed),
      repository,
      nameOf,
    });
    if (mails.length === 0) {
      setProblem("Nobody to send it to: mention an agent in a comment, or open the review from an agent.");
      return;
    }
    setBusy(true);
    setProblem(null);
    const failed: string[] = [];
    const delivered: { name: string; comments: number }[] = [];
    // One mail per recipient, one after another: never a burst into one terminal.
    for (const mail of mails) {
      const outcome = await sendSeatMessage(planSeatMessageFor([mail.to]), mail.text);
      if (outcome.tone === "failed") failed.push(outcome.line);
      else delivered.push({ name: nameOf(mail.to), comments: mail.comments });
    }
    setBusy(false);
    if (delivered.length > 0) recordSentReview(root, { at: Date.now(), mails: delivered });
    if (failed.length > 0) {
      // What did not go stays pending in full, so nothing is lost and nothing is half sent twice by a retry of the rest.
      setProblem(failed.join(" "));
      return;
    }
    if (unaddressed.length > 0) {
      keepUnsentComments(root, unaddressed);
      setProblem(
        `${unaddressed.length} ${unaddressed.length === 1 ? "comment has" : "comments have"} nobody to go to and stayed here.`,
      );
    } else {
      clearPendingReview(root);
    }
  };

  const discard = async (): Promise<void> => {
    const confirmed = await askConfirm({
      source: "git-review-discard",
      title: "Discard this review?",
      body: [`${reviewCountLine(review)} will be removed. Nothing is sent.`],
      confirmLabel: "Discard review",
      tone: "danger",
    });
    if (confirmed) {
      clearPendingReview(root);
      setProblem(null);
    }
  };

  const status = problem
    ? problem
    : empty && sent
      ? `Sent as one mail to ${sent.mails.map((mail) => mail.name).join(", ")} at ${clock(sent.at)}`
      : reviewCountLine(review);

  return (
    <footer className="git-review__footer" data-testid="git-review-footer">
      <Textarea
        dense
        value={review.note}
        aria-label="Overall note for the review"
        placeholder="Overall note, optional"
        onChange={(event) => setReviewNote(root, event.target.value)}
      />
      <div className="git-review__send">
        <span className="git-review__status" role="status" data-problem={problem ? "true" : undefined}>
          {status}
        </span>
        {!empty ? (
          <Button size="md" variant="chrome" disabled={busy} onClick={() => void discard()}>
            Discard
          </Button>
        ) : null}
        <Button
          size="md"
          // One primary on the surface: while a comment is being written, that is its Add comment.
          variant={composing ? "chrome" : "primary"}
          disabled={!canSend}
          data-testid="git-review-send"
          onClick={() => void send()}
        >
          {busy ? "Sending" : recipient ? `Send to ${recipient.name}` : "Send review"}
        </Button>
      </div>
    </footer>
  );
}
