/**
 * One commit an agent sent with a needs-you card, to read: what it says, who
 * made it and when, a branch that holds it, the files it changed with their
 * counts, and its diff. Read only: nothing here takes a comment.
 *
 * The card carries the commit id alone. The folder is the sending seat's
 * own, found from the canvas, never a path the agent wrote. A commit that
 * cannot be read says why; no value is ever a stand-in.
 */
import { useEffect, useState } from "react";
import { use$ } from "@legendapp/state/react";
import type { GitCommitResult } from "@shared/git";
import { getJuntoApi } from "../../lib/junto-api";
import { seatGitFolder } from "../../lib/git-summary";
import { state$ } from "../../lib/state";
import { DiffView } from "../ui";
import "./git.css";

const whenLabel = (iso: string): string | undefined => {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? undefined : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};

type Read = { readonly key: string; readonly result: GitCommitResult };

export function CommitPreview({
  canvasName,
  nodeId,
  sha,
  layout = "unified",
}: {
  /** The canvas and seat of the agent that sent the card. */
  readonly canvasName: string;
  readonly nodeId: string;
  readonly sha: string;
  /** Unified suits a card; split suits a wide stage. */
  readonly layout?: "split" | "unified";
}) {
  const openCanvas = use$(state$.canvasName);
  const folder = use$(() => {
    if (state$.canvasName.get() !== canvasName) return undefined;
    const doc = state$.doc.get();
    const node = doc.nodes.find((candidate) => candidate.id === nodeId);
    return node ? seatGitFolder(doc, node) : undefined;
  });
  const key = `${folder ?? ""}\u0000${sha}`;
  const [read, setRead] = useState<Read>();
  useEffect(() => {
    if (!folder) return undefined;
    let live = true;
    const api = getJuntoApi();
    const done = (result: GitCommitResult): void => {
      if (live) setRead({ key, result });
    };
    const unread = (): void => done({ ok: false, error: "This commit could not be read." });
    const reading = api?.gitCommit?.(folder, sha);
    if (reading) reading.then(done, unread);
    else unread();
    return () => {
      live = false;
    };
  }, [folder, sha, key]);

  const problem = !folder
    ? openCanvas !== canvasName
      ? `This commit is in an agent's folder on the ${canvasName} canvas. Open that canvas to read it.`
      : "The agent that sent this commit has no folder on this canvas."
    : read?.key === key && !read.result.ok
      ? read.result.error
      : undefined;
  if (problem) {
    return (
      <div className="commit-preview" data-testid="commit-preview">
        <p className="commit-preview__problem" role="status">
          {problem}
        </p>
        <p className="commit-preview__meta">{sha}</p>
      </div>
    );
  }
  if (read?.key !== key || !read.result.ok) {
    return (
      <div className="commit-preview" data-testid="commit-preview" aria-busy="true">
        <p className="commit-preview__meta" role="status">
          Reading the commit
        </p>
      </div>
    );
  }
  const { commit, branch, files, patch, shownFiles } = read.result;
  const when = whenLabel(commit.authoredAt);
  return (
    <div className="commit-preview" data-testid="commit-preview">
      <header className="commit-preview__head">
        <h3 className="commit-preview__subject">{commit.subject}</h3>
        <p className="commit-preview__meta">
          <span className="commit-preview__sha">{commit.sha.slice(0, 7)}</span>
          {commit.author ? <span>{commit.author}</span> : null}
          {when ? <time dateTime={commit.authoredAt}>{when}</time> : null}
          {branch ? <span>on {branch}</span> : null}
        </p>
      </header>
      {files.length > 0 ? (
        <ul className="commit-preview__files" aria-label={`${String(files.length)} ${files.length === 1 ? "file" : "files"} changed`}>
          {files.map((file) => (
            <li key={file.path} className="commit-preview__file">
              <span className="commit-preview__path">{file.path}</span>
              {file.additions === undefined ? (
                <span className="commit-preview__count">binary</span>
              ) : (
                <span className="commit-preview__count">
                  <span data-sign="add">+{file.additions}</span> <span data-sign="del">-{file.deletions ?? 0}</span>
                </span>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="commit-preview__meta">This commit changes no files.</p>
      )}
      {shownFiles !== undefined ? (
        <p className="commit-preview__meta">
          {`Large diff, cut to fit: ${String(shownFiles)} of ${String(Math.max(files.length, shownFiles))} files shown, long ones in part.`}
        </p>
      ) : null}
      {patch.trim().length > 0 ? <DiffView patch={patch} layout={layout} /> : null}
    </div>
  );
}
