/**
 * The core's handlers of the Files group (src/contract/core/files.ts): the
 * Files node's service in the core (0.11 F2, 0.12 X2). The app's window and
 * every peer machine talk to it: this file owns the one FilesService and
 * FilesRouter, the root index's worker, and the bytes a viewer streams. They
 * are built once, with the handler Layer, and live as long as it does.
 *
 * Main keeps only what is Electron's: the `junto-file:` protocol registration
 * (it pulls chunks by name), the shell a Trash, an Open or a Reveal needs (host
 * operations), and the window a change is sent to (a push, by webContents id).
 * Nothing here touches a window: a subscriber is a number main gave.
 *
 * Main decodes what a window sends before it asks (src/shared/files.ts), and
 * the group's schemas decode it again here, so a handler is handed a ref, a
 * path and a source list that are what their types say. What stays the
 * core's to check is what only it knows: that a source is an absolute OS path
 * and that this window's drop carried it.
 */
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { Effect, Option } from "effect";
import { SqlClient } from "effect/sql";
import {
  FILES_SOURCE_MAX,
  type FileImported,
  type FilePath,
  type FilesChanged,
  type FilesNodeRef,
  type FilesResult,
} from "@shared/files";
import { carryFileThreads } from "../work/file-thread-paths";
import { deny, machineName, nodeFacts } from "../files/host-deps";
import { workerRootIndex } from "../files/index-worker-host";
import { peerSubscribers } from "../files/peer-subscribers";
import { FilesRemoteService } from "../files/link-client";
import { makeFilesRouter } from "../files/router";
import { readerOfHandle, type FileBytesReader } from "../files/bytes";
import { makeFilesService } from "../files/service";
import { coreRunner } from "../core-runner";
import { FILES_CHANGED, type FilesChangedPush } from "../../contract/core/channels";
import { FilesRpcs, type FilesBytesOpened } from "../../contract/core/files";
import type { HostOp } from "../host-ops";
import { host } from "../core-host";
import { CorePushes } from "../push";

/** Dropped paths held per window before the oldest is forgotten. */
const MAX_DROPPED = 4096;
/** The most bytes one `FilesBytesRead` answers; a viewer pulls a large file in these. */
const BYTE_CHUNK_MAX = 1024 * 1024;

const invalid = { ok: false, error: "invalid-path" } as const;
const denied = { ok: false, error: "denied" } as const;
const failed = { ok: false, error: "failed" } as const;

/** An OS path a window may name as a source: absolute, bounded, no NUL. */
const isSource = (raw: string): boolean => raw.length <= FILES_SOURCE_MAX && !raw.includes("\0") && isAbsolute(raw);

declare module "../host-ops" {
  interface HostOps {
    "files.trash": HostOp<{ readonly absolute: string }, void>;
    /** `shell.openPath`: answers "" on success, else the reason. */
    "files.openPath": HostOp<{ readonly absolute: string }, string>;
    "files.reveal": HostOp<{ readonly absolute: string }, void>;
  }
}

/** After a rename or move, carry the node's comment threads: in this process, on its rows. */
const carryThreads = (ref: FilesNodeRef, from: FilePath, to: FilePath): Promise<void> =>
  coreRunner
    .runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) => carryFileThreads(sql, ref.canvas, ref.node, from, to)).pipe(Effect.asVoid),
    )
    .catch((cause: unknown) => {
      console.error("[files] the threads on a moved file could not be carried", cause);
    });

/** A call to the service or router that never fails the group: a throw answers `failed`. */
const ask = <A>(call: () => Promise<FilesResult<A>>): Effect.Effect<FilesResult<A>> =>
  Effect.tryPromise({ try: call, catch: () => new Error("the files service failed") }).pipe(
    Effect.orElseSucceed((): FilesResult<A> => failed),
  );

export const FilesHandlers = FilesRpcs.toLayer(
  Effect.gen(function* () {
    const pushes = yield* CorePushes;
    // Absent in a core with filesRemote off: its Layer is not provided (core-runtime.ts).
    const remote = Option.getOrUndefined(yield* Effect.serviceOption(FilesRemoteService));

    /** A change goes to the window that has the node open, by a push main forwards. */
    const send = (subscriber: number, event: FilesChanged): void => {
      // A peer machine's session: its change goes to the link, not a window.
      if (peerSubscribers.deliver(subscriber, event)) return;
      Effect.runSync(pushes.publish(FILES_CHANGED, { subscriber, event } satisfies FilesChangedPush));
    };

    // The one service, and the one router, for this process.
    const service = makeFilesService({
      node: nodeFacts,
      machineName,
      deny,
      trash: (absolute) => host.call("files.trash", { absolute }),
      openPath: (absolute) => host.call("files.openPath", { absolute }),
      reveal: (absolute) => host.call("files.reveal", { absolute }),
      send,
      index: workerRootIndex,
      carryThreads,
    });
    const router = makeFilesRouter({
      local: service,
      // Another machine's node: the link client this core holds (junto/core.ts).
      remote: () => remote,
      node: nodeFacts,
      machineName,
      send,
    });

    // The dropped paths: OS paths each window's preload saw on a real dropped File, by subscriber.
    const dropped = new Map<number, Set<string>>();

    const holdDropped = (subscriber: number, path: string): void => {
      if (!isSource(path)) return;
      let set = dropped.get(subscriber);
      if (set === undefined) {
        set = new Set();
        dropped.set(subscriber, set);
      }
      const oldest = set.values().next();
      if (set.size >= MAX_DROPPED && oldest.done !== true) set.delete(oldest.value);
      set.add(path);
    };

    // The bytes a viewer streams: an open file a viewer pulls from, by the token main was given.
    const openBytes = new Map<string, FileBytesReader>();

    const closeBytes = (token: string): void => {
      const reader = openBytes.get(token);
      if (reader === undefined) return;
      openBytes.delete(token);
      void reader.close().catch(() => undefined);
    };

    // No handle outlives the handlers that opened it.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const token of [...openBytes.keys()]) closeBytes(token);
      }),
    );

    return {
      FilesOpen: ({ subscriber, ref }) => ask(() => router.open(subscriber, ref)),
      FilesClose: ({ subscriber, ref }) => ask(() => router.close(subscriber, ref)),
      FilesCount: ({ ref }) => ask(() => router.count(ref)),
      FilesList: ({ ref, dir }) => ask(() => router.list(ref, dir)),
      FilesSearch: ({ subscriber, ref, query, seq }) => ask(() => router.search(subscriber, ref, query, seq)),
      FilesRead: ({ ref, path }) => ask(() => router.read(ref, path)),
      FilesWrite: ({ ref, path, text, base }) => ask(() => router.write(ref, path, text, base)),
      FilesCreate: ({ ref, path, dir }) => ask(() => router.create(ref, path, dir)),
      FilesRename: ({ ref, path, name }) => ask(() => router.rename(ref, path, name)),
      FilesMove: ({ ref, path, into }) => ask(() => router.move(ref, path, into)),
      FilesTrash: ({ ref, path }) => ask(() => router.trash(ref, path)),
      FilesImport: ({ subscriber, ref, into, sources }): Effect.Effect<FilesResult<ReadonlyArray<FileImported>>> => {
        if (!sources.every(isSource)) return Effect.succeed(invalid);
        // Copies only what this window's preload saw dropped, each once.
        const seen = dropped.get(subscriber);
        if (seen === undefined || sources.some((source) => !seen.has(source))) return Effect.succeed(denied);
        for (const source of sources) seen.delete(source);
        return ask(() => service.import(ref, into, sources));
      },
      FilesOpenInDefaultApp: ({ ref, path }) => ask(() => service.openInDefaultApp(ref, path)),
      FilesReveal: ({ ref, path }) => ask(() => service.revealInFinder(ref, path)),
      FilesDropped: ({ subscriber, path }) => Effect.sync(() => holdDropped(subscriber, path)),
      FilesWindowGone: ({ subscriber }) =>
        Effect.sync(() => {
          dropped.delete(subscriber);
          router.closeSubscriber(subscriber);
        }),
      FilesBytesOpen: ({ node, path }): Effect.Effect<FilesResult<FilesBytesOpened>> =>
        Effect.gen(function* () {
          const found = yield* ask(() => service.bytes(node, path));
          if (!found.ok) return found;
          const token = randomUUID();
          openBytes.set(token, readerOfHandle(found.value.handle, found.value.size));
          return { ok: true, value: { token, size: found.value.size } } as const;
        }),
      FilesBytesRead: ({ token, offset, length }) =>
        Effect.gen(function* () {
          const reader = openBytes.get(token);
          if (reader === undefined) return { ok: false, error: "not-found" } as const;
          const size = Math.max(1, Math.min(Math.trunc(length), BYTE_CHUNK_MAX));
          const chunk = yield* Effect.tryPromise({
            try: () => reader.read(offset, size),
            catch: () => new Error("the file could not be read"),
          }).pipe(Effect.orElseSucceed(() => undefined));
          if (chunk === undefined) {
            closeBytes(token);
            return failed;
          }
          return { ok: true, value: chunk } as const;
        }),
      FilesBytesClose: ({ token }) => Effect.sync(() => closeBytes(token)),
    };
  }),
);
