/**
 * The Files channels, behind `trustedRendererIpc`: only the app's own
 * renderer reaches them. Every answer is the core's Files group
 * (`src/contract/core/files.ts`), where the service, the root index's worker
 * and the bytes live; main keeps what is Electron's here: the shell a Trash,
 * an Open or a Reveal needs, the window a change goes to, and the names of
 * the paths each window was handed on a real drag.
 *
 * What a window sends is untrusted. It is decoded here, at main's edge, with
 * the shared closed decoders (`src/shared/files.ts`), and the core is only
 * ever handed a ref, a path and a body that decoded. What did not decode
 * answers the refusal the window shows: `no-node` for a ref, `invalid-path`
 * for anything else.
 *
 * A subscriber is a webContents id. The core serves that number and pushes its
 * changes back tagged with it; nothing here holds a session.
 */
import { ipcMain, shell, webContents } from "electron";
import { Context, Result } from "effect";
import { IPC_CHANNELS } from "@shared/ipc";
import {
  decodeFilesDir,
  decodeFilesName,
  decodeFilesNodeRef,
  decodeFilesSearch,
  decodeFilesSources,
  decodeFilesWriteBody,
  parseFilePath,
  type FilePath,
  type FilesNodeRef,
  type FilesResult,
} from "@shared/files";
import { trustedRendererIpc } from "../trusted-main-webcontents";
import { subscribe as subscribeCore } from "../core-process/main-side/core-pushes";
import { FILES_CHANGED, type FilesChangedPush } from "../../contract/core/channels";
import { FilesCore, type FilesBytesOpened } from "../../contract/core/files";
import { hostOps } from "../core-process/main-side/host-op-bodies";
import type { FileBytesReader } from "../../core/files/bytes";
import { AppRuntime } from "../runtime";
import type { FileBytesResolver } from "./protocol";

const noNode = { ok: false, error: "no-node" } as const;
const invalid = { ok: false, error: "invalid-path" } as const;
const failed = { ok: false, error: "failed" } as const;

/** The node a window named, or the refusal it shows. */
const onNode = <R>(rawRef: unknown, run: (ref: FilesNodeRef) => Promise<R>): Promise<R | typeof noNode> => {
  const ref = decodeFilesNodeRef(rawRef);
  return Result.isFailure(ref) ? Promise.resolve(noNode) : run(ref.success);
};

/** The node and the path a window named, or the refusal it shows. */
const at = <R>(
  rawRef: unknown,
  rawPath: unknown,
  run: (ref: FilesNodeRef, path: FilePath) => Promise<R>,
): Promise<R | typeof noNode | typeof invalid> =>
  onNode<R | typeof invalid>(rawRef, (ref) => {
    const path = parseFilePath(rawPath);
    return path === undefined ? Promise.resolve(invalid) : run(ref, path);
  });

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
export const registerFilesIpc = (core: Context.Context<FilesCore>): void => {
  const files = Context.get(core, FilesCore);
  const ipc = trustedRendererIpc(ipcMain);
  serveFilesShell();

  const watched = new Set<number>();

  /** Tell the core a window is gone: its sessions end with it. */
  const watch = (id: number): void => {
    if (watched.has(id)) return;
    watched.add(id);
    const sender = webContents.fromId(id);
    if (sender === undefined) return;
    sender.once("destroyed", () => {
      watched.delete(id);
      void AppRuntime.runPromise(files.FilesWindowGone({ subscriber: id })).catch(() => undefined);
    });
  };

  // A change for a window that has the node open: the core names the window.
  subscribeCore(FILES_CHANGED, (payload) => {
    const pushed = payload as FilesChangedPush;
    const target = webContents.fromId(pushed.subscriber);
    if (target !== undefined && !target.isDestroyed()) target.send(IPC_CHANNELS.filesChanged, pushed.event);
  });

  ipc.on(IPC_CHANNELS.filesDropped, (event, path: unknown) => {
    watch(event.sender.id);
    if (typeof path !== "string") return;
    void AppRuntime.runPromise(files.FilesDropped({ subscriber: event.sender.id, path })).catch(() => undefined);
  });
  ipc.handle(IPC_CHANNELS.filesOpen, (event, ref: unknown) => {
    watch(event.sender.id);
    return onNode(ref, (node) => AppRuntime.runPromise(files.FilesOpen({ subscriber: event.sender.id, ref: node })));
  });
  ipc.handle(IPC_CHANNELS.filesClose, (event, ref: unknown) => {
    watch(event.sender.id);
    return onNode(ref, (node) => AppRuntime.runPromise(files.FilesClose({ subscriber: event.sender.id, ref: node })));
  });
  ipc.handle(IPC_CHANNELS.filesCount, (event, ref: unknown) => {
    watch(event.sender.id);
    return onNode(ref, (node) => AppRuntime.runPromise(files.FilesCount({ ref: node })));
  });
  ipc.handle(IPC_CHANNELS.filesList, (_event, ref: unknown, dir: unknown) =>
    at(ref, dir, (node, path) => AppRuntime.runPromise(files.FilesList({ ref: node, dir: path }))),
  );
  ipc.handle(IPC_CHANNELS.filesSearch, (event, ref: unknown, query: unknown, seq: unknown) => {
    watch(event.sender.id);
    return onNode(ref, async (node) => {
      const asked = decodeFilesSearch({ query, seq });
      if (Result.isFailure(asked)) return invalid;
      return AppRuntime.runPromise(files.FilesSearch({ subscriber: event.sender.id, ref: node, ...asked.success }));
    });
  });
  ipc.handle(IPC_CHANNELS.filesRead, (_event, ref: unknown, path: unknown) =>
    at(ref, path, (node, at_) => AppRuntime.runPromise(files.FilesRead({ ref: node, path: at_ }))),
  );
  ipc.handle(IPC_CHANNELS.filesWrite, (_event, ref: unknown, path: unknown, text: unknown, base: unknown) =>
    at(ref, path, async (node, at_) => {
      const body = decodeFilesWriteBody({ text, base });
      if (Result.isFailure(body)) return invalid;
      return AppRuntime.runPromise(files.FilesWrite({ ref: node, path: at_, ...body.success }));
    }),
  );
  ipc.handle(IPC_CHANNELS.filesCreate, (_event, ref: unknown, path: unknown, dir: unknown) =>
    at(ref, path, async (node, at_) => {
      const isDir = decodeFilesDir(dir);
      if (Result.isFailure(isDir)) return invalid;
      return AppRuntime.runPromise(files.FilesCreate({ ref: node, path: at_, dir: isDir.success }));
    }),
  );
  ipc.handle(IPC_CHANNELS.filesRename, (_event, ref: unknown, path: unknown, name: unknown) =>
    at(ref, path, async (node, at_) => {
      const named = decodeFilesName(name);
      if (Result.isFailure(named)) return invalid;
      return AppRuntime.runPromise(files.FilesRename({ ref: node, path: at_, name: named.success }));
    }),
  );
  ipc.handle(IPC_CHANNELS.filesMove, (_event, ref: unknown, path: unknown, intoDir: unknown) =>
    at(ref, path, async (node, at_) => {
      const into = parseFilePath(intoDir);
      if (into === undefined) return invalid;
      return AppRuntime.runPromise(files.FilesMove({ ref: node, path: at_, into }));
    }),
  );
  ipc.handle(IPC_CHANNELS.filesTrash, (_event, ref: unknown, path: unknown) =>
    at(ref, path, (node, at_) => AppRuntime.runPromise(files.FilesTrash({ ref: node, path: at_ }))),
  );
  ipc.handle(IPC_CHANNELS.filesImport, (event, ref: unknown, intoDir: unknown, sources: unknown) => {
    watch(event.sender.id);
    return at(ref, intoDir, async (node, into) => {
      const decoded = decodeFilesSources(sources);
      if (Result.isFailure(decoded)) return invalid;
      return AppRuntime.runPromise(
        files.FilesImport({ subscriber: event.sender.id, ref: node, into, sources: decoded.success }),
      );
    });
  });
  ipc.handle(IPC_CHANNELS.filesOpenInDefaultApp, (_event, ref: unknown, path: unknown) =>
    at(ref, path, (node, at_) => AppRuntime.runPromise(files.FilesOpenInDefaultApp({ ref: node, path: at_ }))),
  );
  ipc.handle(IPC_CHANNELS.filesReveal, (_event, ref: unknown, path: unknown) =>
    at(ref, path, (node, at_) => AppRuntime.runPromise(files.FilesReveal({ ref: node, path: at_ }))),
  );
};

/**
 * The `junto-file:` resolver: one open file in the core, read in chunks by
 * name, closed when the stream ends. A file a viewer stops reading is closed
 * with it, so no handle outlives its request.
 */
export const coreFileBytes = (core: Context.Context<FilesCore>): FileBytesResolver => {
  const files = Context.get(core, FilesCore);
  return async (node, path) => {
    const opened = await AppRuntime.runPromise(files.FilesBytesOpen({ node, path })).catch(
      (): FilesResult<FilesBytesOpened> => failed,
    );
    if (!opened.ok) return opened;
    const { token, size } = opened.value;
    const reader: FileBytesReader = {
      size,
      read: async (offset, length) => {
        const chunk = await AppRuntime.runPromise(files.FilesBytesRead({ token, offset, length })).catch(
          (): FilesResult<Uint8Array> => failed,
        );
        if (!chunk.ok) throw new Error("the file could not be read");
        return chunk.value;
      },
      close: async () => {
        await AppRuntime.runPromise(files.FilesBytesClose({ token })).catch(() => undefined);
      },
    };
    return { ok: true, value: reader };
  };
};
