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
import { isOperatorModalOpen } from "../../lib/operator-modal";
import { titleOf } from "@shared/model/title";
import { modelStore } from "../../lib/use-model";
import { state$ } from "../../lib/state";
import { OperatorModalShell } from "../operator-modal/OperatorModalShell";
import { GitReviewBody } from "./GitDetail";

export function CommitReviewModal() {
  const asked = useCommitReview();
  const name = use$(state$.canvasName);
  const doc = use$(() => { modelStore.canvas$(name).seq.get(); return modelStore.canvasOf(name); });
  // Cleared only when the slot has really left: a dev build mounts, cleans up and mounts again.
  useEffect(
    () => () => {
      if (!isOperatorModalOpen("git")) clearCommitReview();
    },
    [],
  );
  const node = asked ? doc?.nodes.get(asked.nodeId as never) : undefined;
  const folder = node ? seatGitFolder(doc, node) : undefined;
  return (
    <OperatorModalShell
      id="git"
      label="Commit review"
      title={node ? `Review of ${titleOf(node)}'s commit` : "Commit review"}
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
