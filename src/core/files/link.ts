import { Effect } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import type { FilesChanged, FilesError, FilesNodeRef, FilesResult } from "@shared/files";
import {
  FilesClose, FilesCount, FilesCounted, FilesCreate, FilesCreated, FilesDone, FilesEvent, FilesImport, FilesImported, FilesLinkClosed,
  FilesLinkFailure, FilesList, FilesListed, FilesMove, FilesOpen, FilesOpened, FilesPathAnswer, FilesRead, FilesReadAnswer, FilesRefused,
  FilesRename, FilesSearch, FilesSearched, FilesTrash, FilesWrite, FilesWritten, fitsOneFrame, type HostFilesError,
} from "@shared/files-link";
import { bindLinkChannel, linkClient, linkContract, type LinkContractChannel } from "../link/contract";
import type { LinkChannelContext, LinkEventContext } from "../link/types";
import { MachineRepository } from "../machines/repository";
import { ModelRecords } from "../model/records";
import { ModelService } from "../model/service";
import { peerSubscribers as sharedPeerSubscribers, type makePeerSubscribers } from "./peer-subscribers";
import type { FilesService } from "./service";

/**
 * The answering end of the link's `files` channel (0.12, plan
 * 12-files-over-ssh, X1c). A peer names a Files node and a relative path; the
 * host takes the root from its own copy of the node and runs the call through
 * the Files service it already has, so realpath scoping, the deny list and
 * stale-save stamps hold unchanged.
 *
 * Who may ask: the peer is still pinned and edits the named canvas, checked on
 * every request. An admission refusal is a `FilesRefused` (`denied`), the
 * ops' typed error, with the link up, never a link failure and never
 * `unreachable`. When the authority list lands (06 F4) it replaces
 * `admitFilesPeer` and nothing else here.
 *
 * What never crosses into a row, a log or a failure: names, listings, text.
 * A log line holds the op, the node id and the outcome.
 */

/** The service calls a peer's op reaches. */
export type FilesHost = Pick<
  FilesService,
  "open" | "close" | "closeSubscriber" | "count" | "list" | "read" | "write" | "create" | "rename" | "move" | "trash" | "search"
>;

/**
 * The channel's contract: one request per op, each answered with its own
 * shape or the host's refusal, and the host's change events.
 */
export const FilesLink = linkContract("files", RpcGroup.make(
  Rpc.make("Open", { payload: FilesOpen, success: FilesOpened, error: FilesLinkFailure }),
  Rpc.make("Close", { payload: FilesClose, success: FilesDone, error: FilesLinkFailure }),
  Rpc.make("Count", { payload: FilesCount, success: FilesCounted, error: FilesLinkFailure }),
  Rpc.make("List", { payload: FilesList, success: FilesListed, error: FilesLinkFailure }),
  Rpc.make("Read", { payload: FilesRead, success: FilesReadAnswer, error: FilesLinkFailure }),
  Rpc.make("Write", { payload: FilesWrite, success: FilesWritten, error: FilesLinkFailure }),
  Rpc.make("Create", { payload: FilesCreate, success: FilesCreated, error: FilesLinkFailure }),
  Rpc.make("Rename", { payload: FilesRename, success: FilesPathAnswer, error: FilesLinkFailure }),
  Rpc.make("Move", { payload: FilesMove, success: FilesPathAnswer, error: FilesLinkFailure }),
  Rpc.make("Trash", { payload: FilesTrash, success: FilesDone, error: FilesLinkFailure }),
  Rpc.make("Import", { payload: FilesImport, success: FilesImported, error: FilesLinkFailure }),
  Rpc.make("Search", { payload: FilesSearch, success: FilesSearched, error: FilesLinkFailure }),
), { event: FilesEvent });

/** `ok`, or the refusal the peer is answered with. */
export type FilesAdmission = "ok" | HostFilesError;

/**
 * The peer is pinned with the installation its hello carried, and it edits the
 * canvas, which this machine holds. Identity comes from the admitted hello.
 */
export const admitFilesPeer = Effect.fn("FilesLink.admit")(function* (context: LinkEventContext, canvas: string) {
  const model = yield* ModelService;
  const records = yield* ModelRecords;
  const machines = yield* MachineRepository;
  const open = () => context.signal.aborted
    ? Effect.fail(new FilesLinkClosed({ message: "This machine link has closed." }))
    : Effect.void;
  yield* open();
  const peer = yield* machines.peer(context.peer.machineName);
  if (peer?.installationId !== context.peer.installationId) return "denied" as const;
  if ((yield* records.canvasEditor(canvas)) !== context.peer.installationId) return "denied" as const;
  const held = yield* model.canvas(canvas).pipe(Effect.option);
  if (held._tag === "None") return "no-node" as const;
  yield* open();
  return "ok" as const;
});

const hostError = (error: FilesError): HostFilesError => (error === "unreachable" ? "failed" : error);

/** A change as the link carries it; one too large for a frame says the tree changed too much. */
export const eventOf = (change: FilesChanged): FilesEvent => {
  if (change.kind === "closed") return { node: change.node, kind: "closed", error: hostError(change.error) };
  if (change.kind !== "paths") return change;
  const event: FilesEvent = { node: change.node, kind: "paths", paths: change.paths, ...(change.moves === undefined ? {} : { moves: change.moves }) };
  return fitsOneFrame(event) ? event : { node: change.node, kind: "reset" };
};

const refusedWith = (error: FilesError): FilesRefused => new FilesRefused({ error: hostError(error) });

export type FilesLinkOptions = {
  /**
   * False while `filesRemote` is off on this machine: the channel is bound all
   * the same and refuses every op `denied`. An unbound channel would make a
   * peer that has the feature on close the whole link (an unknown channel is a
   * bad frame), and the seats on it with it. Default true.
   */
  readonly enabled?: boolean;
  /** The service; undefined while the app has not built it yet. */
  readonly service: () => FilesHost | undefined;
  /** The window machine's end: a change under a node it opened here. Unset, events are dropped. */
  readonly onEvent?: (context: LinkEventContext, event: FilesEvent) => Effect.Effect<void, unknown>;
  /** The window machine's end: the link to a machine came up, or went down. */
  readonly onOpened?: (context: LinkEventContext) => Effect.Effect<void, unknown>;
  readonly onClosed?: (context: LinkEventContext) => Effect.Effect<void, unknown>;
  readonly peerSubscribers?: ReturnType<typeof makePeerSubscribers>;
};

export const makeFilesLinkChannel = Effect.fn("FilesLink.make")(function* (options: FilesLinkOptions) {
  const services = yield* Effect.context<ModelService | ModelRecords | MachineRepository>();
  const files = yield* linkClient(FilesLink);
  const subscribers = options.peerSubscribers ?? sharedPeerSubscribers;
  /** One subscriber per link session, made at its first open. */
  const sessions = new Map<string, number>();

  const subscriberFor = (context: LinkChannelContext): number => {
    const held = sessions.get(context.sessionId);
    if (held !== undefined) return held;
    const id = subscribers.allocate((change) => {
      void Effect.runPromiseWith(services)(files.sendEvent(context.peer.machineName, eventOf(change))).catch(() => undefined);
    });
    sessions.set(context.sessionId, id);
    return id;
  };
  const subscriberOf = (context: LinkChannelContext): number => sessions.get(context.sessionId) ?? -1;

  /**
   * One op, in the order every op runs: the feature gate, the admission, the
   * service. A refusal and a result no frame can hold both end in a
   * `FilesRefused`: the link must never be closed by an answer.
   */
  const serve = <A>(
    op: string,
    payload: FilesNodeRef,
    context: LinkChannelContext,
    run: (host: FilesHost, ref: FilesNodeRef) => Promise<FilesResult<A>> | FilesResult<A>,
  ): Effect.Effect<A, FilesLinkFailure> => Effect.gen(function* () {
    const ref: FilesNodeRef = { canvas: payload.canvas, node: payload.node };
    const refuse = (error: FilesError) =>
      Effect.logInfo("files refused", { op, node: ref.node, outcome: error }).pipe(Effect.andThen(Effect.fail(refusedWith(error))));
    if (options.enabled === false) return yield* refuse("denied");
    const admitted = yield* admitFilesPeer(context, ref.canvas).pipe(
      Effect.provideContext(services),
      // Anything but the link having closed is this call failing: it crosses as a failure with no detail.
      Effect.catch((cause) => cause instanceof FilesLinkClosed ? Effect.fail(cause) : Effect.die(cause)),
    );
    if (admitted !== "ok") return yield* refuse(admitted);
    const host = options.service();
    if (host === undefined) return yield* refuse("failed");
    const result = yield* Effect.promise(async () => run(host, ref)).pipe(
      // The cause stays in main's log, never on the wire.
      Effect.catchDefect(() => Effect.succeed<FilesResult<A>>({ ok: false, error: "failed" })),
    );
    if (!result.ok) return yield* refuse(result.error);
    if (!fitsOneFrame(result.value)) return yield* refuse("too-large");
    yield* Effect.logInfo("files op", { op, node: ref.node, outcome: "ok" });
    return result.value;
  }).pipe(Effect.annotateLogs({ area: "files-link", peer: context.peer.machineName }));

  const channel: LinkContractChannel = bindLinkChannel(FilesLink, {
    // Interruption: Write, Create, Rename, Move and Trash change the disk and are not idempotent, so one the
    // caller gave up on may still have run. Open allocates the session's subscriber once and reuses it, and
    // the rest only read.
    requests: {
      /** Idempotent: a session has one subscriber, and a second open names the same one. */
      Open: (request, context) => context.signal.aborted
        ? Effect.fail(refusedWith("failed"))
        : serve("Open", request, context, (host, ref) => host.open(subscriberFor(context), ref)),
      /** Idempotent: closing a node the session no longer holds changes nothing. */
      Close: (request, context) => serve("Close", request, context, (host, ref) => {
        const result = host.close(subscriberOf(context), ref);
        return result.ok ? { ok: true, value: null } : result;
      }),
      /** Idempotent: reads. */
      Count: (request, context) => serve("Count", request, context, async (host, ref) => {
        const result = await host.count(ref);
        return result.ok ? { ok: true, value: { files: result.value.files, capped: result.value.capped } } : result;
      }),
      /** Idempotent: reads. */
      List: (request, context) => serve("List", request, context, (host, ref) => host.list(ref, request.dir)),
      /** Idempotent: reads. Text that does not fit one frame reads too-large until X3 sends it in chunks. */
      Read: (request, context) => serve("Read", request, context, async (host, ref) => {
        const result = await host.read(ref, request.path);
        if (!result.ok) return result;
        const read = result.value;
        return { ok: true, value: read.kind === "text" && !fitsOneFrame(read.text) ? { kind: "too-large", size: Buffer.byteLength(read.text), stamp: read.stamp } : read };
      }),
      /** NOT idempotent: a second write against the stamp the first one moved is refused `stale`. */
      Write: (request, context) => fitsOneFrame(request.text)
        ? serve("Write", request, context, (host, ref) => host.write(ref, request.path, request.text, request.base))
        : Effect.fail(refusedWith("too-large")),
      /** NOT idempotent: a second create is refused `exists`. */
      Create: (request, context) => serve("Create", request, context, (host, ref) => host.create(ref, request.path, request.dir)),
      /** NOT idempotent: the path it renamed from is gone the second time. */
      Rename: (request, context) => serve("Rename", request, context, (host, ref) => host.rename(ref, request.path, request.name)),
      /** NOT idempotent: the path it moved from is gone the second time. */
      Move: (request, context) => serve("Move", request, context, (host, ref) => host.move(ref, request.path, request.into)),
      /** NOT idempotent: the path it trashed is gone the second time. */
      Trash: (request, context) => serve("Trash", request, context, async (host, ref) => {
        const result = await host.trash(ref, request.path);
        return result.ok ? { ok: true, value: null } : result;
      }),
      /** Idempotent: a dropped file's source is a path on the window machine, so until X3 it is only ever refused. */
      Import: (request, context) => serve("Import", request, context, () => ({ ok: false, error: "denied" })),
      /** Idempotent: a newer `seq` supersedes an older one, and the same one searches again. */
      Search: (request, context) => serve("Search", request, context, (host, ref) => host.search(subscriberOf(context), ref, request.query, request.seq)),
    },
    event: (event, context) => options.enabled === false || options.onEvent === undefined ? Effect.void : options.onEvent(context, event),
    ...(options.onOpened === undefined ? {} : { opened: options.onOpened }),
    closed: (context) => Effect.sync(() => {
      const id = sessions.get(context.sessionId);
      if (id === undefined) return;
      sessions.delete(context.sessionId);
      options.service()?.closeSubscriber(id);
      subscribers.release(id);
    }).pipe(Effect.andThen(options.onClosed?.(context) ?? Effect.void)),
  });
  return channel;
});
