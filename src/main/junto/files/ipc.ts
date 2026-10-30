import { isAbsolute } from "node:path";
import { ipcMain, shell, webContents, type IpcMainInvokeEvent } from "electron";
import { IPC_CHANNELS } from "@shared/ipc";
import { parseFilePath, type FilePath, type FilesNodeRef, type FilesResult, type FileStamp } from "@shared/files";
import { asNodeId } from "@shared/physics/schema";
import { trustedRendererIpc } from "../trusted-main-webcontents";
import { deny, machineName, nodeFacts } from "./host-deps";
import { workerRootIndex } from "./index-worker-host";
import { makeFilesService, type FilesService, type FilesServiceDeps } from "./service";

/**
 * The Files channels, behind `trustedRendererIpc`: only the app's own
 * renderer reaches them. Every argument is decoded here before the service
 * sees it; a malformed one answers `invalid-path` (or `no-node` for a bad
 * node reference) and touches nothing.
 */

const MAX_IMPORT_SOURCES = 1000;
const MAX_SOURCE_LENGTH = 4096;
/** Dropped paths held per window before the oldest is forgotten. */
const MAX_DROPPED = 4096;

const invalid = { ok: false, error: "invalid-path" } as const;
const noNode = { ok: false, error: "no-node" } as const;

export const decodeRef = (raw: unknown): FilesNodeRef | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { canvas, node } = raw as Record<string, unknown>;
  if (typeof canvas !== "string" || canvas === "" || canvas.length > 512) return undefined;
  if (typeof node !== "string" || node === "" || node.length > 256) return undefined;
  return { canvas, node: asNodeId(node) };
};

export const decodeStamp = (raw: unknown): FileStamp | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { mtimeMs, size } = raw as Record<string, unknown>;
  if (typeof mtimeMs !== "number" || !Number.isFinite(mtimeMs)) return undefined;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return undefined;
  return { mtimeMs, size };
};

export const decodeSources = (raw: unknown): ReadonlyArray<string> | undefined => {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_IMPORT_SOURCES) return undefined;
  for (const source of raw) {
    if (typeof source !== "string" || source.length > MAX_SOURCE_LENGTH || source.includes("\0") || !isAbsolute(source)) {
      return undefined;
    }
  }
  return raw as ReadonlyArray<string>;
};

/** Decode a ref and a path, then run; a bad one answers without touching the service. */
const withRefPath = <A>(
  rawRef: unknown,
  rawPath: unknown,
  run: (ref: FilesNodeRef, path: FilePath) => Promise<FilesResult<A>>,
): Promise<FilesResult<A>> => {
  const ref = decodeRef(rawRef);
  if (ref === undefined) return Promise.resolve(noNode);
  const path = parseFilePath(rawPath);
  return path === undefined ? Promise.resolve(invalid) : run(ref, path);
};

/** Register the Files channels and return the service (the protocol reads bytes through it). */
export const registerFilesIpc = (carryThreads?: FilesServiceDeps["carryThreads"]): FilesService => {
  const service = makeFilesService({
    node: nodeFacts,
    ...(carryThreads === undefined ? {} : { carryThreads }),
    machineName,
    deny,
    trash: (absolute) => shell.trashItem(absolute),
    openPath: (absolute) => shell.openPath(absolute),
    reveal: (absolute) => shell.showItemInFolder(absolute),
    send: (subscriber, event) => {
      const target = webContents.fromId(subscriber);
      if (target !== undefined && !target.isDestroyed()) target.send(IPC_CHANNELS.filesChanged, event);
    },
    index: workerRootIndex,
  });

  const watched = new Set<number>();
  const subscriberOf = (event: IpcMainInvokeEvent): number => {
    const sender = event.sender;
    if (!watched.has(sender.id)) {
      watched.add(sender.id);
      const id = sender.id;
      sender.once("destroyed", () => {
        watched.delete(id);
        service.closeSubscriber(id);
      });
    }
    return sender.id;
  };

  // OS paths each window's preload saw on a real dropped File. `import`
  // copies only these, each once, so a renderer call cannot name a source.
  const dropped = new Map<number, Set<string>>();
  const forget = (id: number): void => {
    dropped.delete(id);
  };

  const ipc = trustedRendererIpc(ipcMain);
  ipc.on(IPC_CHANNELS.filesDropped, (event, path: unknown) => {
    const decoded = decodeSources([path]);
    if (decoded === undefined) return;
    const id = event.sender.id;
    let held = dropped.get(id);
    if (held === undefined) {
      held = new Set();
      dropped.set(id, held);
      event.sender.once("destroyed", () => forget(id));
    }
    if (held.size >= MAX_DROPPED) held.delete(held.values().next().value!);
    held.add(decoded[0]!);
  });
  ipc.handle(IPC_CHANNELS.filesOpen, (event, rawRef: unknown) => {
    const ref = decodeRef(rawRef);
    return ref === undefined ? noNode : service.open(subscriberOf(event), ref);
  });
  ipc.handle(IPC_CHANNELS.filesClose, (event, rawRef: unknown) => {
    const ref = decodeRef(rawRef);
    return ref === undefined ? noNode : service.close(event.sender.id, ref);
  });
  ipc.handle(IPC_CHANNELS.filesCount, (_event, rawRef: unknown) => {
    const ref = decodeRef(rawRef);
    return ref === undefined ? noNode : service.count(ref);
  });
  ipc.handle(IPC_CHANNELS.filesList, (_event, ref: unknown, dir: unknown) =>
    withRefPath(ref, dir, (r, p) => service.list(r, p)),
  );
  ipc.handle(IPC_CHANNELS.filesSearch, (event, rawRef: unknown, query: unknown, seq: unknown) => {
    const ref = decodeRef(rawRef);
    if (ref === undefined) return noNode;
    if (typeof query !== "string" || query.length > 1024 || typeof seq !== "number" || !Number.isSafeInteger(seq)) {
      return invalid;
    }
    return service.search(subscriberOf(event), ref, query, seq);
  });
  ipc.handle(IPC_CHANNELS.filesRead, (_event, ref: unknown, path: unknown) =>
    withRefPath(ref, path, (r, p) => service.read(r, p)),
  );
  ipc.handle(IPC_CHANNELS.filesWrite, (_event, ref: unknown, path: unknown, text: unknown, base: unknown) =>
    withRefPath(ref, path, async (r, p) => {
      // null: the file is gone and the save writes it back.
      const stamp = base === null ? null : decodeStamp(base);
      if (typeof text !== "string" || stamp === undefined) return invalid;
      return service.write(r, p, text, stamp);
    }),
  );
  ipc.handle(IPC_CHANNELS.filesCreate, (_event, ref: unknown, path: unknown, dir: unknown) =>
    withRefPath(ref, path, async (r, p) => (typeof dir === "boolean" ? service.create(r, p, dir) : invalid)),
  );
  ipc.handle(IPC_CHANNELS.filesRename, (_event, ref: unknown, path: unknown, name: unknown) =>
    withRefPath(ref, path, async (r, p) => (typeof name === "string" ? service.rename(r, p, name) : invalid)),
  );
  ipc.handle(IPC_CHANNELS.filesMove, (_event, ref: unknown, path: unknown, intoDir: unknown) =>
    withRefPath(ref, path, async (r, p) => {
      const into = parseFilePath(intoDir);
      return into === undefined ? invalid : service.move(r, p, into);
    }),
  );
  ipc.handle(IPC_CHANNELS.filesTrash, (_event, ref: unknown, path: unknown) =>
    withRefPath(ref, path, (r, p) => service.trash(r, p)),
  );
  ipc.handle(IPC_CHANNELS.filesImport, (event, ref: unknown, intoDir: unknown, sources: unknown) =>
    withRefPath(ref, intoDir, async (r, p) => {
      const decoded = decodeSources(sources);
      if (decoded === undefined) return invalid;
      const held = dropped.get(event.sender.id);
      if (held === undefined || decoded.some((source) => !held.has(source))) return { ok: false, error: "denied" } as const;
      for (const source of decoded) held.delete(source);
      return service.import(r, p, decoded);
    }),
  );
  ipc.handle(IPC_CHANNELS.filesOpenInDefaultApp, (_event, ref: unknown, path: unknown) =>
    withRefPath(ref, path, (r, p) => service.openInDefaultApp(r, p)),
  );
  ipc.handle(IPC_CHANNELS.filesReveal, (_event, ref: unknown, path: unknown) =>
    withRefPath(ref, path, (r, p) => service.revealInFinder(r, p)),
  );
  return service;
};
