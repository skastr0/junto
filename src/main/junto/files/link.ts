import { Effect, Schema } from "effect";
import type { FilesChanged, FilesError, FilesNodeRef, FilesResult } from "@shared/files";
import {
  decodeFilesEvent, decodeFilesRequest, decodeFilesResponse, fitsOneFrame,
  type FilesEvent, type FilesRequest, type FilesResponse, type HostFilesError,
} from "@shared/files-link";
import type { LinkChannelContext, LinkChannelHandler, LinkEventContext } from "../link/types";
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
 * every request. An admission refusal is an answer (`denied`), with the link
 * up, never a link failure and never `unreachable`. When the authority list
 * lands (06 F4) it replaces `admitFilesPeer` and nothing else here.
 *
 * What never crosses into a row, a log or a failure: names, listings, text.
 * A log line holds the op, the node id and the outcome.
 */

/** The service calls a peer's op reaches. */
export type FilesHost = Pick<
  FilesService,
  "open" | "close" | "closeSubscriber" | "count" | "list" | "read" | "write" | "create" | "rename" | "move" | "trash" | "search"
>;

export class FilesLinkClosed extends Schema.TaggedError<FilesLinkClosed>()("FilesLinkClosed", { message: Schema.String }) {}

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

const refusedWith = (error: FilesError): FilesResponse => ({ _tag: "Refused", error: hostError(error) });
const asRefused = (result: { readonly ok: false; readonly error: FilesError }): FilesResponse => refusedWith(result.error);

/** A response no frame can hold is refused `too-large`: the link must never be closed by an answer. */
const bounded = (response: FilesResponse): FilesResponse =>
  fitsOneFrame(response) ? response : { _tag: "Refused", error: "too-large" };

const answered = <A>(result: FilesResult<A>, then: (value: A) => FilesResponse): FilesResponse =>
  result.ok ? bounded(then(result.value)) : asRefused(result);

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
  const subscribers = options.peerSubscribers ?? sharedPeerSubscribers;
  /** One subscriber per link session, made at its first open. */
  const sessions = new Map<string, number>();

  const subscriberFor = (context: LinkChannelContext): number => {
    const held = sessions.get(context.sessionId);
    if (held !== undefined) return held;
    const id = subscribers.allocate((change) => {
      void Effect.runPromiseWith(services)(context.sendEvent("files", eventOf(change))).catch(() => undefined);
    });
    sessions.set(context.sessionId, id);
    return id;
  };

  const answer = async (host: FilesHost, context: LinkChannelContext, request: FilesRequest): Promise<FilesResponse> => {
    const ref: FilesNodeRef = { canvas: request.canvas, node: request.node };
    switch (request._tag) {
      case "Open": {
        if (context.signal.aborted) return refusedWith("failed");
        return answered(await host.open(subscriberFor(context), ref), (root) => ({ _tag: "Opened", root }));
      }
      case "Close": return answered(host.close(sessions.get(context.sessionId) ?? -1, ref), () => ({ _tag: "Closed" }));
      case "Count": return answered(await host.count(ref), ({ files, capped }) => ({ _tag: "Counted", files, capped }));
      case "List": return answered(await host.list(ref, request.dir), (entries) => ({ _tag: "Listed", entries }));
      case "Read": return answered(await host.read(ref, request.path), (read) => ({
        _tag: "Read",
        // Text that does not fit one frame reads too-large until X3 sends it in chunks.
        read: read.kind === "text" && !fitsOneFrame(read.text)
          ? { kind: "too-large", size: Buffer.byteLength(read.text), stamp: read.stamp }
          : read,
      }));
      case "Write":
        if (!fitsOneFrame(request.text)) return refusedWith("too-large");
        return answered(await host.write(ref, request.path, request.text, request.base), (stamp) => ({ _tag: "Written", stamp }));
      case "Create": return answered(await host.create(ref, request.path, request.dir), (entry) => ({ _tag: "Created", entry }));
      case "Rename": return answered(await host.rename(ref, request.path, request.name), (path) => ({ _tag: "Renamed", path }));
      case "Move": return answered(await host.move(ref, request.path, request.into), (path) => ({ _tag: "Moved", path }));
      case "Trash": return answered(await host.trash(ref, request.path), () => ({ _tag: "Trashed" }));
      // A dropped file's source is a path on the window machine; its bytes come with X3.
      case "Import": return refusedWith("denied");
      case "Search": return answered(await host.search(sessions.get(context.sessionId) ?? -1, ref, request.query, request.seq), (search) => ({ _tag: "Searched", search }));
    }
  };

  const handleRequest: NonNullable<LinkChannelHandler["handleRequest"]> = (context, raw) => Effect.gen(function* () {
    // Decode here too: direct callers cannot bypass the transport decoder.
    const request = decodeFilesRequest(raw);
    if (options.enabled === false) {
      yield* Effect.logInfo("files refused", { op: request._tag, node: request.node, outcome: "denied" });
      return refusedWith("denied");
    }
    const admitted = yield* admitFilesPeer(context, request.canvas).pipe(Effect.provideContext(services));
    if (admitted !== "ok") return yield* Effect.logInfo("files refused", { op: request._tag, node: request.node, outcome: admitted }).pipe(Effect.as(refusedWith(admitted)));
    const host = options.service();
    const response = host === undefined
      ? refusedWith("failed")
      : yield* Effect.promise(() => answer(host, context, request)).pipe(
        // The cause stays in main's log, never on the wire.
        Effect.catchDefect(() => Effect.succeed(refusedWith("failed"))),
      );
    yield* Effect.logInfo("files op", { op: request._tag, node: request.node, outcome: response._tag === "Refused" ? response.error : "ok" });
    return response;
  }).pipe(Effect.annotateLogs({ area: "files-link", peer: context.peer.machineName }));

  const handler: LinkChannelHandler = {
    decodeRequest: decodeFilesRequest,
    decodeResponse: decodeFilesResponse,
    decodeEvent: decodeFilesEvent,
    handleRequest,
    handleEvent: (context, raw) => options.enabled === false || options.onEvent === undefined ? Effect.void : options.onEvent(context, decodeFilesEvent(raw)),
    ...(options.onOpened === undefined ? {} : { opened: options.onOpened }),
    closed: (context) => Effect.sync(() => {
      const id = sessions.get(context.sessionId);
      if (id === undefined) return;
      sessions.delete(context.sessionId);
      options.service()?.closeSubscriber(id);
      subscribers.release(id);
    }).pipe(Effect.andThen(options.onClosed?.(context) ?? Effect.void)),
  };
  return handler;
});
