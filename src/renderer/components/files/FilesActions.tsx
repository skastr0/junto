import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { ContextMenuItem as FileTreeContextMenuItem, ContextMenuOpenContext as FileTreeContextMenuOpenContext } from "@pierre/trees";
import { createPortal } from "react-dom";
import { FilePlus, FolderInput, FolderPlus, Pencil, Trash2, type LucideIcon } from "lucide-react";
import { baseName, joinFilePath, ROOT_PATH, type FilePath, type FilesNodeRef } from "@shared/files";
import { filesErrorLine, filesSource } from "../../lib/files-source";
import { claimFocus } from "../../lib/focus-ownership";
import { Button, Combobox, ConfirmDialog, Dialog, Input } from "../ui";
import { folderOfRow, moveTargets, rowOf, typedFolder, walkFolders, type FilesAction } from "./files-actions";

type RowChoice = { readonly key: string; readonly label: string; readonly glyph: LucideIcon; readonly run: () => void };

/**
 * A row's menu (0.11, F2): opened by a right-click, by Shift+F10 or the Menu
 * key on the focused row; the tree puts focus on the first item and takes it
 * back to the row on Escape. Arrows, Home and End move; Tab closes, as
 * Escape does. A choice that opens a dialog or the rename field closes the
 * menu without taking focus back, so the keyboard goes where the choice does.
 */
export function FilesRowMenu({
  item,
  context,
  onAction,
  onRename,
}: {
  readonly item: FileTreeContextMenuItem;
  readonly context: FileTreeContextMenuOpenContext;
  readonly onAction: (action: FilesAction) => void;
  readonly onRename: (treePath: string) => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  // Placed at the row (or the pointer) and kept on screen; then focus goes to the first item,
  // which the library does only for a menu it draws itself.
  useLayoutEffect(() => {
    const panel = menu.current;
    if (panel === null) return;
    const rect = context.anchorRect;
    const { width, height } = panel.getBoundingClientRect();
    const below = rect.bottom + 4;
    // Placed on the element before the focus claim: a hidden element cannot take focus.
    panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
    panel.style.top = `${below + height <= window.innerHeight - 8 ? below : Math.max(8, rect.top - height - 4)}px`;
    panel.style.visibility = "visible";
    const first = panel.querySelector<HTMLElement>('[role="menuitem"]');
    if (first !== null) claimFocus(first, "open", { preventScroll: true });
  }, [item.path, context.anchorRect]);
  const row = rowOf(item.path);
  if (row === undefined) return null;
  const into = folderOfRow(row.path, row.dir);
  const choose = (run: () => void) => () => {
    context.close({ restoreFocus: false });
    run();
  };
  const choices: ReadonlyArray<RowChoice> = [
    { key: "new-file", label: "New file", glyph: FilePlus, run: () => onAction({ kind: "create", dir: false, into }) },
    { key: "new-folder", label: "New folder", glyph: FolderPlus, run: () => onAction({ kind: "create", dir: true, into }) },
    { key: "rename", label: "Rename", glyph: Pencil, run: () => onRename(item.path) },
    { key: "move", label: "Move to", glyph: FolderInput, run: () => onAction({ kind: "move", ...row }) },
    { key: "trash", label: "Move to Trash", glyph: Trash2, run: () => onAction({ kind: "trash", ...row }) },
  ];
  const keys = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "Tab") {
      event.preventDefault();
      context.close();
      return;
    }
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')];
    const at = items.indexOf(document.activeElement as HTMLElement);
    const to =
      event.key === "ArrowDown"
        ? (at + 1) % items.length
        : event.key === "ArrowUp"
          ? (at - 1 + items.length) % items.length
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : -1;
    if (to < 0) return;
    event.preventDefault();
    claimFocus(items[to], "gesture", { event: event.nativeEvent });
  };
  // Out of the sidebar, whose overflow would clip it; the tree reads a press in it as inside by the root mark.
  return createPortal(
    <div
      ref={menu}
      role="menu"
      aria-label={`Actions for ${item.name}`}
      data-layer="popover"
      data-file-tree-context-menu-root="true"
      className="files-row-menu"
      style={{ left: 0, top: 0, visibility: "hidden" }}
      onKeyDown={keys}
    >
      {choices.map(({ key, label, glyph: Glyph, run }, index) => (
        <button key={key} type="button" role="menuitem" tabIndex={index === 0 ? 0 : -1} className="files-row-menu__item" onClick={choose(run)}>
          <Glyph size={14} aria-hidden />
          {label}
        </button>
      ))}
    </div>,
    document.body,
  );
}

/** Where a new entry or a move lands, in words: the folder's path, or the root's name. */
export const folderLabel = (folder: FilePath, rootName: string): string => (folder === ROOT_PATH ? rootName : folder);

/**
 * New file or New folder: a name, then Create. A name main refuses (taken,
 * not a name) is said in the dialog, as an alert, and the name stays to fix.
 */
export function FilesCreateDialog({
  filesRef,
  action,
  rootName,
  onDone,
  onCancel,
}: {
  readonly filesRef: FilesNodeRef;
  readonly action: Extract<FilesAction, { kind: "create" }>;
  readonly rootName: string;
  readonly onDone: (made: { readonly path: FilePath; readonly dir: boolean }) => void;
  readonly onCancel: () => void;
}) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const noun = action.dir ? "folder" : "file";
  const create = async (): Promise<void> => {
    if (busy) return;
    const path = joinFilePath(action.into, name.trim());
    if (path === undefined) return setError(filesErrorLine("invalid-path"));
    setBusy(true);
    const result = await filesSource().create(filesRef, path, action.dir);
    setBusy(false);
    if (!result.ok) return setError(filesErrorLine(result.error));
    onDone({ path: result.value.path, dir: action.dir });
  };
  return (
    <Dialog
      title={`New ${noun}`}
      eyebrow={`In ${folderLabel(action.into, rootName)}`}
      onClose={onCancel}
      actions={
        <>
          <Button variant="chrome" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" aria-disabled={busy || name.trim() === ""} onClick={() => void create()}>
            Create
          </Button>
        </>
      }
    >
      <form
        className="files-dialog"
        onSubmit={(event) => {
          event.preventDefault();
          void create();
        }}
      >
        <Input
          aria-label={`Name of the new ${noun}`}
          placeholder={action.dir ? "Folder name" : "File name"}
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
          }}
        />
        {error ? (
          <p className="files-dialog__error" role="alert">
            {error}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}

/**
 * Move to: the folders under the root by name, filtered as the operator
 * types, arrows and Enter to pick; a path typed that the list does not hold
 * is moved to as typed, and main says if it is not a folder or leads outside.
 */
export function FilesMoveDialog({
  filesRef,
  action,
  rootName,
  onDone,
  onCancel,
}: {
  readonly filesRef: FilesNodeRef;
  readonly action: Extract<FilesAction, { kind: "move" }>;
  readonly rootName: string;
  readonly onDone: (moved: { readonly from: FilePath; readonly to: FilePath; readonly dir: boolean }) => void;
  readonly onCancel: () => void;
}) {
  const [folders, setFolders] = useState<ReadonlyArray<FilePath> | null>(null);
  useEffect(() => {
    let live = true;
    void walkFolders(filesRef, () => live).then((found) => {
      if (live) setFolders(moveTargets(found, action.path));
    });
    return () => {
      live = false;
    };
  }, [filesRef, action.path]);
  const [typed, setTyped] = useState("");
  const [active, setActive] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = useMemo(() => {
    const query = typed.trim().toLowerCase();
    return (folders ?? []).filter((folder) => query === "" || folderLabel(folder, rootName).toLowerCase().includes(query));
  }, [folders, typed, rootName]);
  const move = async (into: FilePath | undefined): Promise<void> => {
    if (busy) return;
    if (into === undefined) return setError("That is not a folder path in this folder.");
    setBusy(true);
    const result = await filesSource().move(filesRef, action.path, into);
    setBusy(false);
    if (!result.ok) return setError(filesErrorLine(result.error));
    onDone({ from: action.path, to: result.value, dir: action.dir });
  };
  const name = baseName(action.path);
  return (
    <Dialog
      title={`Move ${name}`}
      eyebrow="Move to"
      width={480}
      onClose={onCancel}
      actions={
        <>
          <Button variant="chrome" onClick={onCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            aria-disabled={busy || (active === undefined && typed.trim() === "")}
            onClick={() => void move(active === undefined ? typedFolder(typed) : (folders?.find((folder) => folder === active) ?? typedFolder(typed)))}
          >
            Move
          </Button>
        </>
      }
    >
      <div className="files-dialog">
        <Combobox<FilePath>
          aria-label={`Folder to move ${name} into`}
          listLabel="Folders"
          placeholder="Type a folder, or pick one"
          value={typed}
          onValueChange={(value) => {
            setTyped(value);
            setError(null);
          }}
          options={shown}
          optionKey={(folder) => folder}
          renderOption={(folder) => <span className="files-dialog__folder">{folderLabel(folder, rootName)}</span>}
          activeKey={active}
          onActiveKeyChange={setActive}
          onCommit={(folder, value) => void move(folder ?? typedFolder(value))}
          onOptionDoubleClick={(folder) => void move(folder)}
          status={folders === null ? "Listing folders" : undefined}
          empty={folders === null ? null : "No folder by that name. Enter moves it to the path as typed."}
        />
        {error ? (
          <p className="files-dialog__error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

/** Move to Trash: asked first, naming the entry; never an unlink, the system Trash keeps it. */
export function FilesTrashDialog({
  filesRef,
  action,
  onDone,
  onCancel,
}: {
  readonly filesRef: FilesNodeRef;
  readonly action: Extract<FilesAction, { kind: "trash" }>;
  readonly onDone: (gone: { readonly path: FilePath; readonly dir: boolean }) => void;
  readonly onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = baseName(action.path);
  return (
    <ConfirmDialog
      title={`Move ${name} to the Trash?`}
      confirmLabel="Move to Trash"
      busy={busy}
      onCancel={onCancel}
      onConfirm={() => {
        if (busy) return;
        setBusy(true);
        void filesSource()
          .trash(filesRef, action.path)
          .then((result) => {
            setBusy(false);
            if (result.ok) onDone({ path: action.path, dir: action.dir });
            else setError(filesErrorLine(result.error));
          });
      }}
    >
      {error ?? (action.dir ? "The folder and everything in it go to the system Trash, where you can put them back." : "It goes to the system Trash, where you can put it back.")}
    </ConfirmDialog>
  );
}
