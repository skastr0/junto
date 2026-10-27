import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import type { FileTreeRowDecorationRenderer } from "@pierre/trees";
import { CircleAlert, ExternalLink, FileCode, FileQuestion, FileText, FolderSearch, Image, type LucideIcon } from "lucide-react";
import type { NodeId } from "@shared/physics/schema";
import { titleOf } from "@shared/model/title";
import { baseName, parentOf, ROOT_PATH, sameStamp, type FilePath, type FileRead, type FilesNodeRef, type FileStamp } from "@shared/files";
import { fileUrl } from "@shared/file-url";
import { nodeAt } from "../../lib/use-model";
import {
  changeTouches,
  dirtyPaths,
  fileDraft,
  filesErrorLine,
  filesSource,
  fileViewOf,
  postFileComment,
  setFileDraft,
  useDraftsVersion,
  useFileThreads,
  useFilesRoot,
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
import { fileOfSelection, treePathOf, useFolderTree } from "./files-tree";
import { FILES_DROP_TREE_CSS, FilesDropHighlight } from "./FilesDropHighlight";
import { useFilesDrop } from "./useFilesDrop";
import { registerFileEditorSave } from "../../lib/file-editor-keys";
import { keyAria } from "../../lib/key-match";
import "../ui/file-tree.css";
import "./files.css";

const VIEW_GLYPH: Record<FileView, LucideIcon> = {
  markdown: FileText,
  code: FileCode,
  image: Image,
  pdf: FileText,
  other: FileQuestion,
  "too-large": FileQuestion,
};

/** Ancestors of `path` as tree paths, so the tree opens down to a file it was asked to show. */
const ancestorsOf = (path: FilePath): string[] => {
  const out: string[] = [];
  for (let dir = parentOf(path); dir !== ROOT_PATH; dir = parentOf(dir)) out.unshift(treePathOf({ path: dir, dir: true }));
  return out;
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
  const ref = useMemo<FilesNodeRef>(() => ({ canvas: canvasName, node: nodeId }), [canvasName, nodeId]);
  const root = useFilesRoot(ref);
  const [selected, setSelected] = useState<FilePath | null>(initialPath ?? null);
  const draftsVersion = useDraftsVersion();
  const node = nodeAt(canvasName, nodeId);
  const folderName = root.state === "ready" ? root.value.name : node === undefined ? "Files" : titleOf(node);

  /** Read at paint time, so the marks follow the drafts without a new tree. */
  const dirty = useRef<ReadonlySet<string>>(new Set());
  dirty.current = new Set(dirtyPaths(nodeId));
  const decorate = useCallback<FileTreeRowDecorationRenderer>(
    ({ item }) => (item.kind === "file" && dirty.current.has(item.path) ? { text: "●", title: "Unsaved changes" } : null),
    [],
  );
  const drop = useFilesDrop({ port: filesSource(), node: ref, describe: filesErrorLine, rootLabel: folderName });
  const { model } = useFileTree({
    paths: [],
    dragAndDrop: drop.treeDragAndDrop,
    unsafeCSS: FILES_DROP_TREE_CSS,
    initialExpansion: "closed",
    ...(initialPath === undefined ? {} : { initialExpandedPaths: ancestorsOf(initialPath), initialSelectedPaths: [initialPath] }),
    search: true,
    itemHeight: 28,
    onSelectionChange: (paths) => {
      const file = fileOfSelection(paths);
      if (file !== null) setSelected(file);
    },
    renderRowDecoration: decorate,
  });
  useFolderTree(ref, model, root.state === "ready");
  useEffect(() => {
    drop.bindModel(model);
    return () => drop.bindModel(null);
  }, [drop.bindModel, model]);
  useEffect(() => {
    // Redraw the rows so the unsaved marks follow the drafts.
    model.setComposition(model.getComposition());
  }, [model, draftsVersion]);

  const sidebar = (
    <>
      <PaneHeader eyebrow={<span className="files-eyebrow">{folderName}</span>} />
      <FileTree model={model} className="files-tree" aria-label={`Files in ${folderName}`} />
    </>
  );

  /** The open file's save. Cmd+S (files.save) reaches it for the life of the modal, so the key is never left to beep. */
  const save = useRef<(() => void) | null>(null);
  useEffect(() => registerFileEditorSave(() => save.current?.()), []);

  const empty =
    root.state === "refused" ? (
      <PaneEmpty glyph={<FileQuestion size={20} />} title={filesErrorLine(root.error)} />
    ) : selected === null ? (
      <PaneEmpty glyph={<FileText size={20} />} title="Pick a file" />
    ) : null;

  return (
    <FocusSurface measure="workspace" height="immersive" label="Files" onClose={onClose}>
      <div {...drop.surface} className="files-body">
        {empty !== null || selected === null || root.state !== "ready" ? (
          <TwoPane sidebar={sidebar} sidebarLabel="Files" sidebarWidth="narrow" mainLabel="File">
            {empty ?? <PaneEmpty title="Opening the folder" />}
          </TwoPane>
        ) : (
          <SelectedFile key={selected} canvasName={canvasName} filesRef={ref} path={selected} sidebar={sidebar} save={save} onClose={onClose} />
        )}
        <FilesDropHighlight drop={drop} />
      </div>
    </FocusSurface>
  );
}

function SelectedFile({
  canvasName,
  filesRef,
  path,
  sidebar,
  save,
  onClose,
}: {
  readonly canvasName: string;
  readonly filesRef: FilesNodeRef;
  readonly path: FilePath;
  readonly sidebar: React.ReactNode;
  readonly save: React.MutableRefObject<(() => void) | null>;
  readonly onClose: () => void;
}) {
  const nodeId = filesRef.node;
  const [read, setRead] = useState<Loaded<FileRead>>({ state: "loading" });
  /** The file moved on disk under an unsaved draft: reload or keep. */
  const [stale, setStale] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const railOpen = commentsRailOpen(use$(sidebarSections$.open));
  useDraftsVersion();
  const draft = fileDraft(nodeId, path);

  const load = useCallback(async (): Promise<void> => {
    const result = await filesSource().read(filesRef, path);
    setRead(result.ok ? { state: "ready", value: result.value } : { state: "refused", error: result.error });
  }, [filesRef, path]);
  useEffect(() => {
    void load();
    return filesSource().onChange((event) => {
      if (!changeTouches(event, nodeId, path)) return;
      // A clean file follows the disk; a draft is the operator's until they choose.
      if (fileDraft(nodeId, path) === undefined) void load();
      else setStale(true);
    });
  }, [load, nodeId, path]);

  const text = read.state === "ready" && read.value.kind === "text" ? read.value : null;
  const edit = (next: string): void => {
    if (text === null) return;
    const base = fileDraft(nodeId, path)?.base ?? text.stamp;
    setFileDraft(nodeId, path, next === text.text && sameStamp(base, text.stamp) ? undefined : { text: next, base });
  };

  const write = async (body: string, base: FileStamp): Promise<void> => {
    setSaving(true);
    const result = await filesSource().write(filesRef, path, body, base);
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
    const fresh = await filesSource().read(filesRef, path);
    if (!fresh.ok) return setError(filesErrorLine(fresh.error));
    if (fresh.value.kind !== "text") return setError("This file is no longer text on disk.");
    await write(held.text, fresh.value.stamp);
  };
  const outside = async (open: "openInDefaultApp" | "revealInFinder"): Promise<void> => {
    const result = await filesSource()[open](filesRef, path);
    setError(result.ok ? null : filesErrorLine(result.error));
  };

  const view = read.state === "ready" ? fileViewOf(path, read.value) : null;
  const Glyph = VIEW_GLYPH[view ?? "other"];
  const name = baseName(path);
  const dir = path.slice(0, path.length - name.length);

  const body = (() => {
    if (read.state === "loading") return <PaneEmpty title="Opening" />;
    if (read.state === "refused") return <PaneEmpty glyph={<FileQuestion size={20} />} title={filesErrorLine(read.error)} />;
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
            label={name}
            surfaceLabel="File"
            value={draft?.text ?? value.text}
            onChange={edit}
          />
        ) : null;
      case "code":
        return value.kind === "text" ? <FileCodeEditor label={name} value={draft?.text ?? value.text} onChange={edit} /> : null;
      case "image":
        return (
          <div className="files-media">
            <img className="files-media__image" src={fileUrl(nodeId, path, value.kind === "binary" ? value.stamp.mtimeMs : undefined)} alt={name} />
          </div>
        );
      case "pdf":
        return <PaneEmpty glyph={<FileText size={20} />} title="A PDF" hint="Its preview opens here once the viewer lands." action={elsewhere} />;
      case "too-large":
        return (
          <PaneEmpty
            glyph={<FileQuestion size={20} />}
            title="Too large to open here"
            hint={value.kind === "too-large" ? `${formatSize(value.size)}, over the 5 MB Junto reads as text.` : undefined}
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
      mainLabel={name}
      rail={<FileRail canvasName={canvasName} nodeId={nodeId} path={path} open={railOpen} onClose={onClose} />}
      railLabel="Comments"
      railCollapsed={!railOpen}
    >
      <header className="files-head">
        <Glyph size={14} aria-hidden className="files-head__glyph" />
        <span className="files-head__path" title={path}>
          {dir === "" ? null : <span className="files-head__dir">{dir}</span>}
          <span className="files-head__name">{name}</span>
        </span>
        {draft !== undefined ? (
          <span className="files-head__unsaved" role="status">
            Unsaved
          </span>
        ) : null}
        {text !== null ? (
          <Button size="xs" variant={draft === undefined ? "subtle" : "primary"} disabled={draft === undefined || saving}
            aria-keyshortcuts={keyAria("files.save")}
            onClick={() => save.current?.()}>
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
          <CircleAlert size={14} aria-hidden />
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
function FileCodeEditor({ label, value, onChange }: { readonly label: string; readonly value: string; readonly onChange: (text: string) => void }) {
  return (
    <textarea
      className="files-code"
      aria-label={label}
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
  open,
  onClose,
}: {
  readonly canvasName: string;
  readonly nodeId: NodeId;
  readonly path: FilePath;
  readonly open: boolean;
  readonly onClose: () => void;
}) {
  const threads = useFileThreads(nodeId, path);
  const mentionable = useSeatsInReach(canvasName, nodeId);
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
