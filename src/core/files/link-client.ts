import { Context, Effect, Layer } from "effect";
import type {
  FileEntry, FileImported, FilePath, FileRead, FilesCount, FilesNodeRef, FilesResult, FilesRoot,
  FilesSearchResult, FileStamp,
} from "@shared/files";
import { createHash } from "node:crypto";
import { open as openFile } from "node:fs/promises";
import { basename } from "node:path";
import { FilesLinkClosed, FilesRefused, fitsOneFrame, type FilesEvent, type RemoteChange } from "@shared/files-link";
import { decodeChunk, encodeChunk, FILE_BYTES_CHUNK_MAX, FILE_BYTES_IN_FLIGHT, FILE_BYTES_UPLOAD_MAX } from "@shared/files-bytes-link";
import { FILE_TEXT_MAX_BYTES, isFileName } from "@shared/files";
import { fileMime } from "@shared/file-url";
import type { NodeId } from "@shared/physics/schema";
import { linkClient } from "../link/contract";
import type { LinkEventContext, MachineLinkError } from "../link/types";
import { MachineRepository } from "../machines/repository";
import { FilesLink } from "./link";
import { FileBytesLink } from "./bytes-link";
import type { FileBytesReader } from "./bytes";

/**
 * The window machine's end of the `files` channel (0.12, X1d): one function
 * per op, over the link to the machine that holds the node.
 *
 * `unreachable` is made here, from the link, and nowhere else: it means no
 * link to that machine is open, or the link was lost during the call. The
 * host's own refusals (`denied` for a peer that is not the editor, `elsewhere`
 * for a node on another host) are answers and cross as they are, so a card
 * never says a machine is offline when it is not.
 *
 * Nothing is cached: a listing, a name or a text is returned and forgotten. A
 * save in flight when the link drops is refused `unreachable`, never queued.
 */

export type { RemoteChange };

/** Link failures that mean no usable link; the rest are this call failing. */
const NO_LINK_TAGS: ReadonlySet<string> = new Set(["LinkClosed", "LinkPeerNotPinned", "LinkBuildMismatch", "LinkHelloRefused"]);
const NO_LINK_REASONS: ReadonlySet<string> = new Set([
  "not-linked", "not-configured", "shutting-down", "route-incomplete", "other-installation", "not-admitted", "channel-unavailable",
  "listener-unavailable", "asleep",
]);
const noLink = (failure: { readonly _tag?: string; readonly reason?: string }): boolean =>
  failure._tag !== undefined && (NO_LINK_TAGS.has(failure._tag) || (failure._tag === "LinkUnavailable" && NO_LINK_REASONS.has(failure.reason ?? "")));

/** What a call over the link ends in besides its answer: the host's refusal, the host's link closing, or the link's own failure. */
type CallFailure = FilesRefused | FilesLinkClosed | MachineLinkError;

export type FilesRemoteOptions = { readonly now?: () => number };

export const makeFilesRemote = Effect.fn("FilesRemote.make")(function* (options: FilesRemoteOptions = {}) {
  const files = yield* linkClient(FilesLink);
  const bytesLink = yield* linkClient(FileBytesLink);
  const machines = yield* MachineRepository;
  const context = yield* Effect.context<never>();
  const now = options.now ?? Date.now;
  /** When each machine last answered, or sent a change, or its link went down. In memory only. */
  const reached = new Map<string, number>();
  /** The nodes a window has open on each machine, to open again when its link comes back. */
  const watching = new Map<string, Map<NodeId, string>>();
  const listeners = new Set<(change: RemoteChange) => void>();

  const emit = (machine: string, change: RemoteChange["change"]): void => {
    for (const listener of listeners) listener({ machine, change });
  };
  const unreachable = (machine: string) => ({ ok: false, error: "unreachable", machine, lastReachedAt: reached.get(machine) ?? null }) as const;
  const failed = { ok: false, error: "failed" } as const;

  /** The answer, or the refusal this call ends in: `unreachable` only from the link, never from the host. */
  const answer = async <A>(machine: string, call: Effect.Effect<A, CallFailure>): Promise<FilesResult<A>> => {
    const result = await Effect.runPromiseWith(context)(Effect.result(call));
    if (result._tag === "Success") {
      reached.set(machine, now());
      return ok(result.success);
    }
    const failure = result.failure;
    // The host answered, so it was reached.
    if (failure instanceof FilesRefused) {
      reached.set(machine, now());
      return { ok: false, error: failure.error };
    }
    // The link the host was serving us on closed: no link, as when we lose it ourselves.
    return failure instanceof FilesLinkClosed || noLink(failure) ? unreachable(machine) : failed;
  };

  const ok = <A>(value: A): FilesResult<A> => ({ ok: true, value });
  const where = (ref: FilesNodeRef) => ({ canvas: ref.canvas, node: ref.node }) as const;

  /**
   * The window this end keeps on each machine's `file-bytes` channel: at most
   * two byte requests out at once, the rest wait here in order. The host
   * refuses a third, so this is what keeps a large read from being refused.
   */
  const lanes = new Map<string, { out: number; readonly waiting: Array<() => void> }>();
  const inLane = async <A>(machine: string, call: () => Promise<A>): Promise<A> => {
    let lane = lanes.get(machine);
    if (lane === undefined) { lane = { out: 0, waiting: [] }; lanes.set(machine, lane); }
    const held = lane;
    if (held.out >= FILE_BYTES_IN_FLIGHT) await new Promise<void>((resume) => held.waiting.push(resume));
    held.out += 1;
    try {
      return await call();
    } finally {
      held.out -= 1;
      held.waiting.shift()?.();
      if (held.out === 0 && held.waiting.length === 0 && lanes.get(machine) === held) lanes.delete(machine);
    }
  };
  const bytesCall = <A>(machine: string, call: () => Effect.Effect<A, CallFailure>): Promise<FilesResult<A>> =>
    inLane(machine, () => answer(machine, call()));

  /** A reader of a file on another machine: each read one chunk over the link, at most 48 KiB. */
  const bytes = async (machine: string, ref: FilesNodeRef, path: FilePath): Promise<FilesResult<FileBytesReader & { readonly stamp: FileStamp }>> => {
    const opened = await bytesCall(machine, () => bytesLink.ReadOpen(machine, { ...where(ref), path }));
    if (!opened.ok) return opened;
    const { stream, size, stamp } = opened.value;
    let closed = false;
    return ok({
      size, stamp,
      read: async (offset, length) => {
        if (closed) throw new Error("the stream is closed");
        if (offset >= size) return new Uint8Array(0);
        const asked = Math.max(1, Math.min(Math.trunc(length), FILE_BYTES_CHUNK_MAX, size - offset));
        const chunk = await bytesCall(machine, () => bytesLink.ReadChunk(machine, { stream, offset, length: asked }));
        if (!chunk.ok) throw new Error(`the file could not be read: ${chunk.error}`);
        const data = decodeChunk(chunk.value.data);
        // The host answers no more than it was asked; more is not this file.
        if (data === undefined || data.byteLength > asked) throw new Error("the file's bytes are not what was asked");
        return data;
      },
      close: async () => {
        if (closed) return;
        closed = true;
        await bytesCall(machine, () => bytesLink.ReadClose(machine, { stream }));
      },
    });
  };

  /** A text too large for one frame, read whole in chunks; over the text bound it is too large, as here. */
  const readLarge = async (machine: string, ref: FilesNodeRef, path: FilePath): Promise<FilesResult<FileRead>> => {
    const reader = await bytes(machine, ref, path);
    if (!reader.ok) return reader;
    try {
      const stamp = reader.value.stamp;
      if (reader.value.size > FILE_TEXT_MAX_BYTES) return ok({ kind: "too-large", size: reader.value.size, stamp });
      const parts: Uint8Array[] = [];
      let offset = 0;
      while (offset < reader.value.size) {
        const part = await reader.value.read(offset, FILE_BYTES_CHUNK_MAX);
        if (part.byteLength === 0) break;
        parts.push(part);
        offset += part.byteLength;
      }
      const whole = Buffer.concat(parts);
      // As the host reads a text: a NUL or bytes that are not UTF-8 make it binary.
      const binary = (): FilesResult<FileRead> => ok({ kind: "binary", mime: fileMime(path), stamp });
      if (whole.includes(0)) return binary();
      try {
        return ok({ kind: "text", text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(whole), stamp });
      } catch {
        return binary();
      }
    } catch {
      return failed;
    } finally {
      void reader.value.close().catch(() => undefined);
    }
  };

  /**
   * Files dropped on this machine, copied onto a node on another: each staged
   * there in chunks and hashed as it goes, then imported there. A folder is
   * refused `is-dir`. A file over the upload bound is refused `too-large`.
   */
  const importFiles = async (machine: string, ref: FilesNodeRef, into: FilePath, sources: ReadonlyArray<string>): Promise<FilesResult<ReadonlyArray<FileImported>>> => {
    const imported: FileImported[] = [];
    for (const source of sources) {
      const one = await importOne(machine, ref, into, source);
      if (!one.ok) return one;
      imported.push(...one.value);
    }
    return ok(imported);
  };
  const importOne = async (machine: string, ref: FilesNodeRef, into: FilePath, source: string): Promise<FilesResult<ReadonlyArray<FileImported>>> => {
    const name = basename(source);
    if (!isFileName(name)) return { ok: false, error: "invalid-path" };
    let handle;
    try { handle = await openFile(source, "r"); } catch { return { ok: false, error: "not-found" }; }
    try {
      const info = await handle.stat();
      if (info.isDirectory()) return { ok: false, error: "is-dir" };
      if (!info.isFile()) return { ok: false, error: "denied" };
      if (info.size > FILE_BYTES_UPLOAD_MAX) return { ok: false, error: "too-large" };
      const opened = await bytesCall(machine, () => bytesLink.ImportOpen(machine, { ...where(ref), into, name, size: info.size }));
      if (!opened.ok) return opened;
      const upload = opened.value.upload;
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(FILE_BYTES_CHUNK_MAX);
      let offset = 0;
      while (offset < info.size) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(FILE_BYTES_CHUNK_MAX, info.size - offset), offset);
        // Shorter than its stat: the file changed under the drop, and nothing is imported.
        if (bytesRead === 0) return failed;
        const part = buffer.subarray(0, bytesRead);
        hash.update(part);
        const sent = await bytesCall(machine, () => bytesLink.ImportChunk(machine, { upload, offset, data: encodeChunk(part) }));
        if (!sent.ok) return sent;
        offset += bytesRead;
      }
      return await bytesCall(machine, () => bytesLink.ImportEnd(machine, { upload, sha256: hash.digest("hex") }));
    } catch {
      return failed;
    } finally {
      await handle.close().catch(() => undefined);
    }
  };

  const open = async (machine: string, ref: FilesNodeRef): Promise<FilesResult<FilesRoot>> => {
    const result = await answer(machine, files.Open(machine, where(ref)));
    // A node opened while the machine is unreachable is watched too: when the link returns it opens again and says back.
    if (result.ok || result.error === "unreachable") {
      const nodes = watching.get(machine) ?? new Map<NodeId, string>();
      nodes.set(ref.node, ref.canvas);
      watching.set(machine, nodes);
    }
    return result;
  };

  const forget = (machine: string, node: NodeId): void => {
    const nodes = watching.get(machine);
    nodes?.delete(node);
    if (nodes?.size === 0) watching.delete(machine);
  };

  const close = async (machine: string, ref: FilesNodeRef): Promise<FilesResult<null>> => {
    forget(machine, ref.node);
    return answer(machine, files.Close(machine, where(ref)));
  };

  /** The link came back: open every watched node again and say `back`, or why it will not. */
  const reopen = async (machine: string): Promise<void> => {
    for (const [node, canvas] of [...(watching.get(machine) ?? [])]) {
      const result = await answer(machine, files.Open(machine, { canvas, node }));
      if (result.ok) {
        emit(machine, { node: node, kind: "back" });
        continue;
      }
      if (result.error === "unreachable" || result.error === "not-set-up") return;
      forget(machine, node);
      emit(machine, { node: node, kind: "closed", error: result.error });
    }
  };

  /** A change a host sent for a node a window here has open on that machine; anything else is dropped. */
  const onEvent = (context: LinkEventContext, event: FilesEvent): Effect.Effect<void, unknown> => Effect.gen(function* () {
    const machine = context.peer.machineName;
    const peer = yield* machines.peer(machine);
    if (peer?.installationId !== context.peer.installationId) return;
    if (watching.get(machine)?.has(event.node) !== true) return;
    reached.set(machine, now());
    if (event.kind === "closed") forget(machine, event.node);
    emit(machine, event);
  });

  const onOpened = (context: LinkEventContext): Effect.Effect<void> => Effect.sync(() => {
    const machine = context.peer.machineName;
    reached.set(machine, now());
    // The hook may not wait on its own link: the reopen runs after it returns.
    void reopen(machine);
  });

  const onClosed = (context: LinkEventContext): Effect.Effect<void> => Effect.sync(() => {
    const machine = context.peer.machineName;
    reached.set(machine, now());
    for (const node of watching.get(machine)?.keys() ?? []) {
      emit(machine, { node: node, kind: "closed", error: "unreachable", machine, lastReachedAt: reached.get(machine) ?? null });
    }
  });

  return {
    onEvent, onOpened, onClosed,
    /** Changes under nodes opened here: a host's, and `closed` with `unreachable` then `back` as a link drops and returns. */
    onChange: (listener: (change: RemoteChange) => void): (() => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    open, close,
    count: (machine: string, ref: FilesNodeRef): Promise<FilesResult<FilesCount>> =>
      answer(machine, files.Count(machine, where(ref))),
    list: (machine: string, ref: FilesNodeRef, dir: FilePath): Promise<FilesResult<ReadonlyArray<FileEntry>>> =>
      answer(machine, files.List(machine, { ...where(ref), dir })),
    read: async (machine: string, ref: FilesNodeRef, path: FilePath): Promise<FilesResult<FileRead>> => {
      const result = await answer(machine, files.Read(machine, { ...where(ref), path }));
      // A text the host could not send in one frame comes in chunks; one over the text bound stays too large.
      return result.ok && result.value.kind === "too-large" && result.value.size <= FILE_TEXT_MAX_BYTES ? readLarge(machine, ref, path) : result;
    },
    write: async (machine: string, ref: FilesNodeRef, path: FilePath, text: string, base: FileStamp | null): Promise<FilesResult<FileStamp>> =>
      // A text over one frame is refused here, before the link: X3 sends it in chunks.
      fitsOneFrame(text)
        ? answer(machine, files.Write(machine, { ...where(ref), path, text, base }))
        : { ok: false, error: "too-large" },
    create: (machine: string, ref: FilesNodeRef, path: FilePath, dir: boolean): Promise<FilesResult<FileEntry>> =>
      answer(machine, files.Create(machine, { ...where(ref), path, dir })),
    rename: (machine: string, ref: FilesNodeRef, path: FilePath, name: string): Promise<FilesResult<FilePath>> =>
      answer(machine, files.Rename(machine, { ...where(ref), path, name })),
    move: (machine: string, ref: FilesNodeRef, path: FilePath, into: FilePath): Promise<FilesResult<FilePath>> =>
      answer(machine, files.Move(machine, { ...where(ref), path, into })),
    trash: (machine: string, ref: FilesNodeRef, path: FilePath): Promise<FilesResult<null>> =>
      answer(machine, files.Trash(machine, { ...where(ref), path })),
    import: importFiles,
    bytes,
    search: (machine: string, ref: FilesNodeRef, query: string, seq: number): Promise<FilesResult<FilesSearchResult>> =>
      answer(machine, files.Search(machine, { ...where(ref), query, seq })),
    /** The nodes opened here on a machine; for tests and the router. */
    watched: (machine: string): ReadonlyArray<string> => [...(watching.get(machine)?.keys() ?? [])],
  };
});

export type FilesRemote = Effect.Success<ReturnType<typeof makeFilesRemote>>;

/**
 * The remote of a core with `filesRemote` off. It has no link to use, so every
 * op is refused `denied`, as the host's channel refuses every op while it is
 * off, and it never says a change. The router does not ask it while the
 * feature is off; it is here so the runtime always has a `FilesRemote` to give.
 */
const refusedOff = async (): Promise<FilesResult<never>> => ({ ok: false, error: "denied" });
export const filesRemoteOff: FilesRemote = {
  onEvent: () => Effect.void,
  onOpened: () => Effect.void,
  onClosed: () => Effect.void,
  onChange: () => () => undefined,
  open: refusedOff, close: refusedOff, count: refusedOff, list: refusedOff, read: refusedOff, write: refusedOff,
  create: refusedOff, rename: refusedOff, move: refusedOff, trash: refusedOff, import: refusedOff, search: refusedOff, bytes: refusedOff,
  watched: () => [],
};

/**
 * The core's one `FilesRemote`, held by its runtime: the Layer builds it once,
 * and the link channel and the files router both take it from the context. With
 * `enabled: false` (`filesRemote` off) it holds `filesRemoteOff` and opens no link.
 */
export class FilesRemoteService extends Context.Service<FilesRemoteService, FilesRemote>()("@junto/FilesRemote") {}

export const filesRemoteLayer = (options: FilesRemoteOptions & { readonly enabled?: boolean } = {}) =>
  Layer.effect(FilesRemoteService, options.enabled === false ? Effect.succeed(filesRemoteOff) : makeFilesRemote(options));
