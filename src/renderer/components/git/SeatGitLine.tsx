/**
 * Git at a glance for the folder a seat runs in, as one line: the branch,
 * uncommitted work, how the branch stands against the base branch, and the
 * latest commit. Pressing it opens the repository's git detail.
 *
 * Self-contained: it finds the seat's folder, watches it only while mounted,
 * and renders nothing at all when there is no folder, no repository, no git,
 * or the seat runs on another host. A number that is not known is not shown.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { GitBranch } from "lucide-react";
import type { CanvasNode } from "@shared/canvas";
import { gitSummaryParts } from "@shared/git";
import { claimFocus } from "../../lib/focus-ownership";
import { seatGitFolder, useGitSummary } from "../../lib/git-summary";
import { state$ } from "../../lib/state";
import { GitRepositoryDetail } from "./GitDetail";
import "./git.css";

const repositoryName = (root: string): string => root.split(/[\\/]/).filter(Boolean).pop() ?? root;

export function SeatGitLine({ node }: { readonly node: CanvasNode }) {
  const doc = use$(state$.doc);
  const folder = useMemo(() => seatGitFolder(doc, node), [doc, node]);
  const summary = useGitSummary(folder);
  const [open, setOpen] = useState(false);
  // Where the keyboard was when the press began (the terminal, usually): a
  // press moves focus to this button, and the detail hands focus back to the
  // button when it closes. Once it has closed, the keyboard goes back to
  // where it really was, so the next keys reach the agent.
  const cameFrom = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  useEffect(() => {
    if (wasOpen.current && !open) {
      const back = cameFrom.current;
      cameFrom.current = null;
      if (back?.isConnected) claimFocus(back, "open");
    }
    wasOpen.current = open;
  }, [open]);
  if (!summary) return null;
  const parts = gitSummaryParts(summary, Date.now());
  const name = repositoryName(summary.root);
  return (
    <>
      <button
        type="button"
        className="seat-git-line"
        data-testid="seat-git-line"
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Git, ${name}: ${parts.map((part) => part.label).join(", ")}. Open git detail.`}
        title={`${name}: open git detail`}
        onPointerDown={(event) => {
          const active = document.activeElement;
          if (!open) {
            cameFrom.current =
              active instanceof HTMLElement && active !== document.body && active !== event.currentTarget ? active : null;
          }
        }}
        onClick={() => setOpen(true)}
      >
        <GitBranch className="seat-git-line__mark" size={12} strokeWidth={1.75} aria-hidden />
        {parts.map((part) => (
          <span key={part.kind} className={`seat-git-line__part seat-git-line__part--${part.kind}`} title={part.label}>
            {part.text}
          </span>
        ))}
      </button>
      {open ? <GitRepositoryDetail cwd={summary.root} title={`${name}, ${summary.branch}`} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
