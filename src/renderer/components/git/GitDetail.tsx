import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { PatchDiff } from "@pierre/diffs/react";
import type { CanvasNode } from "@shared/canvas";
import type { GitCommit } from "@shared/git";
import { DIM, GREEN, HUE, INK } from "../../lib/theme";
import { getJuntoApi } from "../../lib/junto-api";
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
        if (result.ok) setPatch(result.patch);
        else setPatch("");
      })
      .catch(() => {
        if (!live) return;
        setLoadingPatch(false);
        setPatch("");
      });
    return () => {
      live = false;
    };
  }, [cwd, selected]);

  const active = commits.find((commit) => commit.sha === selected);

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
              <PatchDiff
                patch={patch}
                disableWorkerPool
                options={{
                  theme: { dark: "pierre-dark", light: "pierre-light" },
                  overflow: "scroll",
                }}
              />
            ) : (
              <div className="git-browser__empty" style={{ color: DIM }}>
                {active ? "no diff" : "select a commit"}
              </div>
            )}
          </div>
        </div>
      )}
      </div>
    </FocusSurface>
  );
}
