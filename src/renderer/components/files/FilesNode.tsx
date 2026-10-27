import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { use$ } from "@legendapp/state/react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import type { FileTreeRowDecorationRenderer } from "@pierre/trees";
import { ExternalLink, FileCode, FileQuestion, FileText, FolderSearch, Image, type LucideIcon } from "lucide-react";
import type { NodeId } from "@shared/physics/schema";
import { titleOf } from "@shared/model/title";
import { nodeAt } from "../../lib/use-model";
import {
  dirtyPaths,
  fileDraft,
  filesErrorLine,
  filesSource,
  fileUrlOf,
  fileViewOf,
  postFileComment,
  setFileDraft,
  useDraftsVersion,
  useFileEntries,
  useFileThreads,
  type FileEntry,
  type FilePath,
  type FileRead,
  type FileStamp,
  type FileView,
  type Loaded,
} from "../../lib/files-source";
import { FocusSurface } from "../FocusSurface";
import { Button, IconButton, PaneEmpty, PaneHeader, TwoPane } from "../ui";
import { ArtifactComments, ArtifactCommentsEdge } from "../artifacts/ArtifactComments";
import { LiveMarkdownField } from "../artifacts/LiveMarkdownField";
import { useSeatsInReach } from "../../lib/mention-sources";
import { openMention } from "../tasks/TaskThread";
import { commentsRailOpen, commentsRailRef, setCommentsRailOpen } from "../../lib/artifact-comments-rail";
import { sidebarSections$ } from "../../lib/sidebar-sections";
import "./files.css";

/** The tree's paths: a directory ends in `/`, as `@pierre/trees` reads them. */
export const treePathsOf = (entries: ReadonlyArray<FileEntry>): string[] =>
  entries.map((entry) => (entry.dir ? `${entry.path}/` : entry.path));

/** The file a tree selection opens: the last selected row that is not a directory. */
export const fileOfSelection = (selected: ReadonlyArray<string>): FilePath | null => {
  for (let index = selected.length - 1; index >= 0; index -= 1) {
    const path = selected[index];
    if (path !== undefined && !path.endsWith("/")) return path;
  }
  return null;
};

/** Cmd+S on macOS, Ctrl+S elsewhere, with nothing else held. */
export const isSaveChord = (event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">, mac: boolean): boolean =>
  event.key.toLowerCase() === "s" && !event.shiftKey && !event.altKey && (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);

const MAC = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

const VIEW_GLYPH: Record<FileView, LucideIcon> = {
  markdown: FileText,
  code: FileCode,
  image: Image,
  pdf: FileText,
  other: FileQuestion,
  "too-large": FileQuestion,
};

/**
 * The Files node (0.11, F2): the node's folder as a tree in the sidebar, the
 * picked file in the main pane with the viewer for its type, and its comment
 * threads in the rail. Laid out as the Artifacts node is. Unsaved text is
 * held per file for the session and marked in the tree and the header;
 * Cmd+S writes it against the version it was read at, and a file that moved
 * on disk since offers reload or keep.
 */
export function FilesNode({
  canvasName,
  nodeId,
  initialPath,
  onClose,
}: {
  readonly canvasName: string;
  readonly nodeId: NodeId;
  readonly initialPath?: FilePath;
  readonly onClose: () => void;
}) {
  const entries = useFileEntries(nodeId);
  const [selected, setSelected] = useState<FilePath | null>(initialPath ?? null);
  const draftsVersion = useDraftsVersion();
  const node = nodeAt(canvasName, nodeId);
  const folderName = node === undefined ? "Files" : titleOf(node);

  /** Read at paint time, so the marks follow the drafts without a new tree. */
  const dirty = useRef<ReadonlySet<string>>(new Set());
  dirty.current = new Set(dirtyPaths(nodeId));
  const decorate = useCallback<FileTreeRowDecorationRenderer>(
    ({ item }) => (item.kind === "file" && dirty.current.has(item.path) ? { text: "●", title: "Unsaved changes" } : null),
    [],
  );
  const { model } = useFileTree({
    paths: [],
    initialExpansion: 1,
    flattenEmptyDirectories: true,
    search: true,
    ...(initialPath === undefined ? {} : { initialSelectedPaths: [initialPath] }),
    onSelectionChange: (paths) => {
      const file = fileOfSelection(paths);
      if (file !== null) setSelected(file);
    },
    renderRowDecoration: decorate,
  });
  const paths = useMemo(() => (entries.state === "ready" ? treePathsOf(entries.value) : null), [entries]);
  useEffect(() => {
    if (paths !== null) model.resetPaths(paths);
  }, [model, paths]);
  useEffect(() => {
    // Redraw the rows so the unsaved marks follow the drafts.
    model.setComposition(model.getComposition());
  }, [model, draftsVersion]);

  const fileCount = entries.state === "ready" ? entries.value.filter((entry) => !entry.dir).length : null;
  const sidebar = (
    <>
      <PaneHeader
        eyebrow={
          <span className="files-eyebrow">
            <span className="files-eyebrow__word">{folderName},</span>
            <span className="files-eyebrow__count">{" "}{fileCount ?? ""}</span>
          </span>
        }
      />
      <FileTree model={model} className="files-tree" aria-label={`Files in ${folderName}`} />
    </>
  );

  /** The open file's save, for Cmd+S anywhere in the modal. */
  const save = useRef<(() => void) | null>(null);
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (!isSaveChord(event, MAC)) return;
    event.preventDefault();
    save.current?.();
  };

  const main = (() => {
    if (entries.state === "refused") return <PaneEmpty title={filesErrorLine(entries.error)} />;
    if (selected === null) {
      return (
        <PaneEmpty
          glyph={<FileText size={20} />}
          title={fileCount === 0 ? "This folder is empty" : "Pick a file"}
          hint={fileCount === 0 ? "Files you add to the folder show here." : undefined}
        />
      );
    }
    return null;
  })();

  return (
    <FocusSurface measure="workspace" height="immersive" label="Files" onClose={onClose} onKeyDown={onKeyDown}>
      {main !== null || selected === null ? (
        <TwoPane sidebar={sidebar} sidebarLabel="Files" sidebarWidth="narrow" mainLabel="File">
          {main}
        </TwoPane>
      ) : (
        <SelectedFile key={selected} canvasName={canvasName} nodeId={nodeId} path={selected} sidebar={sidebar} save={save} onClose={onClose} />
      )}
    </FocusSurface>
  );
}

function SelectedFile({
  canvasName,
  nodeId,
  path,
  sidebar,
  save,
  onClose,
}: {
  readonly canvasName: string;
  readonly nodeId: NodeId;
  readonly path: FilePath;
  readonly sidebar: React.ReactNode;
  readonly save: React.MutableRefObject<(() => void) | null>;
  readonly onClose: () => void;
}) {
  const [read, setRead] = useState<Loaded<FileRead>>({ state: "loading" });
  /** The file moved on disk under an unsaved draft: reload or keep. */
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  useDraftsVersion();
  const draft = fileDraft(nodeId, path);

  const load = useCallback(async (): Promise<void> => {
    const result = await filesSource().read(nodeId, path);
    setRead(result.ok ? { state: "ready", value: result.value } : { state: "refused", error: result.error });
  }, [nodeId, path]);
  useEffect(() => {
    void load();
    return filesSource().watch(nodeId, (paths) => {
      if (!paths.includes(path)) return;
      // A clean file follows the disk; a draft is the operator's until they choose.
      if (fileDraft(nodeId, path) === undefined) void load();
      else setStale(true);
    });
  }, [load, nodeId, path]);

  const text = read.state === "ready" && read.value.kind === "text" ? read.value : null;
  const edit = (next: string): void => {
    if (text === null) return;
    const base = fileDraft(nodeId, path)?.base ?? text.stamp;
    setFileDraft(nodeId, path, next === text.text && base === text.stamp ? undefined : { text: next, base });
  };

  const write = async (body: string, base: FileStamp): Promise<void> => {
    setSaving(true);
    const result = await filesSource().write(nodeId, path, body, base);
    setSaving(false);
    if (result.ok) {
      setFileDraft(nodeId, path, undefined);
      setRead({ state: "ready", value: { kind: "text", text: body, stamp: result.value } });
      setStale(false);
      setError(null);
    } else if (result.error === "stale") {
      setStale(true);
    } else {
      setError(filesErrorLine(result.error));
    }
  };
  save.current = () => {
    const held = fileDraft(nodeId, path);
    if (held !== undefined && !saving) void write(held.text, held.base);
  };
  useEffect(
    () => () => {
      save.current = null;
    },
    [save],
  );

  const reload = (): void => {
    setFileDraft(nodeId, path, undefined);
    setStale(false);
    void load();
  };
  /** Keep the draft: write it over what is on disk now. */
  const keep = async (): Promise<void> => {
    const held = fileDraft(nodeId, path);
    if (held === undefined) return setStale(false);
    const fresh = await filesSource().read(nodeId, path);
    if (!fresh.ok) return setError(filesErrorLine(fresh.error));
    if (fresh.value.kind !== "text") return setError("This file is no longer text on disk.");
    await write(held.text, fresh.value.stamp);
  };
  const outside = async (open: "openInDefaultApp" | "revealInFinder"): Promise<void> => {
    const result = await filesSource()[open](nodeId, path);
    setError(result.ok ? null : filesErrorLine(result.error));
  };

  const view = read.state === "ready" ? fileViewOf(path, read.value) : null;
  const Glyph = VIEW_GLYPH[view ?? "other"];
  const slash = path.lastIndexOf("/");

  const body = (() => {
    if (read.state === "loading") return <PaneEmpty title="Opening" />;
    if (read.state === "refused") return <PaneEmpty title={filesErrorLine(read.error)} />;
    const value = read.value;
    const elsewhere = (
      <div className="files-elsewhere">
        <Button size="sm" variant="primary" onClick={() => void outside("openInDefaultApp")}>
          Open in default app
        </Button>
        <Button size="sm" variant="chrome" onClick={() => void outside("revealInFinder")}>
          Reveal in Finder
        </Button>
      </div>
    );
    switch (view) {
      case "markdown":
        return value.kind === "text" ? (
          <LiveMarkdownField
            key={value.stamp.mtimeMs}
            className="files-markdown"
            label={path}
            surfaceLabel="File"
            value={draft?.text ?? value.text}
            onChange={edit}
          />
        ) : null;
      case "code":
        return value.kind === "text" ? <FileCodeEditor path={path} value={draft?.text ?? value.text} onChange={edit} /> : null;
      case "image":
        return (
          <div className="files-media">
            <img className="files-media__image" src={fileUrlOf(nodeId, path)} alt={path} />
          </div>
        );
      case "pdf":
        return <PaneEmpty glyph={<FileText size={20} />} title="A PDF" hint="Its preview opens here once the viewer lands." action={elsewhere} />;
      case "too-large":
        return (
          <PaneEmpty
            glyph={<FileQuestion size={20} />}
            title="Too large to open here"
            hint={value.kind === "too-large" ? `${formatSize(value.size)}, over the 5 MB Junto reads.` : undefined}
            action={elsewhere}
          />
        );
      default:
        return <PaneEmpty glyph={<FileQuestion size={20} />} title="Junto does not open this kind of file" action={elsewhere} />;
    }
  })();

  return (
    <TwoPane
      sidebar={sidebar}
      sidebarLabel="Files"
      sidebarWidth="narrow"
      mainLabel={path}
      rail={<FileRail canvasName={canvasName} nodeId={nodeId} path={path} onClose={onClose} />}
      railLabel="Comments"
      railCollapsed={!commentsRailOpen(use$(sidebarSections$.open))}
    >
      <header className="files-head">
        <Glyph size={14} aria-hidden className="files-head__glyph" />
        <span className="files-head__path" title={path}>
          {slash < 0 ? null : <span className="files-head__dir">{path.slice(0, slash + 1)}</span>}
          <span className="files-head__name">{path.slice(slash + 1)}</span>
        </span>
        {draft !== undefined ? (
          <span className="files-head__unsaved" role="status">
            Unsaved
          </span>
        ) : null}
        {text !== null ? (
          <Button size="xs" variant={draft === undefined ? "subtle" : "primary"} disabled={draft === undefined || saving} onClick={() => save.current?.()}>
            {saving ? "Saving" : "Save"}
          </Button>
        ) : null}
        <IconButton aria-label="Open in default app" title="Open in default app" size="sm" onClick={() => void outside("openInDefaultApp")}>
          <ExternalLink size={14} />
        </IconButton>
        <IconButton aria-label="Reveal in Finder" title="Reveal in Finder" size="sm" onClick={() => void outside("revealInFinder")}>
          <FolderSearch size={14} />
        </IconButton>
      </header>
      {stale ? (
        <div className="files-stale" role="alert">
          <span>{filesErrorLine("stale")}</span>
          <Button size="xs" variant="chrome" onClick={reload}>
            Reload from disk
          </Button>
          <Button size="xs" variant="primary" onClick={() => void keep()}>
            Keep mine
          </Button>
        </div>
      ) : null}
      {error ? (
        <p className="files-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="files-main">{body}</div>
    </TwoPane>
  );
}

/**
 * The code editor's place. Product-documents' editor (F3) takes it; until
 * then a plain field, so text opens, edits and saves.
 */
function FileCodeEditor({ path, value, onChange }: { readonly path: FilePath; readonly value: string; readonly onChange: (text: string) => void }) {
  return (
    <textarea
      className="files-code"
      aria-label={path}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      wrap="off"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

function FileRail({
  canvasName,
  nodeId,
  path,
  onClose,
}: {
  readonly canvasName: string;
  readonly nodeId: NodeId;
  readonly path: FilePath;
  readonly onClose: () => void;
}) {
  const threads = useFileThreads(nodeId, path);
  const mentionable = useSeatsInReach(canvasName, nodeId);
  const open = commentsRailOpen(use$(sidebarSections$.open));
  const ref = useCallback((element: HTMLDivElement | null) => commentsRailRef(element), []);
  const seatName = (id: string): string | undefined => {
    const seat = nodeAt(canvasName, id);
    return seat === undefined ? undefined : titleOf(seat);
  };
  return (
    <div className="files-rail" ref={ref}>
      {open ? (
        <ArtifactComments
          canvasName={canvasName}
          mentionable={mentionable}
          threads={threads}
          nodeKindOf={(id) => nodeAt(canvasName, id)?.kind}
          onOpenMention={(mention) => {
            onClose();
            openMention(mention);
          }}
          seatName={seatName}
          draftAnchor={undefined}
          now={Date.now()}
          onStart={(text, anchor) => postFileComment(nodeId, path, { text, ...(anchor === undefined ? {} : { anchor }) })}
          onReply={(threadId, text) => postFileComment(nodeId, path, { text, threadId })}
          onClearAnchor={() => undefined}
          onCollapse={() => setCommentsRailOpen(false)}
        />
      ) : (
        <ArtifactCommentsEdge threads={threads} seatName={seatName} onOpen={() => setCommentsRailOpen(true)} />
      )}
    </div>
  );
}

const formatSize = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
