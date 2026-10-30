/**
 * The Files node's service, in the core (0.11 F2, 0.12 X2). The app's window
 * and every peer machine talk to it: this file owns the one FilesService and
 * FilesRouter, the root index's worker, and the bytes a viewer streams.
 *
 * Main keeps only what is Electron's: the `junto-file:` protocol registration
 * (it pulls chunks by name), the shell a Trash, an Open or a Reveal needs (host
 * operations), and the window a change is sent to (a push, by webContents id).
 * Nothing here touches a window: a subscriber is a number main gave.
 */
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  parseFilePath,
  type FilePath,
  type FilesChanged,
  type FilesNodeRef,
  type FilesResult,
  type FileStamp,
} from "@shared/files";
import { asNodeId } from "@shared/physics/schema";
import { carryFileThreads } from "../../junto/work/file-thread-paths";
import { deny, machineName, nodeFacts } from "../../junto/files/host-deps";
import { workerRootIndex } from "../../junto/files/index-worker-host";
import { peerSubscribers } from "../../junto/files/peer-subscribers";
import { heldFilesRemote } from "../../junto/files/remote-holder";
import { makeFilesRouter, type FilesRouter } from "../../junto/files/router";
import { readerOfHandle, type FileBytesReader } from "../../junto/files/protocol";
import { makeFilesService, type FilesService } from "../../junto/files/service";
import { coreRunner } from "../../core-runner";
import { FILES_CHANGED, type FilesChangedPush } from "../channels";
import { host, hostOps, type HostOp } from "../host-ops";
import { coreOps, type CoreOp } from "../ops";
import { publish } from "../push";

/** The most a single import call may name; a dropped path is held before it is one. */
const MAX_IMPORT_SOURCES = 1000;
const MAX_SOURCE_LENGTH = 4096;
/** Dropped paths held per window before the oldest is forgotten. */
const MAX_DROPPED = 4096;
/** The most bytes one `files.bytes.read` answers; a viewer pulls a large file in these. */
const BYTE_CHUNK_MAX = 1024 * 1024;

const invalid = { ok: false, error: "invalid-path" } as const;
const noNode = { ok: false, error: "no-node" } as const;

/** A node reference as a window sends it, or undefined. */
const refOf = (raw: unknown): FilesNodeRef | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { canvas, node } = raw as Record<string, unknown>;
  if (typeof canvas !== "string" || canvas === "" || canvas.length > 512) return undefined;
  if (typeof node !== "string" || node === "" || node.length > 256) return undefined;
  return { canvas, node: asNodeId(node) };
};

const stampOf = (raw: unknown): FileStamp | undefined => {
  if (typeof raw !== "object" || raw === null) return undefined;
  const { mtimeMs, size } = raw as Record<string, unknown>;
  if (typeof mtimeMs !== "number" || !Number.isFinite(mtimeMs)) return undefined;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return undefined;
  return { mtimeMs, size };
};

const sourcesOf = (raw: unknown): ReadonlyArray<string> | undefined => {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_IMPORT_SOURCES) return undefined;
  for (const source of raw) {
    if (typeof source !== "string" || source.length > MAX_SOURCE_LENGTH || source.includes("\0") || !isAbsolute(source)) {
      return undefined;
    }
  }
  return raw as ReadonlyArray<string>;
};

// ── the one service, and the one router, for this process ─────────────────

type Held = { readonly service: FilesService; readonly router: FilesRouter };
let held: Held | undefined;

/** A change goes to the window that has the node open, by a push main forwards. */
const send = (subscriber: number, event: FilesChanged): void => {
  // A peer machine's session: its change goes to the link, not a window.
  if (peerSubscribers.deliver(subscriber, event)) return;
  publish(FILES_CHANGED, { subscriber, event } satisfies FilesChangedPush);
};

/** After a rename or move, carry the node's comment threads: in this process, on its rows. */
const carryThreads = (ref: FilesNodeRef, from: FilePath, to: FilePath): Promise<void> =>
  coreRunner
    .runPromise(
      Effect.flatMap(SqlClient.SqlClient, (sql) => carryFileThreads(sql, ref.canvas, ref.node, from, to)).pipe(Effect.asVoid),
    )
    .catch((cause: unknown) => {
      console.error("[files] the threads on a moved file could not be carried", cause);
    });

const both = (): Held => {
  held ??= (() => {
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
      remote: () => heldFilesRemote() ?? undefined,
      node: nodeFacts,
      machineName,
      send,
    });
    return { service, router };
  })();
  return held;
};

// ── the dropped paths, by window ───────────────────────────────────────────

/** OS paths each window's preload saw on a real dropped File, by subscriber. */
const dropped = new Map<number, Set<string>>();

const holdDropped = (subscriber: number, raw: unknown): void => {
  const decoded = sourcesOf([raw]);
  if (decoded === undefined) return;
  let set = dropped.get(subscriber);
  if (set === undefined) {
    set = new Set();
    dropped.set(subscriber, set);
  }
  if (set.size >= MAX_DROPPED) set.delete(set.values().next().value!);
  set.add(decoded[0]!);
};

// ── the bytes a viewer streams ─────────────────────────────────────────────

/** An open file a viewer pulls from, by the token main was given. */
const openBytes = new Map<string, FileBytesReader>();

const closeBytes = (token: string): void => {
  const reader = openBytes.get(token);
  if (reader === undefined) return;
  openBytes.delete(token);
  void reader.close().catch(() => undefined);
};

// ── what main is asked ────────────────────────────────────────────────────

type WithSubscriber = { readonly subscriber: number };
type WithRef = WithSubscriber & { readonly ref: unknown };

declare module "../ops" {
  interface CoreOps {
    "files.open": CoreOp<WithRef, FilesResult<unknown>>;
    "files.close": CoreOp<WithRef, FilesResult<null>>;
    "files.count": CoreOp<{ readonly ref: unknown }, FilesResult<unknown>>;
    "files.list": CoreOp<{ readonly ref: unknown; readonly dir: unknown }, FilesResult<unknown>>;
    "files.search": CoreOp<WithRef & { readonly query: unknown; readonly seq: unknown }, FilesResult<unknown>>;
    "files.read": CoreOp<{ readonly ref: unknown; readonly path: unknown }, FilesResult<unknown>>;
    "files.write": CoreOp<{ readonly ref: unknown; readonly path: unknown; readonly text: unknown; readonly base: unknown }, FilesResult<unknown>>;
    "files.create": CoreOp<{ readonly ref: unknown; readonly path: unknown; readonly dir: unknown }, FilesResult<unknown>>;
    "files.rename": CoreOp<{ readonly ref: unknown; readonly path: unknown; readonly name: unknown }, FilesResult<unknown>>;
    "files.move": CoreOp<{ readonly ref: unknown; readonly path: unknown; readonly into: unknown }, FilesResult<unknown>>;
    "files.trash": CoreOp<{ readonly ref: unknown; readonly path: unknown }, FilesResult<unknown>>;
    "files.import": CoreOp<WithRef & { readonly into: unknown; readonly sources: unknown }, FilesResult<unknown>>;
    "files.openInDefaultApp": CoreOp<{ readonly ref: unknown; readonly path: unknown }, FilesResult<unknown>>;
    "files.reveal": CoreOp<{ readonly ref: unknown; readonly path: unknown }, FilesResult<unknown>>;
    "files.dropped": CoreOp<{ readonly subscriber: number; readonly path: unknown }, void>;
    "files.windowGone": CoreOp<{ readonly subscriber: number }, void>;
    "files.bytesOpen": CoreOp<{ readonly node: string; readonly path: unknown }, FilesResult<{ readonly token: string; readonly size: number }>>;
    "files.bytesRead": CoreOp<{ readonly token: string; readonly offset: number; readonly length: number }, FilesResult<Uint8Array>>;
    "files.bytesClose": CoreOp<{ readonly token: string }, void>;
  }
}

declare module "../host-ops" {
  interface HostOps {
    "files.trash": HostOp<{ readonly absolute: string }, void>;
    /** `shell.openPath`: answers "" on success, else the reason. */
    "files.openPath": HostOp<{ readonly absolute: string }, string>;
    "files.reveal": HostOp<{ readonly absolute: string }, void>;
  }
}

/** A decoded ref and path, or the refusal the window shows. */
const at = <A>(
  rawRef: unknown,
  rawPath: unknown,
  run: (ref: FilesNodeRef, path: FilePath) => Effect.Effect<FilesResult<A>>,
): Effect.Effect<FilesResult<A>> => {
  const ref = refOf(rawRef);
  if (ref === undefined) return Effect.succeed(noNode);
  const path = parseFilePath(rawPath);
  return path === undefined ? Effect.succeed(invalid) : run(ref, path);
};

const ask = <A>(call: () => Promise<FilesResult<A>>): Effect.Effect<FilesResult<A>> =>
  Effect.tryPromise({ try: call, catch: () => new Error("the files service failed") }).pipe(
    Effect.orElseSucceed(() => ({ ok: false, error: "failed" }) as const),
  );

coreOps({
  "files.open": ({ subscriber, ref }) => {
    const parsed = refOf(ref);
    return parsed === undefined ? Effect.succeed(noNode) : ask(() => both().router.open(subscriber, parsed));
  },
  "files.close": ({ subscriber, ref }) => {
    const parsed = refOf(ref);
    return parsed === undefined ? Effect.succeed(noNode) : ask(() => both().router.close(subscriber, parsed));
  },
  "files.count": ({ ref }) => {
    const parsed = refOf(ref);
    return parsed === undefined ? Effect.succeed(noNode) : ask(() => both().router.count(parsed));
  },
  "files.list": ({ ref, dir }) => at(ref, dir, (parsed, path) => ask(() => both().router.list(parsed, path))),
  "files.search": ({ subscriber, ref, query, seq }) => {
    const parsed = refOf(ref);
    if (parsed === undefined) return Effect.succeed(noNode);
    if (typeof query !== "string" || query.length > 1024 || typeof seq !== "number" || !Number.isSafeInteger(seq)) {
      return Effect.succeed(invalid);
    }
    return ask(() => both().router.search(subscriber, parsed, query, seq));
  },
  "files.read": ({ ref, path }) => at(ref, path, (parsed, at_) => ask(() => both().router.read(parsed, at_))),
  "files.write": ({ ref, path, text, base }) =>
    at(ref, path, (parsed, at_) => {
      // null: the file is gone and the save writes it back.
      const stamp = base === null ? null : stampOf(base);
      if (typeof text !== "string" || stamp === undefined) return Effect.succeed(invalid);
      return ask(() => both().router.write(parsed, at_, text, stamp));
    }),
  "files.create": ({ ref, path, dir }) =>
    at(ref, path, (parsed, at_) =>
      typeof dir === "boolean" ? ask(() => both().router.create(parsed, at_, dir)) : Effect.succeed(invalid),
    ),
  "files.rename": ({ ref, path, name }) =>
    at(ref, path, (parsed, at_) =>
      typeof name === "string" ? ask(() => both().router.rename(parsed, at_, name)) : Effect.succeed(invalid),
    ),
  "files.move": ({ ref, path, into }) =>
    at(ref, path, (parsed, at_) => {
      const target = parseFilePath(into);
      return target === undefined ? Effect.succeed(invalid) : ask(() => both().router.move(parsed, at_, target));
    }),
  "files.trash": ({ ref, path }) => at(ref, path, (parsed, at_) => ask(() => both().router.trash(parsed, at_))),
  "files.import": ({ subscriber, ref, into, sources }) =>
    at(ref, into, (parsed, path) => {
      const decoded = sourcesOf(sources);
      if (decoded === undefined) return Effect.succeed(invalid);
      // Copies only what this window's preload saw dropped, each once.
      const seen = dropped.get(subscriber);
      if (seen === undefined || decoded.some((source) => !seen.has(source))) {
        return Effect.succeed({ ok: false, error: "denied" } as const);
      }
      for (const source of decoded) seen.delete(source);
      return ask(() => both().service.import(parsed, path, decoded));
    }),
  "files.openInDefaultApp": ({ ref, path }) =>
    at(ref, path, (parsed, at_) => ask(() => both().service.openInDefaultApp(parsed, at_))),
  "files.reveal": ({ ref, path }) => at(ref, path, (parsed, at_) => ask(() => both().service.revealInFinder(parsed, at_))),
  "files.dropped": ({ subscriber, path }) => Effect.sync(() => holdDropped(subscriber, path)),
  "files.windowGone": ({ subscriber }) =>
    Effect.sync(() => {
      dropped.delete(subscriber);
      both().router.closeSubscriber(subscriber);
    }),
  "files.bytesOpen": ({ node, path }) =>
    Effect.gen(function* () {
      const parsed = parseFilePath(path);
      if (parsed === undefined) return invalid;
      const found = yield* ask(() => both().service.bytes(node, parsed));
      if (!found.ok) return found;
      const token = randomUUID();
      openBytes.set(token, readerOfHandle(found.value.handle, found.value.size));
      return { ok: true, value: { token, size: found.value.size } } as const;
    }),
  "files.bytesRead": ({ token, offset, length }) =>
    Effect.gen(function* () {
      const reader = openBytes.get(token);
      if (reader === undefined) return { ok: false, error: "not-found" } as const;
      const size = Math.max(1, Math.min(Math.trunc(length), BYTE_CHUNK_MAX));
      if (!Number.isSafeInteger(offset) || offset < 0) return invalid;
      const chunk = yield* Effect.tryPromise({
        try: () => reader.read(offset, size),
        catch: () => new Error("the file could not be read"),
      }).pipe(Effect.orElseSucceed(() => undefined));
      if (chunk === undefined) {
        closeBytes(token);
        return { ok: false, error: "failed" } as const;
      }
      return { ok: true, value: chunk } as const;
    }),
  "files.bytesClose": ({ token }) => Effect.sync(() => closeBytes(token)),
});
