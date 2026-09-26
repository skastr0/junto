import { Component, useEffect, useMemo, useState, type ReactNode } from "react";
import { use$ } from "@legendapp/state/react";
import { X } from "lucide-react";
import { PatchDiff } from "@pierre/diffs/react";
import type { CanvasNode } from "@shared/canvas";
import { splitPatchFiles, type GitCommit } from "@shared/git";
import { DIM, GREEN, HUE, INK } from "../../lib/theme";
import { getJuntoApi } from "../../lib/junto-api";
import { themeMode$ } from "../../lib/theme-mode";
import { FocusSurface } from "../FocusSurface";
import { IconButton, OverlayHeader } from "../ui";
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

export function GitDetail({
  node,
  onClose,
}: {
  readonly node: CanvasNode;
  readonly onClose: () => void;
}) {
  const cwd = node.ether?.git?.cwd?.trim() ?? "";
  const title = node.type === "text" ? node.text.split("\n")[0] || "git" : "git";
  const [commits, setCommits] = useState<ReadonlyArray<GitCommit>>([]);
  const [selected, setSelected] = useState<string>();
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
        setSelected(result.commits[0]?.sha);
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
  }, [cwd, selected]);

  // The diff view follows Junto's theme, not the system's.
  const themeType = use$(themeMode$) === "bright" ? "light" : "dark";
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
  const active = commits.find((commit) => commit.sha === selected);
  // The log's own count is the commit's; the capped read may have stopped early.
  const cutFiles = cut ? Math.max(active?.stats?.files ?? 0, cut.files ?? 0, cut.shownFiles) : 0;

  return (
    <FocusSurface
      measure="workspace"
      height="immersive"
      layer="work"
      label="Git commits"
      onClose={onClose}
    >
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
      {error ? (
        <div className="git-browser__empty" style={{ color: DIM }}>
          {error}
        </div>
      ) : (
        <div className="git-browser min-h-0 flex-1">
          <div className="git-browser__list" role="listbox" aria-label="Commits">
            {commits.map((commit) => (
              <button
                key={commit.sha}
                type="button"
                role="option"
                aria-selected={commit.sha === selected}
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
          <div className="git-browser__diff">
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
                  <PatchDiff
                    patch={file}
                    disableWorkerPool
                    options={{
                      theme: { dark: "pierre-dark", light: "pierre-light" },
                      themeType,
                      overflow: "scroll",
                    }}
                  />
                </FileDiffBoundary>
              ))}
              </>
            ) : (
              <div className="git-browser__empty" style={{ color: DIM }}>
                {patchError
                  ? `diff unavailable: ${patchError}`
                  : cut
                    ? "diff too large to show here"
                    : active ? "no diff" : "select a commit"}
              </div>
            )}
          </div>
        </div>
      )}
      </div>
    </FocusSurface>
  );
}
