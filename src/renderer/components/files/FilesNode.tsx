import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { use$ } from "@legendapp/state/react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import type { FileTree as FileTreeModel, FileTreeRenameEvent, FileTreeRowDecorationRenderer } from "@pierre/trees";
import { CircleAlert, ExternalLink, Search, FileCode, FileQuestion, FileText, FolderSearch, Image, type LucideIcon } from "lucide-react";
import type { NodeId } from "@shared/physics/schema";
import { titleOf } from "@shared/model/title";
import { baseName, parentOf, parseFilePath, ROOT_PATH, sameStamp, type FilePath, type FileRead, type FilesNodeRef, type FileStamp } from "@shared/files";
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
  type FileView as FileViewKind,
  type Loaded,
} from "../../lib/files-source";
import { FocusSurface } from "../FocusSurface";
import { Button, IconButton, Input, PaneEmpty, PaneHeader, TwoPane } from "../ui";
import { ArtifactComments, ArtifactCommentsEdge } from "../artifacts/ArtifactComments";
import { LiveMarkdownField } from "../artifacts/LiveMarkdownField";
import { useSeatsInReach } from "../../lib/mention-sources";
import { openMention } from "../tasks/TaskThread";
import { commentsRailOpen, commentsRailRef, setCommentsRailOpen } from "../../lib/artifact-comments-rail";
import { sidebarSections$ } from "../../lib/sidebar-sections";
import { fileOfSelection, filePathOfTree, treePathOf, useFolderTree } from "./files-tree";
import { FILES_DROP_TREE_CSS, FilesDropHighlight } from "./FilesDropHighlight";
import { useFilesDrop } from "./useFilesDrop";
import { registerFileEditorSave } from "../../lib/file-editor-keys";
import { keyAria } from "../../lib/key-match";
import { fileQuickOpen } from "../../lib/quick-open";
import { useQuickOpen } from "../quick-open/use-quick-open";
import { FileView } from "../file-view/FileView";
import "../ui/file-tree.css";
import "./files.css";

const VIEW_GLYPH: Record<FileViewKind, LucideIcon> = {
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
  const [filter, setFilter] = useState("");
  /** A rename or move the folder refused, said under the filter. */
  const [treeError, setTreeError] = useState<string | null>(null);
  /** The tree's model, for the rename callback the tree is built with. */
  const modelRef = useRef<FileTreeModel | null>(null);
  const rename = async (event: FileTreeRenameEvent): Promise<void> => {
    const from = filePathOfTree(event.sourcePath);
    const to = filePathOfTree(event.destinationPath);
    if (from === undefined || to === undefined || from === to) return;
    const result = await filesSource().rename(ref, from, baseName(to));
    if (!result.ok) {
      // The tree renamed the row as the operator typed; put it back.
      modelRef.current?.move(event.destinationPath, event.sourcePath);
      setTreeError(filesErrorLine(result.error));
      return;
    }
    setTreeError(null);
    const moved = (path: FilePath): FilePath | undefined =>
      path === from ? result.value : path.startsWith(`${from}/`) ? (parseFilePath(`${result.value}${path.slice(from.length)}`) ?? undefined) : undefined;
    // Unsaved text and the open file follow the new name.
    for (const path of dirtyPaths(nodeId)) {
      const next = moved(path);
      if (next === undefined) continue;
      setFileDraft(nodeId, next, fileDraft(nodeId, path));
      setFileDraft(nodeId, path, undefined);
    }
    setSelected((open) => (open === null ? open : (moved(open) ?? open)));
  };
  const drop = useFilesDrop({ port: filesSource(), node: ref, describe: filesErrorLine, rootLabel: folderName });
  const { model } = useFileTree({
    paths: [],
    dragAndDrop: drop.treeDragAndDrop,
    unsafeCSS: FILES_DROP_TREE_CSS,
    initialExpansion: "closed",
    ...(initialPath === undefined ? {} : { initialExpandedPaths: ancestorsOf(initialPath), initialSelectedPaths: [initialPath] }),
    // The tree's own search box sits inside role=tree, which admits only rows; the filter above it drives setSearch.
    search: false,
    renaming: { onRename: (event) => void rename(event), onError: setTreeError },
    itemHeight: 28,
    onSelectionChange: (paths) => {
      const file = fileOfSelection(paths);
      if (file !== null) setSelected(file);
    },
    renderRowDecoration: decorate,
  });
  modelRef.current = model;
  useFolderTree(ref, model, root.state === "ready");
  useEffect(() => {
    drop.bindModel(model);
    return () => drop.bindModel(null);
  }, [drop.bindModel, model]);
  useEffect(() => {
    // Redraw the rows so the unsaved marks follow the drafts.
    model.setComposition(model.getComposition());
  }, [model, draftsVersion]);

  /** A pick in the palette opens that file in the main pane and brings its row into view. */
  const quickOpen = useQuickOpen({
    nodeId,
    enabled: root.state === "ready",
    source: useMemo(
      () =>
        fileQuickOpen({
          canvas: canvasName,
          node: nodeId,
          search: (target, query, seq) => filesSource().search(target, query, seq),
        }),
      [canvasName, nodeId],
    ),
    onOpen: (item) => {
      const path = parseFilePath(item.id);
      if (path === undefined || path === ROOT_PATH) return;
      setSelected(path);
      model.scrollToPath(treePathOf({ path, dir: false }), { offset: "nearest" });
    },
  });

  const sidebar = (
    <>
      <PaneHeader
        eyebrow={<span className="files-eyebrow">{folderName}</span>}
        actions={
          <>
            {quickOpen.trigger}
            <IconButton
              aria-label="Reveal folder in Finder"
              title="Reveal folder in Finder"
              size="sm"
              disabled={root.state !== "ready"}
              onClick={() =>
                void filesSource()
                  .revealInFinder(ref, ROOT_PATH)
                  .then((result) => setTreeError(result.ok ? null : filesErrorLine(result.error)))
              }
            >
              <FolderSearch size={14} />
            </IconButton>
          </>
        }
      />
      <label className="files-filter">
        <Search size={12} aria-hidden />
        <Input
          dense
          aria-label={`Filter files in ${folderName}`}
          placeholder="Filter"
          value={filter}
          onChange={(event) => {
            setFilter(event.target.value);
            model.setSearch(event.target.value === "" ? null : event.target.value);
          }}
        />
      </label>
      {treeError ? (
        <p className="files-error" role="alert">
          <CircleAlert size={14} aria-hidden />
          {treeError}
        </p>
      ) : null}
      <FilesTree model={model} label={`Files in ${folderName}`} />
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
      {quickOpen.palette}
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
    // Main opens nothing that would run (a script, an app, an executable): say that, not a read refusal.
    setError(result.ok ? null : open === "openInDefaultApp" && result.error === "denied" ? RUNS_LINE : filesErrorLine(result.error));
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
      case "pdf":
      case "other":
        return <FileView canvasName={canvasName} nodeId={nodeId} path={path} {...(value.kind === "binary" ? { version: value.stamp.mtimeMs } : {})} />;
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
        return null;
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
 * The tree, named. The library draws role=tree inside its shadow root, where
 * an aria-label on the host never reaches; until it takes a label of its own,
 * the name is set on the inner tree once it renders (a workaround, for
 * product-accessibility's review), and the nav names the region around it.
 */
function FilesTree({ model, label }: { readonly model: FileTreeModel; readonly label: string }) {
  const wrap = useRef<HTMLElement>(null);
  useEffect(() => {
    const host = wrap.current?.querySelector("file-tree-container");
    const shadow = host?.shadowRoot;
    if (shadow == null) return;
    const name = (): void => {
      const tree = shadow.querySelector('[role="tree"]');
      if (tree !== null && tree.getAttribute("aria-label") !== label) tree.setAttribute("aria-label", label);
    };
    name();
    const observer = new MutationObserver(name);
    observer.observe(shadow, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [label]);
  return (
    <nav ref={wrap} className="files-tree-nav" aria-label={label}>
      <FileTree model={model} className="files-tree" />
    </nav>
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

const RUNS_LINE = "Junto does not open programs or scripts. Reveal it in Finder instead.";

const formatSize = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
