/**
 * The full git review of one commit, in the operator layer: opened from a
 * commit on a needs-you card, in place of the feed. Closing it, by any
 * route, returns to that card; the slot remembers the way (operator-modal).
 *
 * The body is the same review the seat header opens. Only the frame differs.
 */
import { useEffect } from "react";
import { use$ } from "@legendapp/state/react";
import { clearCommitReview, seatGitFolder, useCommitReview } from "../../lib/git-summary";
import { nodeTitle } from "../../lib/presentation";
import { state$ } from "../../lib/state";
import { OperatorModalShell } from "../operator-modal/OperatorModalShell";
import { GitReviewBody } from "./GitDetail";

export function CommitReviewModal() {
  const asked = useCommitReview();
  const doc = use$(state$.doc);
  useEffect(() => clearCommitReview, []);
  const node = asked ? doc.nodes.find((candidate) => candidate.id === asked.nodeId) : undefined;
  const folder = node ? seatGitFolder(doc, node) : undefined;
  return (
    <OperatorModalShell
      id="git"
      label="Commit review"
      title={node ? `Review of ${nodeTitle(node)}'s commit` : "Commit review"}
      status={folder}
      fill
      // As wide as the review the seat header opens: a diff needs two columns.
      width={1320}
    >
      <div className="flex min-h-0 flex-1 flex-col" data-testid="git-detail">
        {asked && node && folder ? (
          <GitReviewBody
            cwd={folder}
            initialCommit={asked.sha}
            recipientNodeId={asked.nodeId}
            anchorNodeId={asked.nodeId}
          />
        ) : (
          <p className="git-browser__empty" role="status">
            The agent that sent this commit is no longer on this canvas.
          </p>
        )}
      </div>
    </OperatorModalShell>
  );
}
