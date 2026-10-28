import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileTree, useFileTree } from "@pierre/trees/react";
import type { FileTree as FileTreeModel, FileTreeRenameEvent, FileTreeRowDecorationRenderer } from "@pierre/trees";
import { CircleAlert, ExternalLink, Search, FileCode, FileQuestion, FileText, FolderSearch, Image, type LucideIcon } from "lucide-react";
import type { NodeId } from "@shared/physics/schema";
import type { FilePlaceAnchor } from "@shared/thread-subject";
import { titleOf } from "@shared/model/title";
import { baseName, parentOf, parseFilePath, ROOT_PATH, sameStamp, type FilePath, type FileRead, type FilesNodeRef, type FileStamp } from "@shared/files";
import { nodeAt, useNode } from "../../lib/use-model";
import { useFollowOpen } from "../../lib/work-detail-open";
import {
  changeTouches,
  dirtyPaths,
  fileDraft,
  filesErrorLine,
  filesSource,
  fileViewOf,
  setFileDraft,
  useDraftsVersion,
  useFilesRoot,
  type FileView as FileViewKind,
  type Loaded,
} from "../../lib/files-source";
import { useSubjectThreads, type SubjectThread } from "../../lib/subject-threads-source";
import { boxAnchorOf, filePlaceOf, lineAnchorOf, lineDraftOf, placeLabel, placedFileThreads, type LineDraft } from "../../lib/file-comments";
import { FileCommentsRail, FileThreadRow, type FileCommentContext } from "./FileComments";
import { FocusSurface } from "../FocusSurface";
import { Button, IconButton, Input, PaneEmpty, PaneHeader, TwoPane } from "../ui";
import { ArtifactCommentsEdge } from "../artifacts/ArtifactComments";
import { LiveMarkdownField, type LiveMarkdownFieldHandle } from "../artifacts/LiveMarkdownField";
import { useSeatsInReach } from "../../lib/mention-sources";
import { openMention } from "../tasks/TaskThread";
import { commentsRailRef, setCommentsRailOpen, useCommentsRailOpen } from "../../lib/artifact-comments-rail";
import { fileOfSelection, filePathOfTree, movedPath, treePathOf, useFolderTree } from "./files-tree";
import { FILES_DROP_TREE_CSS, FilesDropHighlight } from "./FilesDropHighlight";
import { useFilesDrop, type FilesMoved } from "./useFilesDrop";
import { registerFileEditorSave } from "../../lib/file-editor-keys";
import { keyAria } from "../../lib/key-match";
import { fileQuickOpen } from "../../lib/quick-open";
import { useQuickOpen } from "../quick-open/use-quick-open";
import { FileView } from "../file-view/FileView";
import { CodeEditor, type CodeEditorHandle, type LineRow } from "../ui/CodeEditor";
import { claimFocus } from "../../lib/focus-ownership";
import { paneEntryOf } from "../../lib/pane-focus";
import { topModal } from "../../lib/modal-stack";
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
  initialPage,
  openKey,
  onClose,
}: {
  readonly canvasName: string;
  readonly nodeId: NodeId;
  readonly initialPath?: FilePath;
  /** A PDF at `initialPath` opens scrolled to this page, once (an extract's link back to its source). */
  readonly initialPage?: number;
  /** Which open this is: a new one lands on `initialPath` and its page again, though the operator moved on. */
  readonly openKey?: number;
  readonly onClose: () => void;
}) {
  const ref = useMemo<FilesNodeRef>(() => ({ canvas: canvasName, node: nodeId }), [canvasName, nodeId]);
  // Read live: the folder reopens when the node's host or root changes under the open modal.
  const node = useNode(canvasName, nodeId);
  const root = useFilesRoot(ref, node?.kind === "files" ? `${node.host}\u0000${node.root}` : "");
  const [selected, setSelected] = useState<FilePath | null>(initialPath ?? null);
  /** The page an extract's link named, until the operator leaves that file: coming back opens it where they left. */
  const [pageOnce, setPageOnce] = useState(initialPage);
  useEffect(() => {
    if (selected !== initialPath) setPageOnce(undefined);
  }, [selected, initialPath]);
  // An open while the modal is up, a link followed from inside it, lands on its file and page.
  useFollowOpen(initialPath, openKey, (path) => {
    setSelected(path);
    setPageOnce(initialPage);
  });
  const draftsVersion = useDraftsVersion();
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
    follow([{ from, to: result.value }]);
  };
  /** Unsaved text and the open file follow a rename or a move, a folder's everything under it; the open file's new path, or null. */
  const follow = (moves: ReadonlyArray<{ readonly from: FilePath; readonly to: FilePath }>): FilePath | null => {
    const moved = (path: FilePath): FilePath | undefined => movedPath(moves, path);
    for (const path of dirtyPaths(nodeId)) {
      const next = moved(path);
      if (next === undefined) continue;
      setFileDraft(nodeId, next, fileDraft(nodeId, path));
      setFileDraft(nodeId, path, undefined);
    }
    const open = selectedRef.current === null ? null : (moved(selectedRef.current) ?? selectedRef.current);
    if (open !== selectedRef.current) setSelected(open);
    return open;
  };
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const followRef = useRef(follow);
  followRef.current = follow;
  /**
   * After a tree drag the open file follows what moved, and the highlight goes
   * back to it, or to nothing: a drag never opens one.
   */
  const reselectOpenFile = useCallback((moves: ReadonlyArray<FilesMoved>) => {
    const after = followRef.current(moves);
    const tree = modelRef.current;
    if (tree === null) return;
    const open = after === null ? null : treePathOf({ path: after, dir: false });
    for (const path of tree.getSelectedPaths()) if (path !== open) tree.getItem(path)?.deselect();
    // The tree's own selection, not DOM focus: the keyboard stays where the drag left it.
    const item = open === null ? undefined : tree.getItem(open);
    if (item !== undefined && item !== null && !item.isSelected()) item.toggleSelect();
  }, []);
  const drop = useFilesDrop({
    port: filesSource(),
    node: ref,
    describe: filesErrorLine,
    rootLabel: folderName,
    onTreeDragEnd: reselectOpenFile,
  });
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
      // The row a tree drag starts on is selected; opening it would remount the tree and end the drag.
      if (drop.isTreeDragging()) return;
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
        actions={quickOpen.trigger}
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
      // The folder cannot open: said as an alert, so a reader hears why the tree is empty.
      <div role="alert" className="files-refused">
        <PaneEmpty glyph={<FileQuestion size={20} />} title={filesErrorLine(root.error)} />
      </div>
    ) : selected === null ? (
      <PaneEmpty
        glyph={<FileText size={20} />}
        title="Pick a file"
        action={
          // The folder itself opens in Finder from here; the header keeps its width for the folder's name.
          <Button
            size="sm"
            variant="subtle"
            onClick={() =>
              void filesSource()
                .revealInFinder(ref, ROOT_PATH)
                .then((result) => setTreeError(result.ok ? null : filesErrorLine(result.error)))
            }
          >
            Reveal folder in Finder
          </Button>
        }
      />
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
          <SelectedFile
            // A named page is jumped to once per mount: a new open naming one mounts the file afresh.
            key={pageOnce === undefined || selected !== initialPath ? selected : `${selected}#${String(openKey ?? 0)}`}
            canvasName={canvasName}
            filesRef={ref}
            path={selected}
            {...(pageOnce !== undefined && selected === initialPath ? { initialPage: pageOnce } : {})}
            sidebar={sidebar}
            save={save}
            onClose={onClose}
          />
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
  initialPage,
  sidebar,
  save,
  onClose,
}: {
  readonly canvasName: string;
  readonly filesRef: FilesNodeRef;
  readonly path: FilePath;
  readonly initialPage?: number;
  readonly sidebar: React.ReactNode;
  readonly save: React.MutableRefObject<(() => void) | null>;
  readonly onClose: () => void;
}) {
  const nodeId = filesRef.node;
  const [read, setRead] = useState<Loaded<FileRead>>({ state: "loading" });
  /** The stamp of the first read: the viewer remounts on a change on disk, and the named page is for the first one only. */
  const firstStamp = useRef<number | null>(null);
  if (firstStamp.current === null && read.state === "ready") firstStamp.current = read.value.stamp.mtimeMs;
  /** The file changed on disk under an unsaved draft (reload or keep), or was deleted (write it back or discard). */
  const [stale, setStale] = useState<false | "changed" | "deleted">(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const railOpen = useCommentsRailOpen();
  useDraftsVersion();
  const draft = fileDraft(nodeId, path);
  /** The place a press in the gutter or a drawn box picked, waiting for its comment. */
  const [lineDraft, setLineDraft] = useState<LineDraft | null>(null);
  const [boxDraft, setBoxDraft] = useState<{ readonly page: number; readonly x: number; readonly y: number; readonly w: number; readonly h: number } | null>(null);
  const editor = useRef<CodeEditorHandle>(null);
  const markdownEditor = useRef<LiveMarkdownFieldHandle>(null);

  /** Bumped by a read from disk only, so a save never remounts the editor under the caret. */
  const [epoch, setEpoch] = useState(0);
  const load = useCallback(async (): Promise<FileRead | null> => {
    const result = await filesSource().read(filesRef, path);
    setRead(result.ok ? { state: "ready", value: result.value } : { state: "refused", error: result.error });
    setEpoch((last) => last + 1);
    return result.ok ? result.value : null;
  }, [filesRef, path]);
  useEffect(() => {
    // A draft held while the modal was closed may be on a version the disk has since left: say so on open, not at Save.
    void load().then((now) => {
      const held = fileDraft(nodeId, path);
      if (now !== null && held !== undefined && !sameStamp(held.base, now.stamp)) setStale("changed");
    });
    return filesSource().onChange((event) => {
      if (!changeTouches(event, nodeId, path)) return;
      // A clean file follows the disk; a draft is the operator's until they choose.
      if (fileDraft(nodeId, path) === undefined) void load();
      else void filesSource()
        .read(filesRef, path)
        .then((now) => setStale(!now.ok && now.error === "not-found" ? "deleted" : "changed"));
    });
  }, [load, filesRef, nodeId, path]);

  /** The bar or the control pressed just went away: the keyboard goes back to the file. */
  const backToFile = (): void => {
    requestAnimationFrame(() => {
      const main = topModal()?.container()?.querySelector<HTMLElement>(".two-pane > .two-pane__main");
      claimFocus(main ? paneEntryOf(main) : null, "gesture");
    });
  };

  const text = read.state === "ready" && read.value.kind === "text" ? read.value : null;
  const edit = (next: string): void => {
    if (text === null) return;
    const base = fileDraft(nodeId, path)?.base ?? text.stamp;
    setFileDraft(nodeId, path, next === text.text && sameStamp(base, text.stamp) ? undefined : { text: next, base });
  };

  /** A write in flight; a second Cmd+S waits for it rather than racing it. */
  const writing = useRef(false);
  const write = async (body: string, base: FileStamp | null): Promise<boolean> => {
    writing.current = true;
    setSaving(true);
    const result = await filesSource().write(filesRef, path, body, base);
    writing.current = false;
    setSaving(false);
    if (result.ok) {
      // Text typed while the write was out is still unsaved: it stays, on the new version.
      const now = fileDraft(nodeId, path);
      setFileDraft(nodeId, path, now === undefined || now.text === body ? undefined : { text: now.text, base: result.value });
      setRead({ state: "ready", value: { kind: "text", text: body, stamp: result.value } });
      setStale(false);
      setError(null);
      return true;
    }
    // Something is at the path again since it was deleted: that is a change on disk, reload or keep.
    if (result.error === "stale" || (base === null && result.error === "exists")) setStale("changed");
    else if (result.error === "not-found" && base !== null) setStale("deleted");
    else setError(filesErrorLine(result.error));
    return false;
  };
  useEffect(() => {
    save.current = () => {
      const held = fileDraft(nodeId, path);
      // A file deleted under its draft is written back at its path.
      if (held !== undefined && !writing.current) void write(held.text, stale === "deleted" ? null : held.base);
    };
    return () => {
      save.current = null;
    };
  });

  /** Drop the draft for what is on disk; a file that is gone keeps the draft and says so. */
  const reload = async (): Promise<void> => {
    const fresh = await load();
    if (fresh === null) return;
    setFileDraft(nodeId, path, undefined);
    setStale(false);
    backToFile();
  };
  /** Drop the draft of a deleted file: the pane says the file is gone. */
  const discard = async (): Promise<void> => {
    setFileDraft(nodeId, path, undefined);
    setStale(false);
    await load();
    backToFile();
  };
  /** Keep the draft: write it over what is on disk now. */
  const keep = async (): Promise<void> => {
    const held = fileDraft(nodeId, path);
    if (held === undefined) return setStale(false);
    const fresh = await filesSource().read(filesRef, path);
    if (!fresh.ok) return setError(filesErrorLine(fresh.error));
    if (fresh.value.kind !== "text") return setError("This file is no longer text on disk.");
    if (await write(held.text, fresh.value.stamp)) backToFile();
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

  // The file's threads, read where every pane reads them, and placed in the
  // text on screen: a draft the operator is typing is the text the rows follow.
  const threads = useSubjectThreads(canvasName, { kind: "file", nodeId, path });
  const shownText = draft?.text ?? text?.text ?? "";
  const placed = useMemo(() => placedFileThreads(threads, shownText), [threads, shownText]);
  const mentionable = useSeatsInReach(canvasName, nodeId);
  const commentContext = {
    canvasName,
    nodeId,
    path,
    text: shownText,
    paged: view === "pdf",
    now: Date.now(),
    seatName: (id: string): string | undefined => {
      const seat = nodeAt(canvasName, id);
      return seat === undefined ? undefined : titleOf(seat);
    },
    mentionable,
    nodeKindOf: (id: NodeId) => nodeAt(canvasName, id)?.kind,
    onOpenMention: (mention: Parameters<typeof openMention>[0]) => {
      onClose();
      openMention(mention);
    },
    onReveal: (place: ReturnType<typeof filePlaceOf>) => reveal(place),
  };
  /** The place a press picked: a box drawn on a page, else the gutter's lines. */
  const draftAnchor = boxDraft !== null ? boxAnchorOf(boxDraft) : lineDraft !== null ? lineAnchorOf(path, lineDraft) : undefined;
  const pickLines = (range: LineDraft): void => {
    setBoxDraft(null);
    setLineDraft(range);
    setCommentsRailOpen(true);
  };
  const pickBox = (comment: { readonly page?: number; readonly box: { readonly x: number; readonly y: number; readonly w: number; readonly h: number } }): void => {
    setLineDraft(null);
    setBoxDraft({ page: comment.page ?? 1, ...comment.box });
    // A first box opens the rail; nudging a drawn one with the arrow keys does
    // not reopen a rail the operator shut.
    if (boxDraft === null) setCommentsRailOpen(true);
  };
  const spent = (): void => {
    setLineDraft(null);
    setBoxDraft(null);
  };
  const reveal = (place: ReturnType<typeof filePlaceOf>): void => {
    setCommentsRailOpen(true);
    if (place.kind !== "lines") return;
    // Whichever editor the file opened in: markdown text and code take the same reveal.
    (markdownEditor.current ?? editor.current)?.revealLine(place.from);
  };
  const rows: ReadonlyArray<LineRow> = placed.flatMap(({ thread, place }) =>
    place.kind === "lines" ? [{ key: `thread:${thread.threadId}`, line: place.to }] : [],
  );
  const renderRow = (key: string): React.ReactNode => {
    const found = placed.find((entry) => key === `thread:${entry.thread.threadId}`);
    if (found === undefined) return null;
    return <FileThreadRow thread={found.thread} place={found.place} onOpen={() => reveal(found.place)} />;
  };
  /** The threads whose place is a box on the page showing now: the viewer draws them. */
  const boxThreads = placed.flatMap(({ thread, place }) =>
    place.kind === "box"
      ? [
          {
            id: thread.threadId,
            ...(view === "image" ? {} : { page: place.anchor.page }),
            box: { x: place.anchor.x, y: place.anchor.y, w: place.anchor.w, h: place.anchor.h },
            label: placeLabel(place, view === "pdf"),
          },
        ]
      : [],
  );

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
            key={epoch}
            className="files-markdown"
            label={name}
            surfaceLabel="File"
            value={draft?.text ?? value.text}
            onChange={edit}
            handle={markdownEditor}
            onLineComment={(range) => {
              const picked = lineDraftOf(range);
              if (picked !== undefined) pickLines(picked);
            }}
            rows={rows}
            renderRow={renderRow}
          />
        ) : null;
      case "code":
        return value.kind === "text" ? (
          <CodeEditor
            key={epoch}
            className="files-code"
            path={path}
            value={draft?.text ?? value.text}
            onChange={edit}
            handle={editor}
            onLineComment={(range) => {
              const picked = lineDraftOf(range);
              if (picked !== undefined) pickLines(picked);
            }}
            rows={rows}
            renderRow={renderRow}
          />
        ) : null;
      case "image":
      case "pdf":
      case "other":
        return (
          <FileView
            canvasName={canvasName}
            nodeId={nodeId}
            path={path}
            boxes={boxThreads}
            onDraft={(drawn) => {
              // Null is the box going away (discarded, commented, extracted): the composer lets it go too.
              if (drawn === null) setBoxDraft(null);
              else pickBox(drawn);
            }}
            {...(initialPage === undefined || value.stamp.mtimeMs !== firstStamp.current ? {} : { initialPage })}
            // Every read carries its stamp: a PDF read as text or too large reloads on a change too.
            version={value.stamp.mtimeMs}
          />
        );
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
      rail={
        <FileRail
          context={commentContext}
          threads={threads}
          draftAnchor={draftAnchor}
          open={railOpen}
          onPosted={spent}
          onClose={onClose}
        />
      }
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
          <Button
            size="xs"
            variant={draft === undefined ? "subtle" : "primary"}
            // Not disabled: a control that disables under its own press drops the keyboard.
            aria-disabled={draft === undefined || saving}
            aria-keyshortcuts={keyAria("files.save")}
            onClick={() => save.current?.()}
          >
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
      {stale === "changed" ? (
        <div className="files-stale" role="alert">
          <span>{filesErrorLine("stale")}</span>
          <Button size="xs" variant="chrome" onClick={() => void reload()}>
            Reload from disk
          </Button>
          <Button size="xs" variant="primary" onClick={() => void keep()}>
            Keep mine
          </Button>
        </div>
      ) : stale === "deleted" ? (
        <div className="files-stale" role="alert">
          <span>{DELETED_LINE}</span>
          <Button size="xs" variant="chrome" onClick={() => void discard()}>
            Discard
          </Button>
          <Button
            size="xs"
            variant="primary"
            onClick={() => {
              const held = fileDraft(nodeId, path);
              if (held !== undefined && !writing.current) void write(held.text, null).then((saved) => saved && backToFile());
            }}
          >
            Save it again
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
 * The file's comments rail: the comments pane while it is open, and the thin
 * edge that says how many there are while it is shut.
 */
function FileRail({
  context,
  threads,
  draftAnchor,
  open,
  onPosted,
  onClose,
}: {
  readonly context: FileCommentContext;
  readonly threads: ReadonlyArray<SubjectThread>;
  readonly draftAnchor: FilePlaceAnchor | undefined;
  readonly open: boolean;
  readonly onPosted: () => void;
  readonly onClose: () => void;
}) {
  const ref = useCallback((element: HTMLDivElement | null) => commentsRailRef(element), []);
  return (
    <div className="files-rail" ref={ref}>
      {open ? (
        <FileCommentsRail
          context={context}
          threads={threads}
          draft={draftAnchor}
          onPosted={onPosted}
          onCleared={onPosted}
          onClose={() => setCommentsRailOpen(false)}
        />
      ) : (
        <ArtifactCommentsEdge threads={threads} seatName={context.seatName} onOpen={() => setCommentsRailOpen(true)} />
      )}
    </div>
  );
}

const RUNS_LINE = "Junto does not open programs or scripts. Reveal it in Finder instead.";
const DELETED_LINE = "This file was deleted on disk. Your changes are still here.";

const formatSize = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
