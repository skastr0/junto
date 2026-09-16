import { useEffect, useState, type ReactNode } from "react";
import { GitBranch } from "lucide-react";
import type { CanvasNode } from "@shared/canvas";
import type { GitStatus } from "@shared/git";
import { DIM, GREEN, HUE, INK } from "../../lib/theme";
import { getJuntoApi } from "../../lib/junto-api";
import { FirstLineRenameInput } from "../nodes/FirstLineRenameInput";
import { editText } from "../../lib/mutations";
import "./git.css";

type SinkRenameProps = {
  readonly renaming?: boolean;
  readonly onRenameDone?: () => void;
};

const shortSha = (sha: string): string => sha.slice(0, 7);

function AmberDecal({ children }: { readonly children: ReactNode }) {
  return (
    <div className="grid size-7 shrink-0 place-items-center rounded-md border border-amber/25 bg-amber/[0.07] text-amber">
      {children}
    </div>
  );
}

export function GitCard({
  node,
  renaming = false,
  onRenameDone,
}: {
  readonly node: CanvasNode;
} & SinkRenameProps) {
  const cwd = node.ether?.git?.cwd?.trim() ?? "";
  const rawText = node.type === "text" ? node.text : "";
  const firstLine = rawText.split("\n")[0] ?? "";
  const label = firstLine || "git";
  const [status, setStatus] = useState<GitStatus | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    if (!cwd) {
      setStatus(undefined);
      setError("no folder");
      return;
    }
    let live = true;
    void getJuntoApi()
      ?.gitStatus?.(cwd)
      .then((result) => {
        if (!live) return;
        if (result.ok) {
          setStatus(result.status);
          setError(undefined);
        } else {
          setStatus(undefined);
          setError(result.error);
        }
      })
      .catch(() => {
        if (!live) return;
        setError("git unavailable");
      });
    return () => {
      live = false;
    };
  }, [cwd]);

  const commitRename = (nextFirst: string) => {
    const rest = rawText.split("\n").slice(1).join("\n");
    editText(node.id, rest ? `${nextFirst}\n${rest}` : nextFirst);
  };

  const ahead = status?.ahead ?? 0;
  const behind = status?.behind ?? 0;
  const head = status?.head;

  return (
    <div className="factory-glance git-glance flex h-full w-full flex-col overflow-hidden" data-testid="git-card">
      <div className="factory-glance__header flex items-center gap-2">
        <AmberDecal>
          <GitBranch size={15} />
        </AmberDecal>
        <div className="min-w-0 flex-1">
          {renaming && onRenameDone ? (
            <FirstLineRenameInput
              initial={label}
              ariaLabel="Rename git"
              onCommit={commitRename}
              onDone={onRenameDone}
            />
          ) : (
            <div
              className="truncate font-mono text-[14px] font-semibold leading-snug"
              style={{ color: INK }}
              title={label}
            >
              {label}
            </div>
          )}
        </div>
      </div>
      {error && !status ? (
        <div className="factory-glance__empty mt-1.5 text-[9px]" style={{ color: DIM }}>
          {error}
        </div>
      ) : (
        <div className="factory-glance__list mt-1.5 flex min-h-0 flex-1 flex-col gap-0.5 overflow-hidden">
          <div className="git-glance__meta">
            <span className="git-glance__branch truncate" style={{ color: INK }}>
              {status?.branch ?? "—"}
            </span>
            <span className="git-glance__sync" style={{ color: DIM }}>
              ↑{ahead} ↓{behind}
            </span>
          </div>
          {head ? (
            <>
              <div className="git-glance__commit truncate text-[10px] leading-snug" style={{ color: INK }}>
                <span className="git-glance__sha" style={{ color: DIM }}>
                  {shortSha(head.sha)}
                </span>{" "}
                {head.subject}
              </div>
              <div className="git-glance__loc" data-testid="git-glance-loc">
                <span style={{ color: GREEN }}>+{head.stats?.additions ?? 0}</span>
                {" "}
                <span style={{ color: HUE.orange }}>−{head.stats?.deletions ?? 0}</span>
              </div>
            </>
          ) : (
            <div className="factory-glance__empty text-[9px]" style={{ color: DIM }}>
              no commits
            </div>
          )}
        </div>
      )}
    </div>
  );
}
