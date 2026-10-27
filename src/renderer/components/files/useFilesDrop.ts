import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import type { FileTreeDragAndDropConfig, FileTreeDropResult } from "@pierre/trees";
import { parseFilePath, type FilesError, type FilesNodeRef, type JuntoFilesApi } from "@shared/files";
import {
  basenameOf,
  finderDropTargetOf,
  folderLabel,
  hasFinderFiles,
  importNotice,
  movesForDrop,
  type FolderPath,
} from "@renderer/lib/files-drop";

/**
 * Drops on the Files modal (0.11, F5). Finder files dropped on the modal
 * copy into the folder under the pointer, with that folder marked while the
 * drag is over it; a tree row dragged onto a folder moves there, one move
 * per item through the Files service. Copies never overwrite: the service
 * gives a taken name a " 2", and the notice says so.
 *
 * The modal owns the wiring: it spreads `surface` on the body that holds
 * the tree and the main pane, renders `FilesDropHighlight` inside it, passes
 * `treeDragAndDrop` to the tree and hands `bindModel` the tree's model.
 */

/** What drops need from the Files service (`window.junto.files`). */
export type FilesDropPort = Pick<JuntoFilesApi["files"], "import" | "move" | "pathForDroppedFile">;

/** The tree model's one call drops make: put a row back after a refused move. */
export type FilesDropModel = { readonly move: (fromPath: string, toPath: string) => void };

/** The marked drop target, in pixels from the surface's top left; no rect means the whole surface. */
export type FilesDropRect = { readonly top: number; readonly left: number; readonly width: number; readonly height: number };
export type FilesDropTarget = { readonly dir: FolderPath; readonly label: string; readonly rect: FilesDropRect | null };

export type FilesDrop = {
  readonly target: FilesDropTarget | null;
  /** The last copy or move, in words; cleared after a while or by the next drag. */
  readonly notice: { readonly text: string; readonly failed: boolean } | undefined;
  readonly dismissNotice: () => void;
  /**
   * A row is being dragged inside the tree. The tree selects the row it
   * starts dragging; a modal that opens the selection must skip that one,
   * since opening it remounts the tree, and the tree cancels its drag when
   * it unmounts.
   */
  readonly isTreeDragging: () => boolean;
  readonly surface: {
    readonly onDragStartCapture: (event: DragEvent<HTMLElement>) => void;
    readonly onDragEndCapture: (event: DragEvent<HTMLElement>) => void;
    readonly onDragEnter: (event: DragEvent<HTMLElement>) => void;
    readonly onDragOver: (event: DragEvent<HTMLElement>) => void;
    readonly onDragLeave: (event: DragEvent<HTMLElement>) => void;
    readonly onDrop: (event: DragEvent<HTMLElement>) => void;
    readonly "data-files-drop": "true";
    /** A Finder drag is over the surface: onto the root, or onto a folder row. */
    readonly "data-drop"?: "root" | "folder";
  };
  readonly treeDragAndDrop: FileTreeDragAndDropConfig;
  readonly bindModel: (model: FilesDropModel | null) => void;
};

/** How long a notice stays. */
export const FILES_DROP_NOTICE_MS = 5000;

const sameTarget = (left: FilesDropTarget | null, right: FilesDropTarget | null): boolean => {
  if (left === right) return true;
  if (left === null || right === null || left.dir !== right.dir) return false;
  const a = left.rect;
  const b = right.rect;
  if (a === null || b === null) return a === b;
  return a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height;
};

export const useFilesDrop = ({
  port,
  node,
  describe,
  rootLabel,
}: {
  readonly port: FilesDropPort;
  readonly node: FilesNodeRef;
  /** A refusal in the operator's words. */
  readonly describe: (error: FilesError) => string;
  /** The root folder's name, as the operator knows it. */
  readonly rootLabel: string;
}): FilesDrop => {
  const [target, setTarget] = useState<FilesDropTarget | null>(null);
  const [notice, setNotice] = useState<FilesDrop["notice"]>();
  const model = useRef<FilesDropModel | null>(null);
  // Finder drag enters minus leaves under the surface. Every child the drag
  // crosses sends one of each (a shadow root's rows as its host), so the drag
  // has left only at zero; dragleave's relatedTarget is not reliable here.
  const depth = useRef(0);
  // Set as a tree drag's dragstart crosses the surface, before the row's own
  // handler starts the drag and selects the row.
  const treeDragging = useRef(false);
  // The latest props, so the tree's config stays one object for the tree's life.
  const live = useRef({ port, node, describe, rootLabel });
  live.current = { port, node, describe, rootLabel };
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    if (notice === undefined) return;
    const timer = setTimeout(() => setNotice(undefined), FILES_DROP_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const say = useCallback((text: string, failed: boolean) => {
    if (mounted.current) setNotice({ text, failed });
  }, []);

  const targetAt = useCallback((event: DragEvent<HTMLElement>): FilesDropTarget => {
    const found = finderDropTargetOf(event.nativeEvent.composedPath());
    const label = folderLabel(found.dir, live.current.rootLabel);
    if (found.row === null) return { dir: found.dir, label, rect: null };
    const host = event.currentTarget.getBoundingClientRect();
    const row = found.row.getBoundingClientRect();
    return {
      dir: found.dir,
      label,
      rect: { top: row.top - host.top, left: row.left - host.left, width: row.width, height: row.height },
    };
  }, []);

  const copyInto = useCallback(
    async (dir: FolderPath, files: ReadonlyArray<File>) => {
      const { port, node, describe, rootLabel } = live.current;
      const sources = files.map((file) => port.pathForDroppedFile(file)).filter((path) => path.length > 0);
      if (sources.length === 0) {
        say("Only files from Finder can be dropped here.", true);
        return;
      }
      const into = folderLabel(dir, rootLabel);
      const intoDir = parseFilePath(dir);
      const outcome = intoDir === undefined ? ({ ok: false, error: "invalid-path" } as const) : await port.import(node, intoDir, sources);
      if (!outcome.ok) {
        say(`Nothing was copied into ${into}. ${describe(outcome.error)}`, true);
        return;
      }
      if (outcome.value.length === 0) return;
      say(
        importNotice(
          sources,
          outcome.value.map((landed) => landed.path),
          into,
        ),
        false,
      );
    },
    [say],
  );

  const surface = useMemo<FilesDrop["surface"]>(
    () => ({
      onDragStartCapture: (event) => {
        if (hasFinderFiles(event.dataTransfer?.types)) return;
        treeDragging.current = true;
      },
      onDragEndCapture: () => {
        treeDragging.current = false;
      },
      onDragEnter: (event) => {
        if (!hasFinderFiles(event.dataTransfer?.types)) return;
        event.preventDefault();
        depth.current += 1;
        setNotice(undefined);
        const next = targetAt(event);
        setTarget((current) => (sameTarget(current, next) ? current : next));
      },
      onDragOver: (event) => {
        if (!hasFinderFiles(event.dataTransfer?.types)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        const next = targetAt(event);
        setTarget((current) => (sameTarget(current, next) ? current : next));
      },
      onDragLeave: (event) => {
        if (!hasFinderFiles(event.dataTransfer?.types)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setTarget(null);
      },
      onDrop: (event) => {
        if (!hasFinderFiles(event.dataTransfer?.types)) return;
        event.preventDefault();
        const dir = finderDropTargetOf(event.nativeEvent.composedPath()).dir;
        depth.current = 0;
        setTarget(null);
        void copyInto(dir, [...event.dataTransfer.files]);
      },
      "data-files-drop": "true",
    }),
    [targetAt, copyInto],
  );

  const treeDragAndDrop = useMemo<FileTreeDragAndDropConfig>(
    () => ({
      // The tree has already moved its rows; each one the service refuses goes back.
      onDropComplete: (result: FileTreeDropResult) => {
        treeDragging.current = false;
        const moves = movesForDrop(result.draggedPaths, result.target);
        void (async () => {
          const { port, node, describe } = live.current;
          for (const [index, move] of moves.entries()) {
            const from = parseFilePath(move.from);
            const intoDir = parseFilePath(move.intoDir);
            const outcome =
              from === undefined || intoDir === undefined
                ? ({ ok: false, error: "invalid-path" } as const)
                : await port.move(node, from, intoDir);
            if (outcome.ok) continue;
            for (const back of moves.slice(index)) {
              try {
                model.current?.move(back.treeTo, back.treeFrom);
              } catch {
                // The watcher's next listing puts the tree right.
              }
            }
            say(`Could not move ${basenameOf(move.from)}. ${describe(outcome.error)}`, true);
            return;
          }
        })();
      },
      // The tree refuses a move onto a name that is taken, before anything moves.
      onDropError: () => {
        treeDragging.current = false;
        say("That folder already holds something with the same name. Nothing moved.", true);
      },
    }),
    [say],
  );

  const bindModel = useCallback((next: FilesDropModel | null) => {
    model.current = next;
  }, []);

  const dismissNotice = useCallback(() => setNotice(undefined), []);
  const isTreeDragging = useCallback(() => treeDragging.current, []);

  return {
    target,
    notice,
    dismissNotice,
    isTreeDragging,
    surface: target === null ? surface : { ...surface, "data-drop": target.rect === null ? "root" : "folder" },
    treeDragAndDrop,
    bindModel,
  };
};
