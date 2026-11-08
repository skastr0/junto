import { useEffect, useState } from "react";
import type { NodeOf } from "@shared/model";
import type { GitStatus } from "@shared/git";
import { useGitWindow } from "../../lib/git-summary";
import { FirstLineRenameInput } from "../nodes/FirstLineRenameInput";
import { KindCard } from "../nodes/SpineCard";
import { editText } from "../../lib/mutations";
import "./git.css";

type SinkRenameProps = {
  readonly renaming?: boolean;
  readonly onRenameDone?: () => void;
};

const shortSha = (sha: string): string => sha.slice(0, 7);

export function GitCard({
  node,
  renaming = false,
  onRenameDone,
}: {
  readonly node: NodeOf<"git">;
} & SinkRenameProps) {
  const cwd = node.cwd?.trim() ?? "";
  const rawText = node.label ?? "";
  const firstLine = rawText.split("\n")[0] ?? "";
  const label = firstLine || "git";
  const [status, setStatus] = useState<GitStatus | undefined>();
  const [error, setError] = useState<string | undefined>();
  const gitWindow = useGitWindow();

  useEffect(() => {
    if (!cwd) {
      setStatus(undefined);
      setError("no folder");
      return;
    }
    if (gitWindow === undefined) return;
    let live = true;
    void gitWindow.runtime
      .runPromise(gitWindow.git.GitStatus({ cwd }))
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
  }, [cwd, gitWindow]);

  const commitRename = (nextFirst: string) => {
    const rest = rawText.split("\n").slice(1).join("\n");
    editText(node.id, rest ? `${nextFirst}\n${rest}` : nextFirst);
  };

  const ahead = status?.ahead ?? 0;
  const behind = status?.behind ?? 0;
  const head = status?.head;
  const sync = [ahead > 0 ? `↑${String(ahead)}` : "", behind > 0 ? `↓${String(behind)}` : ""].filter(Boolean).join(" ");
  const line =
    error && !status
      ? error
      : [status?.branch ?? "reading", sync, head ? `${shortSha(head.sha)} ${head.subject}` : status ? "no commits" : ""]
          .filter(Boolean)
          .join(" ");

  return (
    <div className="git-glance h-full w-full" data-testid="git-card">
      <KindCard
        kind="git"
        name={label}
        status={error && !status ? "off" : undefined}
        nameEditor={
          renaming && onRenameDone ? (
            <FirstLineRenameInput initial={label} ariaLabel="Rename git" onCommit={commitRename} onDone={onRenameDone} />
          ) : undefined
        }
        line={line}
        lineTitle={line}
      />
    </div>
  );
}
