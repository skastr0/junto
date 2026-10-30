/**
 * The Files channels, behind `trustedRendererIpc`: only the app's own
 * renderer reaches them. Every answer is a core operation
 * (`core-process/ops/files.ts`), where the service, the root index's worker
 * and the bytes live; main keeps what is Electron's here: the shell a Trash,
 * an Open or a Reveal needs, the window a change goes to, and the names of
 * the paths each window was handed on a real drag.
 *
 * A subscriber is a webContents id. The core serves that number and pushes its
 * changes back tagged with it; nothing here holds a session.
 */
import { ipcMain, shell, webContents } from "electron";
import { IPC_CHANNELS } from "@shared/ipc";
import type { FilesChanged, FilesResult } from "@shared/files";
import { trustedRendererIpc } from "../trusted-main-webcontents";
import { core } from "../../core-process/main-client";
import { subscribe as subscribeCore } from "../../core-process/push";
import { FILES_CHANGED, type FilesChangedPush } from "../../core-process/channels";
import { hostOps } from "../../core-process/host-ops";
import type { FileBytesReader, FileBytesResolver } from "./protocol";

const watched = new Set<number>();

/** Tell the core a window is gone: its sessions end with it. */
const watch = (id: number): void => {
  if (watched.has(id)) return;
  watched.add(id);
  const sender = webContents.fromId(id);
  if (sender === undefined) return;
  sender.once("destroyed", () => {
    watched.delete(id);
    void core.call("files.windowGone", { subscriber: id }).catch(() => undefined);
  });
};

/** The shell the core's Files service asks for: this process has one, the core none. */
const serveFilesShell = (): void => {
  hostOps({
    "files.trash": async ({ absolute }) => shell.trashItem(absolute),
    "files.openPath": async ({ absolute }) => shell.openPath(absolute),
    "files.reveal": async ({ absolute }) => {
      shell.showItemInFolder(absolute);
    },
  });
};

/**
 * Register the Files channels. Another machine's node goes to the link client
 * in the core (`ops/files.ts`, `router.ts`).
 */
export const registerFilesIpc = (): void => {
  const ipc = trustedRendererIpc(ipcMain);
  serveFilesShell();

  // A change for a window that has the node open: the core names the window.
  subscribeCore(FILES_CHANGED, (payload) => {
    const pushed = payload as FilesChangedPush;
    const target = webContents.fromId(pushed.subscriber);
    if (target !== undefined && !target.isDestroyed()) target.send(IPC_CHANNELS.filesChanged, pushed.event);
  });

  ipc.on(IPC_CHANNELS.filesDropped, (event, path: unknown) => {
    watch(event.sender.id);
    void core.call("files.dropped", { subscriber: event.sender.id, path }).catch(() => undefined);
  });
  ipc.handle(IPC_CHANNELS.filesOpen, (event, ref: unknown) => {
    watch(event.sender.id);
    return core.call("files.open", { subscriber: event.sender.id, ref });
  });
  ipc.handle(IPC_CHANNELS.filesClose, (event, ref: unknown) => {
    watch(event.sender.id);
    return core.call("files.close", { subscriber: event.sender.id, ref });
  });
  ipc.handle(IPC_CHANNELS.filesCount, (event, ref: unknown) => {
    watch(event.sender.id);
    return core.call("files.count", { ref });
  });
  ipc.handle(IPC_CHANNELS.filesList, (_event, ref: unknown, dir: unknown) =>
    core.call("files.list", { ref, dir }),
  );
  ipc.handle(IPC_CHANNELS.filesSearch, (event, ref: unknown, query: unknown, seq: unknown) => {
    watch(event.sender.id);
    return core.call("files.search", { subscriber: event.sender.id, ref, query, seq });
  });
  ipc.handle(IPC_CHANNELS.filesRead, (_event, ref: unknown, path: unknown) =>
    core.call("files.read", { ref, path }),
  );
  ipc.handle(IPC_CHANNELS.filesWrite, (_event, ref: unknown, path: unknown, text: unknown, base: unknown) =>
    core.call("files.write", { ref, path, text, base }),
  );
  ipc.handle(IPC_CHANNELS.filesCreate, (_event, ref: unknown, path: unknown, dir: unknown) =>
    core.call("files.create", { ref, path, dir }),
  );
  ipc.handle(IPC_CHANNELS.filesRename, (_event, ref: unknown, path: unknown, name: unknown) =>
    core.call("files.rename", { ref, path, name }),
  );
  ipc.handle(IPC_CHANNELS.filesMove, (_event, ref: unknown, path: unknown, intoDir: unknown) =>
    core.call("files.move", { ref, path, into: intoDir }),
  );
  ipc.handle(IPC_CHANNELS.filesTrash, (_event, ref: unknown, path: unknown) =>
    core.call("files.trash", { ref, path }),
  );
  ipc.handle(IPC_CHANNELS.filesImport, (event, ref: unknown, intoDir: unknown, sources: unknown) => {
    watch(event.sender.id);
    return core.call("files.import", { subscriber: event.sender.id, ref, into: intoDir, sources });
  });
  ipc.handle(IPC_CHANNELS.filesOpenInDefaultApp, (_event, ref: unknown, path: unknown) =>
    core.call("files.openInDefaultApp", { ref, path }),
  );
  ipc.handle(IPC_CHANNELS.filesReveal, (_event, ref: unknown, path: unknown) =>
    core.call("files.reveal", { ref, path }),
  );
};

/**
 * The `junto-file:` resolver: one open file in the core, read in chunks by
 * name, closed when the stream ends. A file a viewer stops reading is closed
 * with it, so no handle outlives its request.
 */
export const coreFileBytes = (): FileBytesResolver => async (node, path) => {
  const opened = await core
    .call("files.bytesOpen", { node, path })
    .catch((): FilesResult<{ readonly token: string; readonly size: number }> => ({ ok: false, error: "failed" }));
  if (!opened.ok) return opened;
  const { token, size } = opened.value;
  const reader: FileBytesReader = {
    size,
    read: async (offset, length) => {
      const chunk = await core
        .call("files.bytesRead", { token, offset, length })
        .catch((): FilesResult<Uint8Array> => ({ ok: false, error: "failed" }));
      if (!chunk.ok) throw new Error("the file could not be read");
      return chunk.value;
    },
    close: async () => {
      await core.call("files.bytesClose", { token }).catch(() => undefined);
    },
  };
  return { ok: true, value: reader };
};
