import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FileTree, useFileTree } from "@pierre/trees/react";
import type { FileTree as FileTreeModel, FileTreeRenameEvent, FileTreeRowDecorationRenderer } from "@pierre/trees";
import { CircleAlert, ExternalLink, Search, FileCode, FilePlus, FileQuestion, FileText, FolderInput, FolderPlus, FolderSearch, Image, Pencil, Trash2, type LucideIcon } from "lucide-react";
import type { NodeId } from "@shared/physics/schema";
import type { FilePlaceAnchor } from "@shared/thread-subject";
import { titleOf } from "@shared/model/title";
import { baseName, parentOf, parseFilePath, ROOT_PATH, sameStamp, type FilePath, type FileRead, type FilesNodeRef, type FilesResult, type FileStamp } from "@shared/files";
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
  unreachableLine,
  useDraftsVersion,
  useFilesRoot,
  useMinuteNow,
  type FileView as FileViewKind,
  type Loaded,
} from "../../lib/files-source";
import { machineLabel, onThisMachine } from "../../lib/machines";
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
import { useFilesNodeView } from "../../lib/node-view-state";
import { expandedAfter, fileOfSelection, filePathOfTree, movedPath, treePathOf, useFolderTree } from "./files-tree";
import { FILES_DROP_TREE_CSS, FilesDropHighlight } from "./FilesDropHighlight";
import { useFilesDrop, type FilesMoved } from "./useFilesDrop";
import { folderLabel, FilesCreateDialog, FilesMoveDialog, FilesRowMenu, FilesTrashDialog } from "./FilesActions";
import { focusRowWhenShown, isWithin, rowOf, type FilesAction } from "./files-actions";
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
  const kept = useFilesNodeView(canvasName, nodeId);
  const keptRef = useRef(kept);
  keptRef.current = kept;
  /** How the node opens: on the file asked for, else the one it had open, with the folders it had expanded (0.11, 04, V3). */
  const [opening] = useState(() => {
    const open = initialPath ?? parseFilePath(kept.open) ?? null;
    const folders = kept.expanded.flatMap((dir) => {
      const path = parseFilePath(dir);
      return path === undefined || path === ROOT_PATH ? [] : [treePathOf({ path, dir: true })];
    });
    const expanded = [...new Set([...folders, ...(open === null ? [] : ancestorsOf(open))])];
    return { open, expanded };
  });
  const [selected, setSelected] = useState<FilePath | null>(opening.open);
  useEffect(() => {
    keptRef.current.setOpen(selected);
  }, [selected]);
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
  /** Open in default app and Reveal in Finder act on this screen: another machine's node offers neither. */
  const here = node?.kind !== "files" || onThisMachine(node.host);
  /** Its machine cannot be reached: the node says so and shows no tree, nothing stale (0.12, X2). */
  const offline = root.state === "refused" ? root.offline : undefined;
  const now = useMinuteNow(offline !== undefined);

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
  /** What the last create, move or trash did, said under the filter. */
  const [treeNote, setTreeNote] = useState<string | null>(null);
  /** The dialog a row's menu, a header button or a key opened, and the row the keyboard goes back to on Cancel. */
  const [acting, setActing] = useState<{ readonly action: FilesAction; readonly back: { readonly path: FilePath; readonly dir: boolean } | null } | null>(null);
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
  // A rename made outside Junto, which main paired by file id: the open file and its draft follow it as they follow one made here.
  useEffect(
    () =>
      filesSource().onChange((event) => {
        if (event.node === nodeId && event.kind === "paths" && event.moves !== undefined) followRef.current(event.moves);
      }),
    [nodeId],
  );
  /**
   * After a tree drag the open file follows what moved, and the highlight goes
   * back to it, or to nothing: a drag never opens one.
   */
  const reselectOpenFile = useCallback((moves: ReadonlyArray<FilesMoved>) => {
    selectInTree(followRef.current(moves));
  }, []);
  /**
   * The tree's selection set to the open file, or to nothing, so a press on a
   * row that was selected before still opens it. The tree's own selection,
   * not DOM focus: the keyboard stays where it is.
   */
  const selectInTree = (after: FilePath | null): void => {
    const tree = modelRef.current;
    if (tree === null) return;
    const open = after === null ? null : treePathOf({ path: after, dir: false });
    for (const path of tree.getSelectedPaths()) if (path !== open) tree.getItem(path)?.deselect();
    const item = open === null ? undefined : tree.getItem(open);
    if (item !== undefined && item !== null && !item.isSelected()) item.toggleSelect();
  };
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
    initialExpandedPaths: opening.expanded,
    ...(opening.open === null ? {} : { initialSelectedPaths: [opening.open] }),
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
  // The tree lists a folder only once it is shown, and drops an expansion it
  // was handed before that, so each folder the node opens with is expanded as
  // its row first shows. From then on the folders the operator expands and
  // collapses are kept with the node.
  useEffect(() => {
    const unopened = new Set(opening.expanded);
    return model.subscribe(() => {
      let rows = model.getVisibleRows(0, model.getVisibleCount());
      let opened = false;
      for (const row of rows) {
        if (row.kind !== "directory" || !unopened.delete(row.path) || row.isExpanded) continue;
        const item = model.getItem(row.path);
        if (item !== null && item !== undefined && "expand" in item) {
          item.expand();
          opened = true;
        }
      }
      if (opened) rows = model.getVisibleRows(0, model.getVisibleCount());
      keptRef.current.setExpanded(expandedAfter(keptRef.current.expanded, rows));
    });
  }, [model, opening]);
  useEffect(() => {
    drop.bindModel(model);
    return () => drop.bindModel(null);
  }, [drop.bindModel, model]);
  useEffect(() => {
    // Redraw the rows so the unsaved marks follow the drafts.
    model.setComposition(model.getComposition());
  }, [model, draftsVersion]);

  /** Open a create, move or trash dialog; the keyboard comes back to `back`'s row if it is cancelled. */
  const act = (action: FilesAction, back: { readonly path: FilePath; readonly dir: boolean } | null): void => {
    setTreeError(null);
    setTreeNote(null);
    setActing({ action, back });
  };
  /** The focused row, else the open file: what a header button acts on. */
  const focusedRow = (): { readonly path: FilePath; readonly dir: boolean } | null =>
    rowOf(model.getFocusedPath()) ?? (selectedRef.current === null ? null : { path: selectedRef.current, dir: false });
  /**
   * The sidebar's New file and New folder make it at the root: once the pointer
   * is on the button the tree shows no focus, so a folder taken from it would be
   * one the operator cannot see. A row's menu makes it beside that row.
   */
  const startCreate = (dir: boolean): void => act({ kind: "create", dir, into: ROOT_PATH }, focusedRow());
  const startRename = (treePath: string): void => {
    if (model.startRenaming(treePath)) return;
    setTreeError("That row cannot be renamed now.");
    // The menu closed without taking focus back, for the rename field: give it to the row.
    focusRowWhenShown(model, rowOf(treePath) ?? null);
  };
  const actOnRow = (row: { readonly path: FilePath; readonly dir: boolean }, kind: "move" | "trash"): void => act({ kind, ...row }, row);
  /** Delete or Cmd+Backspace on a focused row asks to move it to the Trash, as the menu does. */
  const treeKeys = (event: React.KeyboardEvent<HTMLElement>): void => {
    const trash = event.key === "Delete" || (event.key === "Backspace" && event.metaKey);
    if (!trash || event.altKey || event.ctrlKey || event.shiftKey) return;
    const origin = event.nativeEvent.composedPath()[0];
    if (!(origin instanceof HTMLElement) || origin.getAttribute("role") !== "treeitem") return;
    const row = rowOf(origin.dataset.itemPath);
    if (row === undefined) return;
    event.preventDefault();
    // The canvas binds Delete on the document and would ask to delete the card under the modal.
    event.stopPropagation();
    actOnRow(row, "trash");
  };
  /**
   * The tree takes what the folder did at once, as a drag's move does; the
   * watch's re-list after finds it already so.
   */
  const shownNow = (op: () => void): void => {
    try {
      op();
    } catch {
      // Already so.
    }
  };
  /** The row the keyboard goes to once the dialog is gone; undefined while there is none to land. */
  const landOn = useRef<{ readonly path: FilePath; readonly dir: boolean } | null | undefined>(undefined);
  const settle = (focus: { readonly path: FilePath; readonly dir: boolean } | null, note: string | null): void => {
    landOn.current = focus;
    setActing(null);
    setTreeNote(note);
  };
  // After the dialog unmounted: its own cleanup gives focus back to its opener, and this comes after it.
  useEffect(() => {
    if (acting !== null || landOn.current === undefined) return;
    const focus = landOn.current;
    landOn.current = undefined;
    return focusRowWhenShown(model, focus);
  }, [acting, model]);
  /** The row after `path` that a trash leaves, else the one before: where the keyboard goes. */
  const rowAfterTrash = (path: FilePath): { readonly path: FilePath; readonly dir: boolean } | null => {
    const rows = model.getVisibleRows(0, model.getVisibleCount());
    const at = rows.findIndex((row) => rowOf(row.path)?.path === path);
    const outside = (row: (typeof rows)[number] | undefined) => {
      const entry = rowOf(row?.path);
      return entry !== undefined && !isWithin(entry.path, path) ? entry : undefined;
    };
    for (let next = at + 1; at >= 0 && next < rows.length; next += 1) {
      const entry = outside(rows[next]);
      if (entry !== undefined) return entry;
    }
    for (let back = at - 1; back >= 0; back -= 1) {
      const entry = outside(rows[back]);
      if (entry !== undefined) return entry;
    }
    return null;
  };
  const dialog = (() => {
    if (acting === null) return null;
    const { action, back } = acting;
    const cancel = (): void => settle(back, null);
    switch (action.kind) {
      case "create":
        return (
          <FilesCreateDialog
            filesRef={ref}
            action={action}
            rootName={folderName}
            onCancel={cancel}
            onDone={(made) => {
              shownNow(() => model.add(treePathOf(made)));
              if (!made.dir) {
                setSelected(made.path);
                selectInTree(made.path);
              }
              settle(made, `Made ${baseName(made.path)} in ${folderLabel(action.into, folderName)}.`);
            }}
          />
        );
      case "move":
        return (
          <FilesMoveDialog
            filesRef={ref}
            action={action}
            rootName={folderName}
            onCancel={cancel}
            onDone={(moved) => {
              shownNow(() => model.move(treePathOf({ path: moved.from, dir: moved.dir }), treePathOf({ path: moved.to, dir: moved.dir })));
              follow([{ from: moved.from, to: moved.to }]);
              settle({ path: moved.to, dir: moved.dir }, `Moved ${baseName(moved.to)} to ${folderLabel(parentOf(moved.to), folderName)}.`);
            }}
          />
        );
      case "trash":
        return (
          <FilesTrashDialog
            filesRef={ref}
            action={action}
            onCancel={cancel}
            onDone={(gone) => {
              // Asked and confirmed: unsaved text under it goes with it.
              for (const path of dirtyPaths(nodeId)) if (isWithin(path, gone.path)) setFileDraft(nodeId, path, undefined);
              if (selectedRef.current !== null && isWithin(selectedRef.current, gone.path)) {
                setSelected(null);
                selectInTree(null);
              }
              const next = rowAfterTrash(gone.path);
              shownNow(() => model.remove(treePathOf(gone), { recursive: gone.dir }));
              settle(next, `${baseName(gone.path)} is in the Trash.`);
            }}
          />
        );
    }
  })();

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
      {offline !== undefined ? null : (
        <>
          {/* New file and New folder sit by the filter, so the header keeps its width for the folder's name. */}
          <div className="files-filter">
            <label className="files-filter__field">
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
            <IconButton aria-label="New file" title="New file" size="sm" onClick={() => startCreate(false)}>
              <FilePlus size={14} />
            </IconButton>
            <IconButton aria-label="New folder" title="New folder" size="sm" onClick={() => startCreate(true)}>
              <FolderPlus size={14} />
            </IconButton>
          </div>
          {treeError ? (
            <p className="files-error" role="alert">
              <CircleAlert size={14} aria-hidden />
              {treeError}
            </p>
          ) : treeNote ? (
            <p className="files-note" role="status">
              {treeNote}
            </p>
          ) : null}
          <FilesTree
            model={model}
            label={`Files in ${folderName}`}
            onKeyDown={treeKeys}
            renderContextMenu={(item, context) => (
              <FilesRowMenu item={item} context={context} onAction={(action) => act(action, rowOf(item.path) ?? null)} onRename={startRename} />
            )}
          />
        </>
      )}
    </>
  );

  /** The open file's save. Cmd+S (files.save) reaches it for the life of the modal, so the key is never left to beep. */
  const save = useRef<(() => void) | null>(null);
  useEffect(() => registerFileEditorSave(() => save.current?.()), []);

  const empty =
    root.state === "refused" ? (
      // The folder cannot open: said as an alert, so a reader hears why the tree is empty.
      <div role="alert" className="files-refused">
        <PaneEmpty
          glyph={<FileQuestion size={20} />}
          title={offline === undefined ? filesErrorLine(root.error) : unreachableLine(machineLabel(offline.machine), offline.lastReachedAt, now)}
        />
      </div>
    ) : selected === null ? (
      <PaneEmpty
        glyph={<FileText size={20} />}
        title="Pick a file"
        // The folder itself opens in Finder from here, on this machine's node; the header keeps its width for the folder's name.
        {...(here
          ? {
              action: (
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
              ),
            }
          : {})}
      />
    ) : null;

  /**
   * One pane for every file: the open file is keyed and remounts on a pick,
   * the sidebar is not, so the tree keeps its scroll and the picked row stays
   * where it was on screen. The file's rail is drawn into the pane's rail.
   */
  const railOpen = useCommentsRailOpen();
  const [railHost, setRailHost] = useState<HTMLDivElement | null>(null);
  const railRef = useCallback((element: HTMLDivElement | null) => {
    setRailHost(element);
    const gone = commentsRailRef(element);
    return () => {
      gone?.();
      setRailHost(null);
    };
  }, []);
  const shown = empty === null && selected !== null && root.state === "ready" ? selected : null;

  return (
    <>
      <FocusSurface measure="workspace" height="immersive" label="Files" onClose={onClose}>
        {quickOpen.palette}
        <div {...drop.surface} className="files-body">
          <TwoPane
            keptBy={{ canvas: ref.canvas, node: ref.node }}
            sidebar={sidebar}
            sidebarLabel="Files"
            sidebarWidth="narrow"
            mainLabel={shown === null ? "File" : baseName(shown)}
            {...(shown === null ? {} : { rail: <div className="files-rail" ref={railRef} />, railLabel: "Comments", railCollapsed: !railOpen })}
          >
            {shown === null ? (
              (empty ?? <PaneEmpty title="Opening the folder" />)
            ) : (
              <SelectedFile
                // A named page is jumped to once per mount: a new open naming one mounts the file afresh.
                key={pageOnce === undefined || shown !== initialPath ? shown : `${shown}#${String(openKey ?? 0)}`}
                canvasName={canvasName}
                filesRef={ref}
                path={shown}
                {...(pageOnce !== undefined && shown === initialPath ? { initialPage: pageOnce } : {})}
                railHost={railHost}
                here={here}
                save={save}
                onRename={() => startRename(treePathOf({ path: shown, dir: false }))}
                onAct={(kind) => actOnRow({ path: shown, dir: false }, kind)}
                onClose={onClose}
              />
            )}
          </TwoPane>
          <FilesDropHighlight drop={drop} />
        </div>
      </FocusSurface>
      {/* Outside the surface's React tree: a key in a dialog bubbles to its React parents, and Escape there would close the modal too. */}
      {dialog}
    </>
  );
}

function SelectedFile({
  canvasName,
  filesRef,
  path,
  initialPage,
  railHost,
  here,
  save,
  onRename,
  onAct,
  onClose,
}: {
  readonly canvasName: string;
  readonly filesRef: FilesNodeRef;
  readonly path: FilePath;
  readonly initialPage?: number;
  /** The pane's rail, which the file's comments are drawn into. */
  readonly railHost: HTMLElement | null;
  /** The node is on this machine: its default app and Finder are offered. */
  readonly here: boolean;
  readonly save: React.MutableRefObject<(() => void) | null>;
  /** The open file's rename, in its tree row; its move and trash, in their dialogs. */
  readonly onRename: () => void;
  readonly onAct: (kind: "move" | "trash") => void;
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
  /** The version on disk this pane last read or wrote: a change event that finds it still there changed nothing here. */
  const known = useRef<FileStamp | null>(null);
  /** A write in flight; a second Cmd+S waits for it rather than racing it. */
  const writing = useRef(false);
  const shown = useCallback((result: FilesResult<FileRead>): FileRead | null => {
    known.current = result.ok ? result.value.stamp : null;
    setRead(result.ok ? { state: "ready", value: result.value } : { state: "refused", error: result.error });
    setEpoch((last) => last + 1);
    return result.ok ? result.value : null;
  }, []);
  const load = useCallback(async (): Promise<FileRead | null> => shown(await filesSource().read(filesRef, path)), [shown, filesRef, path]);
  /** A change that came while this pane's write was out: looked at again once the write has said what it found. */
  const missed = useRef(false);
  /** Read the disk and act on a change there since this pane last knew it. */
  const recheck = useCallback((): void => {
    void filesSource()
      .read(filesRef, path)
      .then((now) => {
        if (writing.current) {
          missed.current = true;
          return;
        }
        // This pane's own save, told at once and again by the watch.
        if (now.ok && known.current !== null && sameStamp(now.value.stamp, known.current)) return;
        // A clean file follows the disk; a draft is the operator's until they choose.
        if (fileDraft(nodeId, path) === undefined) shown(now);
        else setStale(!now.ok && now.error === "not-found" ? "deleted" : "changed");
      });
  }, [shown, filesRef, nodeId, path]);
  useEffect(() => {
    // A draft held while the modal was closed may be on a version the disk has since left: say so on open, not at Save.
    void load().then((now) => {
      const held = fileDraft(nodeId, path);
      if (now !== null && held !== undefined && !sameStamp(held.base, now.stamp)) setStale("changed");
    });
    return filesSource().onChange((event) => {
      if (changeTouches(event, nodeId, path)) recheck();
    });
  }, [load, recheck, nodeId, path]);

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

  const write = async (body: string, base: FileStamp | null): Promise<boolean> => {
    writing.current = true;
    setSaving(true);
    const result = await filesSource().write(filesRef, path, body, base);
    writing.current = false;
    setSaving(false);
    // Another save told while this one was out (a twin node's): looked at now, not at the watch's echo.
    if (missed.current) {
      missed.current = false;
      queueMicrotask(recheck);
    }
    if (result.ok) {
      known.current = result.value;
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
            {...(here ? { action: elsewhere } : {})}
          />
        );
      default:
        return null;
    }
  })();

  return (
    <>
      {railHost === null
        ? null
        : createPortal(
            <FileRail context={commentContext} threads={threads} draftAnchor={draftAnchor} open={railOpen} onPosted={spent} onClose={onClose} />,
            railHost,
          )}
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
        <IconButton aria-label="Rename" title="Rename" size="sm" onClick={onRename}>
          <Pencil size={14} />
        </IconButton>
        <IconButton aria-label="Move to" title="Move to" size="sm" onClick={() => onAct("move")}>
          <FolderInput size={14} />
        </IconButton>
        <IconButton aria-label="Move to Trash" title="Move to Trash" size="sm" onClick={() => onAct("trash")}>
          <Trash2 size={14} />
        </IconButton>
        {here ? (
          <>
            <IconButton aria-label="Open in default app" title="Open in default app" size="sm" onClick={() => void outside("openInDefaultApp")}>
              <ExternalLink size={14} />
            </IconButton>
            <IconButton aria-label="Reveal in Finder" title="Reveal in Finder" size="sm" onClick={() => void outside("revealInFinder")}>
              <FolderSearch size={14} />
            </IconButton>
          </>
        ) : null}
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
    </>
  );
}

/**
 * The tree, named. The library draws role=tree inside its shadow root, where
 * an aria-label on the host never reaches; until it takes a label of its own,
 * the name is set on the inner tree once it renders (a workaround, for
 * product-accessibility's review), and the nav names the region around it.
 */
function FilesTree({
  model,
  label,
  onKeyDown,
  renderContextMenu,
}: {
  readonly model: FileTreeModel;
  readonly label: string;
  readonly onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
  readonly renderContextMenu: NonNullable<React.ComponentProps<typeof FileTree>["renderContextMenu"]>;
}) {
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
    <nav ref={wrap} className="files-tree-nav" aria-label={label} onKeyDown={onKeyDown}>
      <FileTree model={model} className="files-tree" renderContextMenu={renderContextMenu} />
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
  return open ? (
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
  );
}

const RUNS_LINE = "Junto does not open programs or scripts. Reveal it in Finder instead.";
const DELETED_LINE = "This file was deleted on disk. Your changes are still here.";

const formatSize = (bytes: number): string =>
  bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
