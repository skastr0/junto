/**
 * Pick a folder or a file by browsing this machine, instead of typing its
 * path. Reads through the same host directory listing the folder paths
 * control uses. Typing the path stays possible: this only fills the field.
 */
import { useEffect, useState } from "react";
import { ArrowUp, File, Folder } from "lucide-react";
import type { HostDirectorySnapshot } from "@shared/host-directory";
import { Button, IconButton } from "../ui";

export type ReadDirectory = (path: string) => Promise<HostDirectorySnapshot>;

/** Where browsing starts for what is already typed: the folder it names, or home. */
export const browseStart = (typed: string, mode: "file" | "directory"): string => {
  const path = typed.trim();
  if (!path) return "~";
  if (mode === "directory") return path;
  const cut = path.lastIndexOf("/");
  return cut > 0 ? path.slice(0, cut) : cut === 0 ? "/" : "~";
};

export function PathBrowser({
  mode,
  start,
  read,
  onPick,
  onClose,
}: {
  readonly mode: "file" | "directory";
  readonly start: string;
  readonly read: ReadDirectory;
  readonly onPick: (path: string) => void;
  readonly onClose: () => void;
}) {
  const [path, setPath] = useState(start);
  const [page, setPage] = useState<HostDirectorySnapshot | undefined>();
  const [problem, setProblem] = useState<string | undefined>();

  useEffect(() => {
    let live = true;
    read(path).then(
      (next) => {
        if (!live) return;
        setPage(next);
        setProblem(undefined);
      },
      () => {
        if (live) setProblem(`Junto could not open ${path}.`);
      },
    );
    return () => {
      live = false;
    };
  }, [path, read]);

  const entries = [...(page?.entries ?? [])]
    .filter((entry) => entry.kind === "directory" || mode === "file")
    .sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1));

  return (
    <div className="region-env__browser" data-testid="region-env-browser" data-mode={mode}>
      <div className="region-env__browser-head">
        <IconButton
          size="sm"
          aria-label="Up one folder"
          title="Up one folder"
          disabled={page?.parent === undefined}
          onClick={() => page?.parent !== undefined && setPath(page.parent)}
        >
          <ArrowUp size={12} />
        </IconButton>
        <span className="region-env__browser-root" data-testid="region-env-browser-root">
          {page?.root ?? path}
        </span>
        {mode === "directory" ? (
          <Button
            type="button"
            size="xs"
            variant="primary"
            disabled={page === undefined}
            data-testid="region-env-browser-use"
            onClick={() => page && onPick(page.root)}
          >
            use this folder
          </Button>
        ) : null}
        <Button type="button" size="xs" variant="subtle" onClick={onClose}>
          close
        </Button>
      </div>
      {problem ? (
        <p className="region-env__error" role="alert">
          {problem}
        </p>
      ) : null}
      <ul className="region-env__browser-list">
        {entries.map((entry) => (
          <li key={entry.path}>
            <button
              type="button"
              className="region-env__browser-entry"
              data-testid="region-env-browser-entry"
              data-kind={entry.kind}
              onClick={() => (entry.kind === "directory" ? setPath(entry.path) : onPick(entry.path))}
            >
              {entry.kind === "directory" ? <Folder size={12} aria-hidden /> : <File size={12} aria-hidden />}
              <span>{entry.name}</span>
            </button>
          </li>
        ))}
        {page !== undefined && entries.length === 0 ? (
          <li className="region-env__empty">
            {mode === "file" ? "Nothing in this folder." : "No folders inside this one."}
          </li>
        ) : null}
      </ul>
    </div>
  );
}
