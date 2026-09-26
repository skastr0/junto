import { useEffect, useState } from "react";
import { GitBranch } from "lucide-react";
import type { CanvasNode } from "@shared/canvas";
import type { GitStatus } from "@shared/git";
import type { ActivitySpec } from "../../lib/activity";
import { getJuntoApi } from "../../lib/junto-api";
import { FirstLineRenameInput } from "../nodes/FirstLineRenameInput";
import { InstrumentSeat } from "../nodes/InstrumentSeat";
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
  // Status the seat way: in step rests still, out of step with upstream
  // breathes cyan, an unreadable folder is the stopped ring.
  const activity: ActivitySpec = error && !status
    ? { mode: "static", tone: "steel", glyph: "off", label: error }
    : ahead > 0 || behind > 0
      ? { mode: "static", tone: "cyan", glyph: "dot", label: `${String(ahead)} ahead, ${String(behind)} behind upstream` }
      : { mode: "static", tone: "steel", label: status ? "in step with upstream" : "reading" };
  const sync = [ahead > 0 ? `↑${String(ahead)}` : "", behind > 0 ? `↓${String(behind)}` : ""].filter(Boolean).join(" ");
  const lineTitle = head
    ? `${status?.branch ?? ""} ${shortSha(head.sha)} ${head.subject} (+${String(head.stats?.additions ?? 0)} −${String(head.stats?.deletions ?? 0)})`
    : error;

  return (
    <div className="git-glance h-full w-full" data-testid="git-card">
      <InstrumentSeat
        activity={activity}
        glyph={<GitBranch size={16} strokeWidth={1.8} />}
        title={
          renaming && onRenameDone ? (
            <FirstLineRenameInput
              initial={label}
              ariaLabel="Rename git"
              onCommit={commitRename}
              onDone={onRenameDone}
            />
          ) : (
            <div className="truncate font-mono text-[13px] font-semibold leading-snug text-ink" title={label}>
              {label}
            </div>
          )
        }
        lineTitle={lineTitle}
        line={
          error && !status ? (
            error
          ) : (
            <>
              <span className="git-glance__branch text-ink">{status?.branch ?? "reading"}</span>
              {sync ? <span className="git-glance__sync text-cyan"> {sync}</span> : null}
              {head ? <span> {head.subject}</span> : status ? <span> no commits</span> : null}
            </>
          )
        }
      />
    </div>
  );
}
