import { Component, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { use$ } from "@legendapp/state/react";
import { X } from "lucide-react";
import type { CanvasNode } from "@shared/canvas";
import {
  gitReviewedCommit,
  gitReviewedState,
  gitReviewTitle,
  patchFilePath,
  splitPatchFiles,
  type GitCommit,
  type GitReviewResult,
  type GitReviewView,
} from "@shared/git";
import { DIM, GREEN, HUE, INK } from "../../lib/theme";
import { claimFocus } from "../../lib/focus-ownership";
import { getJuntoApi } from "../../lib/junto-api";
import { agentSeat$, seatEventForNode } from "../../lib/agent-seat-state";
import { nodeTitle } from "../../lib/presentation";
import { reviewCandidates } from "@shared/review-candidates";
import { state$ } from "../../lib/state";
import { InspectorTabs } from "../chat/InspectorTabs";
import { FocusSurface } from "../FocusSurface";
import { IconButton, OverlayHeader } from "../ui";
import { ReviewDiff } from "./ReviewDiff";
import { ReviewFooter } from "./ReviewFooter";
import "./git.css";

const shortSha = (sha: string): string => sha.slice(0, 7);

const formatWhen = (iso: string): string => {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
};

/**
 * One file's diff. The diff view throws on a file section it cannot parse
 * (a binary file, a mode-only change); that file falls back to its plain
 * patch text instead of taking the window down.
 */
class FileDiffBoundary extends Component<
  { readonly text: string; readonly children: ReactNode },
  { readonly failed: boolean }
> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return <pre className="git-browser__plain">{this.props.text}</pre>;
  }
}

/** The git detail for a canvas git node: its folder, under its own title. */
export function GitDetail({
  node,
  onClose,
}: {
  readonly node: CanvasNode;
  readonly onClose: () => void;
}) {
  const cwd = node.ether?.git?.cwd?.trim() ?? "";
  const title = node.type === "text" ? node.text.split("\n")[0] || "git" : "git";
  return <GitRepositoryDetail cwd={cwd} title={title} anchorNodeId={node.id} onClose={onClose} />;
}

/** What the detail shows: a review of work not yet in the base, or one commit at a time. */
export type GitDetailView = GitReviewView | "commits";

const VIEW_TABS: ReadonlyArray<{ readonly id: GitDetailView; readonly label: string }> = [
  { id: "working", label: "Uncommitted" },
  { id: "base", label: "Since base" },
  { id: "commits", label: "Commits" },
];

/** Up and down move through a list of options; Home and End jump to its ends. */
const moveInList = (event: KeyboardEvent<HTMLElement>): void => {
  const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
  if (step === 0 && event.key !== "Home" && event.key !== "End") return;
  const options = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="option"]'));
  if (options.length === 0) return;
  event.preventDefault();
  const at = options.findIndex((option) => option === document.activeElement || option.getAttribute("aria-selected") === "true");
  const next =
    event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : Math.min(options.length - 1, Math.max(0, at + step));
  // The operator's own arrow key moves focus within the list they are in.
  claimFocus(options[next], "gesture", { event });
  options[next]?.click();
};

/**
 * A repository's commits and their diffs, for any folder: the git node opens
 * it for its own, the agent modal's git line for the folder its seat runs in.
 * This is the working modal's frame around the review; the same review opens
 * in the operator layer from a needs-you card (CommitReviewModal).
 */
export function GitRepositoryDetail({
  cwd,
  title,
  onClose,
  ...review
}: GitReviewProps & {
  readonly title: string;
  readonly onClose: () => void;
}) {
  return (
    <FocusSurface measure="workspace" height="immersive" label="Git review" onClose={onClose}>
      <div className="flex h-full min-h-0 flex-col" data-testid="git-detail">
        <OverlayHeader
          eyebrow="git"
          title={title}
          status={cwd || "no folder"}
          actions={
            <IconButton aria-label="Close git" title="Close" onClick={onClose}>
              <X size={14} />
            </IconButton>
          }
        />
        <GitReviewBody cwd={cwd} {...review} />
      </div>
    </FocusSurface>
  );
}

export type GitReviewProps = Parameters<typeof GitReviewBody>[0];

/** The review itself, with no frame: what to show, the files or commits, the diff, and the send. */
export function GitReviewBody({
  cwd,
  initialView = "commits",
  initialCommit,
  recipientNodeId,
  anchorNodeId,
}: {
  readonly cwd: string;
  /** The view it opens on: a seat's review opens on its uncommitted work, a git node on its commits. */
  readonly initialView?: GitDetailView;
  /** The commit to open on, in the commits view: the one a needs-you card carries. */
  readonly initialCommit?: string;
  /** The session the review was opened from, by node id: its comments go to that agent unless they mention another. */
  readonly recipientNodeId?: string;
  /** The node it was opened from (a seat, a git node): its region decides who can receive the review. */
  readonly anchorNodeId?: string;
}) {
  const doc = use$(state$.doc);
  const candidates = useMemo(() => reviewCandidates(doc, anchorNodeId, nodeTitle), [doc, anchorNodeId]);
  // An agent with no live seat can still be mailed: mail wakes it. The pickers
  // say so quietly. Read from the seat plane, which knows every seat on the
  // canvas; a seat whose state is unknown for a moment is not called offline.
  const seatRev = use$(agentSeat$.rev);
  const offline = useMemo(() => {
    const out = new Set<string>();
    for (const candidate of candidates) {
      const node = doc.nodes.find((entry) => entry.id === candidate.nodeId);
      const state = node ? seatEventForNode(node)?.state : undefined;
      if (state === undefined || state === "gone") out.add(candidate.nodeId);
    }
    return out;
    // The seat store mutates in place; its rev carries the change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidates, doc, seatRev]);
  // Who the review goes to: the session it was opened from, until the operator chooses another.
  const [to, setTo] = useState<string | undefined>(recipientNodeId);
  const nameOf = (nodeId: string): string => {
    const node = doc.nodes.find((candidate) => candidate.id === nodeId);
    return node ? nodeTitle(node) : nodeId;
  };
  const [view, setView] = useState<GitDetailView>(initialCommit ? "commits" : initialView);
  const [review, setReview] = useState<Extract<GitReviewResult, { ok: true }>>();
  const [activeFile, setActiveFile] = useState(0);
  const diffPane = useRef<HTMLDivElement>(null);
  const [commits, setCommits] = useState<ReadonlyArray<GitCommit>>([]);
  const [selected, setSelected] = useState<string | undefined>(initialCommit);
  const [patch, setPatch] = useState<string>("");
  const [cut, setCut] = useState<{ readonly files?: number; readonly shownFiles: number }>();
  const [patchError, setPatchError] = useState<string>();
  const [error, setError] = useState<string | undefined>();
  const [loadingPatch, setLoadingPatch] = useState(false);

  useEffect(() => {
    if (!cwd) {
      setError("no folder");
      return;
    }
    let live = true;
    void getJuntoApi()
      ?.gitLog?.(cwd)
      .then((result) => {
        if (!live) return;
        if (!result.ok) {
          setError(result.error);
          return;
        }
        setCommits(result.commits);
        // The commit asked for stays chosen, by its full id when the log holds it.
        setSelected((asked) =>
          asked ? (result.commits.find((commit) => commit.sha.startsWith(asked))?.sha ?? asked) : result.commits[0]?.sha,
        );
      })
      .catch(() => {
        if (!live) return;
        setError("git unavailable");
      });
    return () => {
      live = false;
    };
  }, [cwd]);

  useEffect(() => {
    if (view === "commits") return;
    setCut(undefined);
    setPatchError(undefined);
    setReview(undefined);
    setActiveFile(0);
    if (!cwd) {
      setPatch("");
      return;
    }
    let live = true;
    setLoadingPatch(true);
    void getJuntoApi()
      ?.gitReview?.(cwd, view)
      .then((result) => {
        if (!live) return;
        setLoadingPatch(false);
        if (result.ok) {
          setReview(result);
          setPatch(result.patch);
          if (result.shownFiles !== undefined) setCut({ files: result.files, shownFiles: result.shownFiles });
        } else {
          setPatch("");
          setPatchError(result.error);
        }
      })
      .catch(() => {
        if (!live) return;
        setLoadingPatch(false);
        setPatch("");
        setPatchError("git unavailable");
      });
    return () => {
      live = false;
    };
  }, [cwd, view]);

  useEffect(() => {
    if (view !== "commits") return;
    setCut(undefined);
    setPatchError(undefined);
    if (!cwd || !selected) {
      setPatch("");
      return;
    }
    let live = true;
    setLoadingPatch(true);
    void getJuntoApi()
      ?.gitShow?.(cwd, selected)
      .then((result) => {
        if (!live) return;
        setLoadingPatch(false);
        if (result.ok) {
          setPatch(result.patch);
          if (result.shownFiles !== undefined) {
            setCut({ files: result.files, shownFiles: result.shownFiles });
          }
        } else {
          setPatch("");
          setPatchError(result.error);
        }
      })
      .catch(() => {
        if (!live) return;
        setLoadingPatch(false);
        setPatch("");
        setPatchError("git unavailable");
      });
    return () => {
      live = false;
    };
  }, [cwd, selected, view]);

  // The diff view follows Junto's theme, not the system's.
  const fileDiffs = useMemo(() => splitPatchFiles(patch), [patch]);
  // One file per frame: the view highlights a file in one task, so a commit
  // of many files never holds the renderer longer than its largest file.
  const [mounted, setMounted] = useState(1);
  useEffect(() => setMounted(1), [fileDiffs]);
  useEffect(() => {
    if (mounted >= fileDiffs.length) return;
    const frame = requestAnimationFrame(() => setMounted((count) => count + 1));
    return () => cancelAnimationFrame(frame);
  }, [mounted, fileDiffs]);
  const filePaths = useMemo(() => fileDiffs.map(patchFilePath), [fileDiffs]);
  const reviewing = view !== "commits";
  // What is on screen, said honestly: a folder's uncommitted work is not one session's.
  const showing = reviewing ? gitReviewTitle(view, review?.base) : undefined;
  // A commit keeps its own pending review: its line numbers are that commit's, not the folder's.
  const reviewKey = reviewing || !selected ? cwd : `${cwd}@${selected}`;
  const goToFile = (index: number): void => {
    setActiveFile(index);
    // Every file up to the chosen one must be mounted before it can be scrolled to.
    setMounted((count) => Math.max(count, index + 1));
    requestAnimationFrame(() => {
      diffPane.current?.querySelector(`[data-file-index="${String(index)}"]`)?.scrollIntoView({ block: "start" });
    });
  };
  const active = view === "commits" ? commits.find((commit) => commit.sha === selected) : undefined;
  // The log's own count is the commit's; the capped read may have stopped early.
  const cutFiles = cut ? Math.max(active?.stats?.files ?? 0, cut.files ?? 0, cut.shownFiles) : 0;

  return (
    <>
      <InspectorTabs label="What to show" tabs={VIEW_TABS} active={view} onSelect={(id) => setView(id as GitDetailView)} />
      {error ? (
        <div className="git-browser__empty" style={{ color: DIM }}>
          {error}
        </div>
      ) : (
        <div className="git-browser min-h-0 flex-1" data-view={view}>
          {reviewing ? (
            <div className="git-browser__list" role="listbox" aria-label="Changed files" onKeyDown={moveInList}>
              {filePaths.map((path, index) => (
                <button
                  key={`${String(index)}:${path}`}
                  type="button"
                  role="option"
                  aria-selected={index === activeFile}
                  // One Tab stop for the list; the arrows move within it.
                  tabIndex={index === activeFile ? 0 : -1}
                  data-active={index === activeFile ? "true" : "false"}
                  className="git-browser__row git-browser__file"
                  title={path}
                  onClick={() => goToFile(index)}
                >
                  <span className="git-browser__file-name">{path.split("/").pop()}</span>
                  <span className="git-browser__file-folder">{path.split("/").slice(0, -1).join("/")}</span>
                </button>
              ))}
            </div>
          ) : (
          <div className="git-browser__list" role="listbox" aria-label="Commits" onKeyDown={moveInList}>
            {commits.map((commit, index) => (
              <button
                key={commit.sha}
                type="button"
                role="option"
                aria-selected={commit.sha === selected}
                tabIndex={index === Math.max(0, commits.findIndex((entry) => entry.sha === selected)) ? 0 : -1}
                data-active={commit.sha === selected ? "true" : "false"}
                className="git-browser__row"
                onClick={() => setSelected(commit.sha)}
              >
                <div className="truncate font-mono text-[12px] font-semibold" style={{ color: INK }}>
                  {commit.subject}
                </div>
                <div className="truncate font-mono text-[10px]" style={{ color: DIM }}>
                  {shortSha(commit.sha)} {commit.author} {formatWhen(commit.authoredAt)}
                </div>
                {commit.stats ? (
                  <div className="font-mono text-[10px] tabular-nums">
                    <span style={{ color: GREEN }}>+{commit.stats.additions}</span>
                    {" "}
                    <span style={{ color: HUE.orange }}>−{commit.stats.deletions}</span>
                  </div>
                ) : null}
              </button>
            ))}
          </div>
          )}
          <div className="git-browser__diff" ref={diffPane}>
            {showing ? (
              <div className="git-browser__showing" data-testid="git-review-showing">
                {showing}
                {review?.untrackedLeftOut
                  ? `, ${String(review.untrackedLeftOut)} more new ${review.untrackedLeftOut === 1 ? "file" : "files"} not shown`
                  : ""}
              </div>
            ) : null}
            {loadingPatch ? (
              <div className="git-browser__empty" style={{ color: DIM }}>
                loading diff
              </div>
            ) : patch.trim().length > 0 ? (
              <>
              {cut ? (
                <div className="git-browser__cut" style={{ color: DIM }} data-testid="git-diff-cut">
                  {`Large diff, cut to fit: ${String(cut.shownFiles)} of ${String(cutFiles)} ${cutFiles === 1 ? "file" : "files"}, long ones in part. Open it in a terminal for the rest.`}
                </div>
              ) : null}
              {fileDiffs.slice(0, mounted).map((file, index) => (
                <FileDiffBoundary key={`${String(index)}:${file.slice(0, 200)}`} text={file}>
                  <div data-file-index={index} className="git-browser__file-diff">
                    <ReviewDiff
                      root={reviewKey}
                      section={file}
                      path={filePaths[index] ?? "file"}
                      candidates={candidates}
                      offline={offline}
                    />
                  </div>
                </FileDiffBoundary>
              ))}
              </>
            ) : (
              <div className="git-browser__empty" style={{ color: DIM }}>
                {patchError
                  ? `diff unavailable: ${patchError}`
                  : cut
                    ? "diff too large to show here"
                    : view === "working"
                      ? "Nothing uncommitted in this folder."
                      : view === "base"
                        ? review?.base
                          ? `Nothing committed on this branch since ${review.base}.`
                          : "This repository has no base branch to compare with, or this branch is it."
                        : active ? "no diff" : "select a commit"}
              </div>
            )}
          </div>
        </div>
      )}
      {!error && (reviewing || selected) ? (
        <ReviewFooter
          root={reviewKey}
          repository={cwd.split(/[\\/]/).filter(Boolean).pop() ?? cwd}
          reviewed={
            reviewing
              ? review
                ? gitReviewedState({
                    view: review.view,
                    branch: review.branch,
                    ...(review.head ? { head: review.head } : {}),
                    ...(review.base ? { base: review.base } : {}),
                  })
                : undefined
              : selected && !loadingPatch && !patchError
                ? gitReviewedCommit({ sha: selected, subject: active?.subject })
                : undefined
          }
          to={to}
          onTo={setTo}
          candidates={candidates}
          offline={offline}
          nameOf={nameOf}
        />
      ) : null}
    </>
  );
}
