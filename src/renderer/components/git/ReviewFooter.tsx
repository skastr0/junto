/**
 * The one place a review is sent from: what is pending, an overall note, who
 * receives it, and the send. The review is one thread in the recipient's
 * mailbox, on the operator's thread path (sendSeatThread): a root, then a
 * row per line comment anchored on its lines, which main also hands to each
 * seat the comment mentions. Nothing here writes into a terminal.
 */
import { useState } from "react";
import {
  reviewCandidateLabel,
  reviewCountLine,
  reviewIsEmpty,
  reviewThread,
  type ReviewCandidate,
} from "@shared/git-review";
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
import { sendSeatThread } from "../../lib/seat-threads";
import { Button, Dropdown, Textarea } from "../ui";

const clock = (at: number): string => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

export function ReviewFooter({
  canvasName,
  anchorNodeId,
  root,
  repository,
  reviewed,
  to,
  onTo,
  candidates,
  offline,
  nameOf,
}: {
  readonly canvasName: string;
  /** The node the review was opened from: main checks every recipient against the same reach. */
  readonly anchorNodeId: string | undefined;
  readonly root: string;
  /** The repository's name, as the mail says it. */
  readonly repository: string;
  /** What is on screen, as the one line the mail says was reviewed. Absent while it loads. */
  readonly reviewed: string | undefined;
  /** The review's own recipient, by node id: the session it was opened from, or the one chosen. */
  readonly to: string | undefined;
  readonly onTo: (nodeId: string) => void;
  /** Who it can go to: the agents in the review's region. */
  readonly candidates: ReadonlyArray<ReviewCandidate>;
  /** Candidates whose session is not running; they are still mailable. */
  readonly offline: ReadonlySet<string>;
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
    const thread = reviewThread({ review, defaultTo: to, reviewed, repository });
    if (thread === undefined) {
      setProblem("Choose who receives it, or mention an agent in a comment.");
      return;
    }
    setBusy(true);
    setProblem(null);
    const seat = { canvasName, seatId: thread.to };
    const context = anchorNodeId === undefined ? {} : { anchorNodeId };
    const started = await sendSeatThread({ ...seat, text: thread.root, review: context });
    if (!started.ok) {
      // Nothing went: the whole review stays pending.
      setBusy(false);
      setProblem(started.message);
      return;
    }
    // One row after another, in the review's order: never a burst into one terminal.
    let sent = 0;
    let failure: string | undefined;
    for (const row of thread.rows) {
      const outcome = await sendSeatThread({ ...seat, text: row.text, threadId: started.threadId, review: { ...context, anchor: row.anchor } });
      if (!outcome.ok) {
        failure = outcome.message;
        break;
      }
      sent += 1;
    }
    setBusy(false);
    const copied = [...new Set(thread.rows.slice(0, sent).flatMap((row) => row.comment.to))].filter((id) => id !== thread.to);
    recordSentReview(root, { at: Date.now(), to: nameOf(thread.to), copied: copied.map(nameOf) });
    if (failure !== undefined) {
      // What did not go stays pending, so a retry sends only the rest.
      keepUnsentComments(root, thread.rows.slice(sent).map((row) => row.comment));
      setProblem(failure);
      return;
    }
    clearPendingReview(root);
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
      ? `Sent as one thread to ${sent.to} at ${clock(sent.at)}${sent.copied.length > 0 ? `, copied to ${sent.copied.join(", ")}` : ""}`
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
        <span className="git-review__status" role={problem ? "alert" : "status"} data-problem={problem ? "true" : undefined}>
          {status}
        </span>
        <span className="git-review__to">to</span>
        <Dropdown
          value={to ?? ""}
          aria-label="Who receives the review"
          placeholder="choose an agent"
          emptyLabel="no agents in this region"
          options={candidates.map((candidate) => ({
            value: candidate.nodeId,
            label: `${reviewCandidateLabel(candidate, candidates)}${offline.has(candidate.nodeId) ? ", not running, mail wakes it" : ""}`,
          }))}
          onChange={onTo}
        />
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
          {busy ? "Sending" : to ? `Send to ${nameOf(to)}` : "Send review"}
        </Button>
      </div>
    </footer>
  );
}
