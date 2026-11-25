import { createHash, randomBytes, type Hash } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, open, rm, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { Effect } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import type { FileImported, FilePath, FilesError, FilesNodeRef, FilesResult, FileStamp } from "@shared/files";
import {
  decodeChunk, encodeChunk, FILE_BYTES_CHUNK_MAX, FILE_BYTES_UPLOAD_MAX, FileBytesChunk, FileBytesDone, FileBytesImportChunk,
  FileBytesImported, FileBytesImportEnd, FileBytesImportOpen, FileBytesImportOpened, FileBytesReadChunk, FileBytesReadClose,
  FileBytesReadOpen, FileBytesReadOpened,
} from "@shared/files-bytes-link";
import { FilesLinkClosed, FilesLinkFailure, FilesRefused, type HostFilesError } from "@shared/files-link";
import { bindLinkChannel, linkContract, type LinkContractChannel } from "../link/contract";
import type { LinkChannelContext, LinkEventContext } from "../link/types";
import { MachineRepository } from "../machines/repository";
import { ModelRecords } from "../model/records";
import { ModelService } from "../model/service";
import { filesStageParent, stageFreeBytes, sweepFilesStages } from "../../node/files-stage";
import { admitFilesPeer } from "./link";
import type { FilesService } from "./service";

/**
 * The answering end of the link's `file-bytes` channel (0.12.1, plan
 * 12-files-over-ssh, X3, under remote-security's seven terms): a peer reads a
 * file under one of this machine's Files nodes in chunks, and stages a file
 * dropped on its machine here in chunks, which is then imported.
 *
 * A request is the window's credit: the session refuses a third byte request
 * from a peer while two are unanswered (`overWindow`), and that closes the
 * stream or upload it named. Every request runs `admitFilesPeer` again, against
 * the canvas the stream or upload was opened for. A stream or upload id is 128
 * random bits, held by the link session that made it, and never names a path.
 *
 * What crosses: bytes, and a dropped file's name, to the other machine only.
 * A log line holds the op, the node id and the outcome.
 */

/** The service calls a peer's bytes reach. */
export type FileBytesHost = Pick<FilesService, "bytesAt" | "import">;

export const FileBytesLink = linkContract("file-bytes", RpcGroup.make(
  Rpc.make("ReadOpen", { payload: FileBytesReadOpen, success: FileBytesReadOpened, error: FilesLinkFailure }),
  Rpc.make("ReadChunk", { payload: FileBytesReadChunk, success: FileBytesChunk, error: FilesLinkFailure }),
  Rpc.make("ReadClose", { payload: FileBytesReadClose, success: FileBytesDone, error: FilesLinkFailure }),
  Rpc.make("ImportOpen", { payload: FileBytesImportOpen, success: FileBytesImportOpened, error: FilesLinkFailure }),
  Rpc.make("ImportChunk", { payload: FileBytesImportChunk, success: FileBytesDone, error: FilesLinkFailure }),
  Rpc.make("ImportEnd", { payload: FileBytesImportEnd, success: FileBytesImported, error: FilesLinkFailure }),
));

/** Bounds per link session, and for all of this machine's stages (remote-security, X3 terms 4 and 5). */
export const FILE_BYTES_LIMITS = {
  streams: 8,
  uploads: 4,
  idleMs: 60_000,
  stagedTotal: 1024 * 1024 * 1024,
  /** What an upload must leave free on the stage's filesystem. */
  freeFloor: 1024 * 1024 * 1024,
} as const;
export type FileBytesLimits = { readonly [K in keyof typeof FILE_BYTES_LIMITS]: number };

type Owned = { readonly canvas: string; readonly node: FilesNodeRef["node"]; timer: ReturnType<typeof setTimeout> | undefined };
type Stream = Owned & { readonly handle: FileHandle; readonly size: number };
type Upload = Owned & {
  readonly directory: string;
  readonly file: string;
  readonly handle: FileHandle;
  readonly size: number;
  readonly into: FilePath;
  written: number;
  readonly hash: Hash;
};
type Session = { readonly streams: Map<string, Stream>; readonly uploads: Map<string, Upload> };

const hostError = (error: FilesError): HostFilesError => (error === "unreachable" ? "failed" : error);
const refusedWith = (error: FilesError): FilesRefused => new FilesRefused({ error: hostError(error) });
const newId = (): string => randomBytes(16).toString("hex");

export type FileBytesLinkOptions = {
  /** False while `filesRemote` is off: bound all the same, and every op is refused `denied`. */
  readonly enabled?: boolean;
  readonly service: () => FileBytesHost | undefined;
  /** This core's Junto home, which names its stage folder. */
  readonly juntoHome: string;
  readonly limits?: Partial<FileBytesLimits>;
};

export const makeFileBytesLinkChannel = Effect.fn("FileBytesLink.make")(function* (options: FileBytesLinkOptions) {
  const services = yield* Effect.context<ModelService | ModelRecords | MachineRepository>();
  const limits: FileBytesLimits = { ...FILE_BYTES_LIMITS, ...options.limits };
  const sessions = new Map<string, Session>();
  let stagedBytes = 0;
  let stage: string | undefined;

  /** The stage folder, made and swept once, at the first upload after start. */
  const stageParent = (): string => {
    if (stage !== undefined) return stage;
    const parent = filesStageParent(options.juntoHome);
    const swept = sweepFilesStages(parent);
    if (swept > 0) Effect.runSync(Effect.logInfo("files stages swept", { area: "file-bytes", removed: swept }));
    stage = parent;
    return parent;
  };
  // The stage left by a crash goes at start, not at the first drop.
  if (options.enabled !== false) yield* Effect.sync(() => { try { stageParent(); } catch { stage = undefined; } });

  const sessionOf = (context: LinkEventContext): Session => {
    let held = sessions.get(context.sessionId);
    if (held === undefined) { held = { streams: new Map(), uploads: new Map() }; sessions.set(context.sessionId, held); }
    return held;
  };

  const closeStream = (session: Session, id: string): void => {
    const stream = session.streams.get(id);
    if (stream === undefined) return;
    session.streams.delete(id);
    clearTimeout(stream.timer);
    void stream.handle.close().catch(() => undefined);
  };
  const dropUpload = (session: Session, id: string): Promise<void> => {
    const upload = session.uploads.get(id);
    if (upload === undefined) return Promise.resolve();
    session.uploads.delete(id);
    clearTimeout(upload.timer);
    stagedBytes -= upload.size;
    return upload.handle.close().catch(() => undefined).then(() => rm(upload.directory, { recursive: true, force: true })).catch(() => undefined);
  };
  /** Idle for the limit, a stream or upload is closed and its stage removed. */
  const touch = (session: Session, id: string, held: Owned, kind: "stream" | "upload"): void => {
    clearTimeout(held.timer);
    held.timer = setTimeout(() => { if (kind === "stream") closeStream(session, id); else void dropUpload(session, id); }, limits.idleMs);
    held.timer.unref?.();
  };

  /** The gate, the admission and the service, in that order, as `files` runs every op. */
  const serve = <A>(
    op: string,
    ref: FilesNodeRef,
    context: LinkChannelContext,
    run: (host: FileBytesHost, session: Session) => Promise<FilesResult<A>>,
  ): Effect.Effect<A, FilesLinkFailure> => Effect.gen(function* () {
    const refuse = (error: FilesError) =>
      Effect.logInfo("file bytes refused", { op, node: ref.node, outcome: error }).pipe(Effect.andThen(Effect.fail(refusedWith(error))));
    if (options.enabled === false) return yield* refuse("denied");
    const admitted = yield* admitFilesPeer(context, ref.canvas).pipe(
      Effect.provideContext(services),
      Effect.catch((cause) => cause instanceof FilesLinkClosed ? Effect.fail(cause) : Effect.die(cause)),
    );
    if (admitted !== "ok") return yield* refuse(admitted);
    const host = options.service();
    if (host === undefined) return yield* refuse("failed");
    const result = yield* Effect.promise(async () => run(host, sessionOf(context))).pipe(
      // The cause stays here, never on the wire.
      Effect.catchDefect(() => Effect.succeed<FilesResult<A>>({ ok: false, error: "failed" })),
    );
    if (!result.ok) return yield* refuse(result.error);
    yield* Effect.logDebug("file bytes op", { op, node: ref.node, outcome: "ok" });
    return result.value;
  }).pipe(Effect.annotateLogs({ area: "file-bytes", peer: context.peer.machineName }));

  /** A stream or upload this session holds, named with the canvas and node it was opened for; anything else is not found. */
  const owned = <H extends Owned>(held: H | undefined): { readonly ref: FilesNodeRef; readonly held: H } | undefined =>
    held === undefined ? undefined : { ref: { canvas: held.canvas, node: held.node }, held };
  const nowhere = (context: LinkChannelContext, op: string) =>
    Effect.logInfo("file bytes refused", { op, outcome: "not-found" }).pipe(
      Effect.annotateLogs({ area: "file-bytes", peer: context.peer.machineName }), Effect.andThen(Effect.fail(refusedWith("not-found"))));

  const channel: LinkContractChannel = bindLinkChannel(FileBytesLink, {
    requests: {
      /** Idempotent apart from the handle it holds, which idle or close lets go. */
      ReadOpen: (request, context) => serve("ReadOpen", request, context, async (host, session) => {
        if (session.streams.size >= limits.streams) return { ok: false, error: "denied" };
        const found = await host.bytesAt({ canvas: request.canvas, node: request.node }, request.path);
        if (!found.ok) return found;
        const id = newId();
        const stream: Stream = { canvas: request.canvas, node: request.node, timer: undefined, handle: found.value.handle, size: found.value.size };
        session.streams.set(id, stream);
        touch(session, id, stream, "stream");
        return { ok: true, value: { stream: id, size: found.value.size, stamp: found.value.stamp } };
      }),
      /** Idempotent: a read at an offset, never past its length. */
      ReadChunk: (request, context) => {
        const found = owned(sessionOf(context).streams.get(request.stream));
        if (found === undefined) return nowhere(context, "ReadChunk");
        return serve("ReadChunk", found.ref, context, async (_host, session) => {
          touch(session, request.stream, found.held, "stream");
          if (request.offset >= found.held.size) return { ok: true, value: { data: "" } };
          const length = Math.min(request.length, FILE_BYTES_CHUNK_MAX, found.held.size - request.offset);
          const buffer = Buffer.alloc(length);
          const { bytesRead } = await found.held.handle.read(buffer, 0, length, request.offset);
          return { ok: true, value: { data: encodeChunk(buffer.subarray(0, bytesRead)) } };
        });
      },
      /** Idempotent: closing a stream the session no longer holds changes nothing. */
      ReadClose: (request, context) => Effect.sync(() => { closeStream(sessionOf(context), request.stream); return null; }),
      /** NOT idempotent: it makes a stage, which End, idle or the link closing removes. */
      ImportOpen: (request, context) => serve("ImportOpen", request, context, async (_host, session) => {
        if (session.uploads.size >= limits.uploads) return { ok: false, error: "denied" };
        if (request.size > FILE_BYTES_UPLOAD_MAX || stagedBytes + request.size > limits.stagedTotal) return { ok: false, error: "denied" };
        let parent: string;
        try { parent = stageParent(); } catch { return { ok: false, error: "failed" }; }
        const free = stageFreeBytes(parent);
        if (free === undefined || free - request.size < limits.freeFloor) return { ok: false, error: "denied" };
        const directory = await mkdtemp(join(parent, "up-"));
        const file = join(directory, request.name);
        let handle: FileHandle;
        try {
          handle = await open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        } catch {
          await rm(directory, { recursive: true, force: true }).catch(() => undefined);
          return { ok: false, error: "failed" };
        }
        const id = newId();
        const upload: Upload = {
          canvas: request.canvas, node: request.node, timer: undefined, directory, file, handle, size: request.size,
          into: request.into, written: 0, hash: createHash("sha256"),
        };
        stagedBytes += request.size;
        session.uploads.set(id, upload);
        touch(session, id, upload, "upload");
        return { ok: true, value: { upload: id } };
      }),
      /** NOT idempotent: a repeat names an offset already written, and is refused, and the upload with it. */
      ImportChunk: (request, context) => {
        const session = sessionOf(context);
        const found = owned(session.uploads.get(request.upload));
        if (found === undefined) return nowhere(context, "ImportChunk");
        return serve("ImportChunk", found.ref, context, async () => {
          const upload = found.held;
          const bytes = decodeChunk(request.data);
          if (bytes === undefined || request.offset !== upload.written || upload.written + bytes.byteLength > upload.size) {
            await dropUpload(session, request.upload);
            return { ok: false, error: "denied" };
          }
          touch(session, request.upload, upload, "upload");
          await upload.handle.write(bytes, 0, bytes.byteLength, request.offset);
          upload.written += bytes.byteLength;
          // Hashed as it is written: the end only compares.
          upload.hash.update(bytes);
          return { ok: true, value: null };
        });
      },
      /** NOT idempotent: it imports, once; the stage goes either way. A repeat names an upload that is gone. */
      ImportEnd: (request, context) => {
        const session = sessionOf(context);
        const found = owned(session.uploads.get(request.upload));
        if (found === undefined) return nowhere(context, "ImportEnd");
        return serve("ImportEnd", found.ref, context, async (host): Promise<FilesResult<ReadonlyArray<FileImported>>> => {
          const upload = found.held;
          clearTimeout(upload.timer);
          const whole = upload.written === upload.size && upload.hash.digest("hex") === request.sha256;
          try {
            if (!whole) return { ok: false, error: "failed" };
            await upload.handle.close();
            return await host.import(found.ref, upload.into, [upload.file]);
          } finally {
            await dropUpload(session, request.upload);
          }
        }).pipe(Effect.uninterruptible);
      },
    },
    overWindow: (context, _tag, payload) => {
      const session = sessionOf(context);
      const named = payload as { readonly stream?: unknown; readonly upload?: unknown };
      if (typeof named.stream === "string") closeStream(session, named.stream);
      if (typeof named.upload === "string") void dropUpload(session, named.upload);
      return refusedWith("denied");
    },
    closed: (context) => Effect.promise(async () => {
      const session = sessions.get(context.sessionId);
      if (session === undefined) return;
      sessions.delete(context.sessionId);
      for (const id of [...session.streams.keys()]) closeStream(session, id);
      await Promise.all([...session.uploads.keys()].map((id) => dropUpload(session, id)));
    }),
  });
  return channel;
});

export type { FileStamp };
