import { useEffect, useState } from "react";
import { GitBranch } from "lucide-react";
import type { NodeOf } from "@shared/model";
import type { GitStatus } from "@shared/git";
import { getJuntoApi } from "../../lib/junto-api";
import { FirstLineRenameInput } from "../nodes/FirstLineRenameInput";
import { SpineCard } from "../nodes/SpineCard";
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
  const sync = [ahead > 0 ? `↑${String(ahead)}` : "", behind > 0 ? `↓${String(behind)}` : ""].filter(Boolean).join(" ");
  const line =
    error && !status
      ? error
      : [status?.branch ?? "reading", sync, head ? `${shortSha(head.sha)} ${head.subject}` : status ? "no commits" : ""]
          .filter(Boolean)
          .join(" ");

  return (
    <div className="git-glance h-full w-full" data-testid="git-card">
      <SpineCard
        glyph={<GitBranch strokeWidth={1.8} />}
        hue="orange"
        name={label}
        status={error && !status ? "off" : undefined}
        nameEditor={
          renaming && onRenameDone ? (
            <FirstLineRenameInput initial={label} ariaLabel="Rename git" onCommit={commitRename} onDone={onRenameDone} />
          ) : undefined
        }
        body={{ kind: "leaf", line }}
      />
    </div>
  );
}
