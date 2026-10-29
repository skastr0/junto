/**
 * The companion request core: one decoded phone request in, one response
 * frame out. It owns everything that is protocol rather than data: the
 * pairing gate (a device in pairing may only `pair.complete`, a paired one may
 * never), the write rate limit, and the shape of each result. The data comes
 * from a `CompanionBackend`: the running app in main, or the built-in demo.
 */

import type { AgentSignal } from "./agent-signals";
import type { ContentStageArgs, ContentStageResult } from "./content-stage";
import type { ContentRef } from "./wire/content-ref";
import {
  COMPANION_ATTACHMENTS_MAX,
  COMPANION_CONTENT_IN_FLIGHT_MAX,
  COMPANION_STAGE_CHUNK_MAX,
  COMPANION_ERROR_COPY,
  COMPANION_MACHINE_IN_FLIGHT_MAX,
  COMPANION_MAIL_DEFAULT_LIMIT,
  COMPANION_WRITE_LIMIT,
  COMPANION_WRITE_OPS,
  COMPANION_WRITE_WINDOW_MS,
  companionError,
  companionFail,
  companionOk,
  type CompanionCanvas,
  type CompanionCanvasNode,
  type CompanionCanvasWire,
  type CompanionError,
  type CompanionMachine,
  type CompanionMachineLogLevel,
  type CompanionMail,
  type CompanionArgsByOp,
  type CompanionRequestFrame,
  type CompanionResultByOp,
  type CompanionResponseFrame,
  type CompanionSeat,
  type CompanionSeatDetail,
} from "./companion-protocol";
import type { OperatorFeed } from "./operator-feed";

export type CompanionOutcome<A> =
  | { readonly ok: true; readonly value: A }
  | { readonly ok: false; readonly error: CompanionError };

/** A canvas's nodes and drawn wires; the connection numbers what it sends. */
export type CompanionCanvasDrawn = {
  readonly nodes: ReadonlyArray<CompanionCanvasNode>;
  readonly wires: ReadonlyArray<CompanionCanvasWire>;
};

export const outcomeOk = <A>(value: A): CompanionOutcome<A> => ({ ok: true, value });
export const outcomeFail = <A = never>(
  code: CompanionError["code"],
  message?: string,
  signal?: AgentSignal,
): CompanionOutcome<A> => ({ ok: false, error: companionError(code, message ?? COMPANION_ERROR_COPY[code], signal) });

/** Where a phone's mail goes in a seat's threads (`mail.send`'s optional args). */
export type CompanionMailThread = {
  readonly threadId?: string;
  readonly inReplyTo?: string;
  /** Files this phone staged (`content.stage`), by the ref it was answered. */
  readonly attachments?: ReadonlyArray<ContentRef>;
};

export type CompanionBackend = {
  readonly now: () => number;
  readonly pairComplete: (input: {
    readonly deviceId: string;
    readonly publicKey: string;
    readonly deviceName: string;
  }) => Promise<CompanionOutcome<{ readonly deviceId: string }>>;
  readonly canvases: () => Promise<CompanionOutcome<ReadonlyArray<CompanionCanvas>>>;
  /** One feed per canvas; every canvas when the name is omitted. */
  readonly feeds: (canvasName?: string) => Promise<CompanionOutcome<ReadonlyArray<OperatorFeed>>>;
  readonly seats: (canvasName: string) => Promise<CompanionOutcome<ReadonlyArray<CompanionSeat>>>;
  readonly seatDetail: (canvasName: string, nodeId: string) => Promise<CompanionOutcome<CompanionSeatDetail>>;
  /** Not-open signals fail `conflict` with the signal as it stands. */
  /** Quiet: recorded on the signal with no mail, so the seat is not woken; empty text acknowledges. */
  readonly answerSignal: (
    signalId: string,
    text: string,
    quiet: boolean,
    attachments: ReadonlyArray<ContentRef>,
  ) => Promise<CompanionOutcome<AgentSignal>>;
  readonly dismissSignal: (signalId: string) => Promise<CompanionOutcome<AgentSignal>>;
  readonly mailList: (
    canvasName: string,
    nodeId: string,
    limit: number,
  ) => Promise<CompanionOutcome<ReadonlyArray<CompanionMail>>>;
  /** To this seat alone; `thread` places it in a thread. A mention is the link in the text. */
  readonly mailSend: (
    canvasName: string,
    nodeId: string,
    text: string,
    thread?: CompanionMailThread,
  ) => Promise<CompanionOutcome<CompanionMail>>;
  /** A page of a seat's threads, the operator's own first, fitted to one frame. */
  readonly threads: (
    canvasName: string,
    nodeId: string,
    page?: { readonly limit?: number; readonly after?: string },
  ) => Promise<CompanionOutcome<CompanionResultByOp["threads.list"]>>;
  /** A page of one of a seat's threads, fitted to one frame; not-found when the seat is not in it. */
  readonly thread: (
    canvasName: string,
    nodeId: string,
    threadId: string,
    page?: { readonly limit?: number; readonly before?: string },
  ) => Promise<CompanionOutcome<CompanionResultByOp["thread.get"]>>;
  /** A subject's comments, newest thread first, fitted to one frame. */
  readonly comments: (
    args: CompanionArgsByOp["comments.list"],
  ) => Promise<CompanionOutcome<CompanionResultByOp["comments.list"]>>;
  /** One comment, through the desktop's own post path; a replayed opId answers as the first did. */
  readonly comment: (
    args: CompanionArgsByOp["comment.post"],
  ) => Promise<CompanionOutcome<CompanionResultByOp["comment.post"]>>;
  /** What the phone may mention from a node, on the desktop's own scope and query rule. */
  readonly mentionCandidates: (
    args: CompanionArgsByOp["mentions.candidates"],
  ) => Promise<CompanionOutcome<CompanionResultByOp["mentions.candidates"]>>;
  /** The canvas's Artifacts nodes with their counts and label colours, and this Mac's Inbox when it is still one of them. */
  readonly artifactNodes: (canvasName: string) => Promise<CompanionOutcome<CompanionResultByOp["artifacts.nodes"]>>;
  /** An artifact's versions newest first, a page at a time, with every move it has made. */
  readonly artifactHistory: (
    args: CompanionArgsByOp["artifact.history"],
  ) => Promise<CompanionOutcome<CompanionResultByOp["artifact.history"]>>;
  /** This Mac's unruled writes to an Artifacts node, with the ones that would be refused now. */
  readonly artifactPending: (
    args: CompanionArgsByOp["artifact.pending"],
  ) => Promise<CompanionOutcome<CompanionResultByOp["artifact.pending"]>>;
  /** The line the desktop shows before a move that changes which seats reach the artifacts. */
  readonly artifactMoveCheck: (
    args: CompanionArgsByOp["artifact.moveCheck"],
  ) => Promise<CompanionOutcome<CompanionResultByOp["artifact.moveCheck"]>>;
  /** One artifact: its head, its body by ref, and the body itself when the whole result fits a frame. */
  readonly artifactGet: (
    args: CompanionArgsByOp["artifact.get"],
  ) => Promise<CompanionOutcome<CompanionResultByOp["artifact.get"]>>;
  /** A page of the canvas's artifacts, or of one node's, filtered, or searched by the quick-capture rule. */
  readonly artifactList: (
    args: CompanionArgsByOp["artifacts.list"],
  ) => Promise<CompanionOutcome<CompanionResultByOp["artifacts.list"]>>;
  /** Name the Inbox, through the path the desktop's Settings and Cmd+T use; `invalid` for a node that is not an Artifacts node of the canvas. */
  readonly inboxSet: (canvasName: string, nodeId: string) => Promise<CompanionOutcome<CompanionResultByOp["inbox.set"]>>;
  readonly quickReplies: () => Promise<CompanionOutcome<CompanionResultByOp["quickReplies.get"]>>;
  readonly portrait: (
    portraitIdentity: string,
    size: number,
    theme: "bright" | "dark",
    format: "svg" | "png",
  ) => Promise<CompanionOutcome<CompanionResultByOp["portrait.get"]>>;
  /** A canvas as the desktop draws it, through the whitelist; not-found when there is no such canvas. */
  readonly canvasScene: (canvasName: string) => Promise<CompanionOutcome<CompanionCanvasDrawn>>;
  /**
   * The bytes [offset, offset + length) of a stored object a current feed
   * names, read through the store's confined open. `unavailable` when its
   * bytes are absent, damaged, or a size other than the ref's.
   */
  readonly contentRange: (ref: ContentRef, offset: number, length: number) => Promise<CompanionOutcome<Uint8Array>>;
  /**
   * The ref a readable mail holds for this digest: a message owns it in the
   * store and carries it in its attachments, on a thread `thread.get` serves.
   * Its byteLength is the store's, never the request's.
   */
  readonly mailContentRef: (sha256: string) => Promise<ContentRef | undefined>;
  /**
   * The ref an artifact on any canvas holds for this digest: a version's body,
   * a file or link's content, a pad's image. Its byteLength is the store's,
   * never the request's.
   */
  readonly artifactContentRef: (sha256: string) => Promise<ContentRef | undefined>;
  /** Every machine this Mac knows, as its owner lists them. */
  readonly machines: () => Promise<CompanionOutcome<ReadonlyArray<CompanionMachine>>>;
  /** One machine read now, across its link if it has one. An unreachable machine is an answer. */
  readonly machine: (
    name: string,
    minLevel: CompanionMachineLogLevel | undefined,
  ) => Promise<CompanionOutcome<CompanionResultByOp["machine.get"]>>;
  readonly tailnetPeers: () => Promise<CompanionOutcome<CompanionResultByOp["tailnet.peers"]>>;
  /** One piece into the Mac content store, staged as the operator on `canvasName`, as the desktop stages. */
  readonly stagePiece: (canvasName: string, args: ContentStageArgs) => Promise<CompanionOutcome<ContentStageResult>>;
  /** Room on disk for a file this size, asked before its first piece. */
  readonly admitStage: (canvasName: string, byteLength: number) => Promise<CompanionOutcome<void>>;
  /** Let go of an upload: an open one's staging file, a finished one's stage hold. Never fails. */
  readonly dropStaged: (canvasName: string, stageId: string) => Promise<void>;
};

/**
 * Every stored object a set of Needs you feeds lets a phone read, by digest:
 * a file attachment's ref, and a compare's two texts. Commit and link
 * attachments carry no bytes.
 */
export const feedContentRefs = (feeds: ReadonlyArray<OperatorFeed>): ReadonlyMap<string, ContentRef> => {
  const refs = new Map<string, ContentRef>();
  for (const feed of feeds)
    for (const section of feed.sections)
      for (const item of section.items)
        for (const attachment of item.attachments ?? []) {
          if (!("kind" in attachment)) refs.set(attachment.ref.sha256, attachment.ref);
          else if (attachment.kind === "compare") {
            refs.set(attachment.before.sha256, attachment.before);
            refs.set(attachment.after.sha256, attachment.after);
          }
        }
  return refs;
};

/** One copy for an unknown digest and one outside every feed, so the store cannot be probed. */
const CONTENT_NOT_IN_FEED = "That file is no longer in your feed or your mail.";

/**
 * At most `max` requests of one kind unanswered at once, per phone. Take a
 * slot before reading; the returned release gives it back. Undefined: none free.
 */
export const makeInFlightGate = (max: number): (() => (() => void) | undefined) => {
  let open = 0;
  return () => {
    if (open >= max) return undefined;
    open += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      open -= 1;
    };
  };
};

const contentGet = async (
  id: string,
  backend: CompanionBackend,
  args: { readonly sha256: string; readonly offset: number; readonly length: number },
): Promise<CompanionResponseFrame> => {
  // Membership first, on the feeds and the mail as they stand now: outside them the bytes are never read.
  const feeds = await backend.feeds();
  if (!feeds.ok) return companionFail(id, feeds.error);
  const ref = feedContentRefs(feeds.value).get(args.sha256) ?? (await backend.mailContentRef(args.sha256)) ?? (await backend.artifactContentRef(args.sha256));
  if (ref === undefined) return companionFail(id, companionError("not-found", CONTENT_NOT_IN_FEED));
  const empty = ref.byteLength === 0 && args.offset === 0;
  if (args.offset >= ref.byteLength && !empty)
    return companionFail(id, companionError("invalid", "That part of the file is past its end."));
  const length = Math.min(args.length, ref.byteLength - args.offset);
  const bytes = empty ? outcomeOk(new Uint8Array(0)) : await backend.contentRange(ref, args.offset, length);
  if (!bytes.ok) return companionFail(id, bytes.error);
  if (bytes.value.byteLength !== length) return companionFail(id, companionError("unavailable", COMPANION_ERROR_COPY.unavailable));
  return companionOk(id, "content.get", {
    sha256: ref.sha256,
    offset: args.offset,
    length,
    byteLength: ref.byteLength,
    data: Buffer.from(bytes.value.buffer, bytes.value.byteOffset, bytes.value.byteLength).toString("base64"),
  });
};

export type CompanionGates = {
  readonly content: () => (() => void) | undefined;
  readonly machine: () => (() => void) | undefined;
  /** Portraits drawn as PNG run one after another, since drawing holds the Mac's main thread. */
  readonly portraitPng: <A>(draw: () => Promise<A>) => Promise<A>;
  readonly stage: () => (() => void) | undefined;
  /** This phone's uploads, so unpairing lets them go. */
  readonly uploads: CompanionUploads;
};

/** Tasks run one at a time, in the order they came; a failure does not stop the next. */
export const makeSerial = (): (<A>(task: () => Promise<A>) => Promise<A>) => {
  let tail: Promise<unknown> = Promise.resolve();
  return <A>(task: () => Promise<A>): Promise<A> => {
    const run = tail.then(task, task);
    tail = run.catch(() => undefined);
    return run;
  };
};

/** One phone's in-flight bounds. */
export const makeCompanionGates = (): CompanionGates => ({
  content: makeInFlightGate(COMPANION_CONTENT_IN_FLIGHT_MAX),
  machine: makeInFlightGate(COMPANION_MACHINE_IN_FLIGHT_MAX),
  portraitPng: makeSerial(),
  stage: makeInFlightGate(COMPANION_STAGE_IN_FLIGHT_MAX),
  uploads: { open: new Map(), finished: [] },
});

/** `content.stage` calls one phone may have unanswered at once. */
export const COMPANION_STAGE_IN_FLIGHT_MAX = 2;
/** Uploads one phone may have open at once: a mail's worth. */
export const COMPANION_STAGE_OPEN_MAX = COMPANION_ATTACHMENTS_MAX;
/** How long a finished upload is remembered, so unpairing can let it go; the stager lets it go after this anyway. */
const FINISHED_KEPT_MS = 60 * 60 * 1000;

/** One upload this phone has open: keyed by canvas, sha256 and byteLength, never by sha alone. */
type OpenUpload = { readonly canvasName: string; stageId?: string; received: number; busy: boolean };

/** What one phone has staged: the uploads it has open, and the finished ones it may not have used yet. */
export type CompanionUploads = {
  readonly open: Map<string, OpenUpload>;
  finished: Array<{ readonly canvasName: string; readonly stageId: string; readonly at: number }>;
};

/** Unpairing: every upload the phone has open is dropped, and every finished one it did not use is let go. */
export const releaseCompanionUploads = async (backend: CompanionBackend, uploads: CompanionUploads): Promise<void> => {
  const all = [
    ...[...uploads.open.values()].flatMap((upload) =>
      upload.stageId === undefined ? [] : [{ canvasName: upload.canvasName, stageId: upload.stageId }],
    ),
    ...uploads.finished,
  ];
  uploads.open.clear();
  uploads.finished = [];
  await Promise.all(all.map(({ canvasName, stageId }) => backend.dropStaged(canvasName, stageId).catch(() => undefined)));
};

const OUT_OF_ORDER = "That piece is out of order. Send the file again from the start.";

/** Raw bytes a standard padded base64 string decodes to, or undefined when it is not one. */
const base64Bytes = (data: string): number | undefined => {
  if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(data)) return undefined;
  return (data.length / 4) * 3 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0);
};

/**
 * One `content.stage` piece. Offset 0 starts the upload (dropping one already
 * open for the same file) after asking the disk for the whole declared size;
 * every later piece starts where the last ended, and none runs past the
 * declared size. The last byte closes it: the Mac hashes the file and refuses
 * one that is not what the phone named.
 */
const contentStage = async (
  id: string,
  backend: CompanionBackend,
  uploads: CompanionUploads,
  args: CompanionArgsByOp["content.stage"],
): Promise<CompanionResponseFrame> => {
  const { canvasName, sha256, byteLength, offset } = args;
  const length = base64Bytes(args.data);
  if (length === undefined || length < 1 || length > COMPANION_STAGE_CHUNK_MAX) {
    return companionFail(id, companionError("invalid", "That piece is not standard base64 of 1 to 196608 bytes."));
  }
  if (offset + length > byteLength) {
    return companionFail(id, companionError("invalid", "That piece runs past the end of the file."));
  }
  const key = `${canvasName}\n${sha256}\n${String(byteLength)}`;
  let upload = uploads.open.get(key);
  if (offset === 0) {
    if (upload?.busy) return companionFail(id, companionError("invalid", "A piece of this file is still landing. Send pieces one at a time."));
    if (upload !== undefined) {
      uploads.open.delete(key);
      if (upload.stageId !== undefined) await backend.dropStaged(canvasName, upload.stageId);
    }
    if (uploads.open.size >= COMPANION_STAGE_OPEN_MAX) {
      return companionFail(id, companionError("rate-limited", `At most ${String(COMPANION_STAGE_OPEN_MAX)} files upload at once. Finish one first.`));
    }
    const room = await backend.admitStage(canvasName, byteLength);
    if (!room.ok) return companionFail(id, room.error);
    upload = { canvasName, received: 0, busy: false };
    uploads.open.set(key, upload);
  } else if (upload === undefined || upload.received !== offset || upload.busy) {
    return companionFail(id, companionError("invalid", OUT_OF_ORDER));
  }
  const current = upload;
  const forget = async (): Promise<void> => {
    if (uploads.open.get(key) === current) uploads.open.delete(key);
    if (current.stageId !== undefined) await backend.dropStaged(canvasName, current.stageId);
  };
  current.busy = true;
  try {
    const piece = await backend.stagePiece(canvasName, {
      ...(current.stageId === undefined ? {} : { stageId: current.stageId }),
      bytesBase64: args.data,
    } as ContentStageArgs);
    if (!piece.ok || "ref" in piece.value) {
      await forget();
      return companionFail(id, piece.ok ? companionError("internal", COMPANION_ERROR_COPY.internal) : piece.error);
    }
    current.stageId = piece.value.stageId;
    current.received = piece.value.byteLength;
    if (current.received < byteLength) return companionOk(id, "content.stage", { received: current.received });
    // The whole file landed: close it, naming what it must hash to.
    uploads.open.delete(key);
    const closed = await backend.stagePiece(canvasName, {
      stageId: current.stageId,
      done: {
        mediaType: args.mediaType,
        ...(args.displayName === undefined ? {} : { displayName: args.displayName }),
        expected: { sha256, byteLength },
      },
    } as ContentStageArgs);
    if (!closed.ok || !("ref" in closed.value)) {
      return companionFail(id, closed.ok ? companionError("internal", COMPANION_ERROR_COPY.internal) : closed.error);
    }
    const at = backend.now();
    uploads.finished = [
      ...uploads.finished.filter((held) => at - held.at < FINISHED_KEPT_MS),
      { canvasName, stageId: current.stageId, at },
    ];
    return companionOk(id, "content.stage", { ref: closed.value.ref });
  } catch {
    await forget().catch(() => undefined);
    return companionFail(id, companionError("internal", COMPANION_ERROR_COPY.internal));
  } finally {
    current.busy = false;
  }
};

export type CompanionDeviceView = {
  readonly deviceId: string;
  readonly state: "pairing" | "paired";
};

/**
 * Sliding-window write limiter, one per device. It keeps wall-clock time of
 * its own: a backend's clock (the demo's advances per write) is not a rate.
 */
export const makeWriteLimiter = (
  limit = COMPANION_WRITE_LIMIT,
  windowMs = COMPANION_WRITE_WINDOW_MS,
  clock: () => number = Date.now,
): (() => boolean) => {
  const stamps: number[] = [];
  return () => {
    const now = clock();
    while (stamps.length > 0 && now - stamps[0]! >= windowMs) stamps.shift();
    if (stamps.length >= limit) return false;
    stamps.push(now);
    return true;
  };
};

/** A thread op's page arguments, only those the phone sent. */
const pageOf = (args: { readonly limit?: number; readonly after?: string; readonly before?: string }) => ({
  ...(args.limit === undefined ? {} : { limit: args.limit }),
  ...(args.after === undefined ? {} : { after: args.after }),
  ...(args.before === undefined ? {} : { before: args.before }),
});

const respond = async <A>(
  id: string,
  outcome: Promise<CompanionOutcome<A>>,
  ok: (value: A) => CompanionResponseFrame,
): Promise<CompanionResponseFrame> => {
  try {
    const result = await outcome;
    return result.ok ? ok(result.value) : companionFail(id, result.error);
  } catch {
    return companionFail(id, companionError("internal", COMPANION_ERROR_COPY.internal));
  }
};

export const handleCompanionRequest = async (
  frame: CompanionRequestFrame,
  context: {
    readonly backend: CompanionBackend;
    readonly device: CompanionDeviceView;
    readonly allowWrite: () => boolean;
    /** This phone's `content.get` and `machine.get` slots ({@link makeCompanionGates}). */
    readonly gates: CompanionGates;
  },
): Promise<CompanionResponseFrame> => {
  const { backend, device } = context;
  const id = frame.id;

  if (device.state === "pairing" && frame.op !== "pair.complete") {
    return companionFail(id, companionError("invalid", "Finish pairing first."));
  }
  if (device.state === "paired" && frame.op === "pair.complete") {
    return companionFail(id, companionError("invalid", "This phone is already paired."));
  }
  if (COMPANION_WRITE_OPS.has(frame.op) && !context.allowWrite()) {
    return companionFail(id, companionError("rate-limited", COMPANION_ERROR_COPY["rate-limited"]));
  }

  switch (frame.op) {
    case "pair.complete":
      return respond(id, backend.pairComplete({ deviceId: device.deviceId, ...frame.args }), (value) =>
        companionOk(id, "pair.complete", value),
      );
    case "ping":
      return companionOk(id, "ping", { serverTime: backend.now() });
    case "canvases.list":
      return respond(id, backend.canvases(), (canvases) => companionOk(id, "canvases.list", { canvases }));
    case "feed.get":
    case "feed.subscribe": {
      const op = frame.op;
      return respond(id, backend.feeds(frame.args.canvasName), (feeds) => companionOk(id, op, { feeds }));
    }
    case "feed.unsubscribe":
      return companionOk(id, "feed.unsubscribe", {});
    case "seats.list":
      return respond(id, backend.seats(frame.args.canvasName), (seats) => companionOk(id, "seats.list", { seats }));
    case "seat.get":
      return respond(id, backend.seatDetail(frame.args.canvasName, frame.args.nodeId), (seat) =>
        companionOk(id, "seat.get", { seat }),
      );
    case "signal.answer":
      return respond(
        id,
        backend.answerSignal(frame.args.signalId, frame.args.text, "quiet" in frame.args, frame.args.attachments ?? []),
        (signal) =>
        companionOk(id, "signal.answer", { signal }),
      );
    case "signal.dismiss":
      return respond(id, backend.dismissSignal(frame.args.signalId), (signal) =>
        companionOk(id, "signal.dismiss", { signal }),
      );
    case "mail.list":
      return respond(
        id,
        backend.mailList(frame.args.canvasName, frame.args.nodeId, frame.args.limit ?? COMPANION_MAIL_DEFAULT_LIMIT),
        (messages) => companionOk(id, "mail.list", { messages }),
      );
    case "mail.send": {
      // A phone's `mentions` list goes nowhere: a mention is the link in the text.
      const { canvasName, nodeId, text, mentions: _mentions, ...thread } = frame.args;
      return respond(id, backend.mailSend(canvasName, nodeId, text, thread), (message) =>
        companionOk(id, "mail.send", { message }),
      );
    }
    case "threads.list":
      return respond(id, backend.threads(frame.args.canvasName, frame.args.nodeId, pageOf(frame.args)), (value) =>
        companionOk(id, "threads.list", value),
      );
    case "thread.get":
      return respond(id, backend.thread(frame.args.canvasName, frame.args.nodeId, frame.args.threadId, pageOf(frame.args)), (value) =>
        companionOk(id, "thread.get", value),
      );
    case "comments.list":
      return respond(id, backend.comments(frame.args), (value) => companionOk(id, "comments.list", value));
    case "comment.post":
      return respond(id, backend.comment(frame.args), (value) => companionOk(id, "comment.post", value));
    case "mentions.candidates":
      return respond(id, backend.mentionCandidates(frame.args), (value) => companionOk(id, "mentions.candidates", value));
    case "artifacts.nodes":
      return respond(id, backend.artifactNodes(frame.args.canvasName), (value) => companionOk(id, "artifacts.nodes", value));
    case "artifact.history":
      return respond(id, backend.artifactHistory(frame.args), (value) => companionOk(id, "artifact.history", value));
    case "artifact.pending":
      return respond(id, backend.artifactPending(frame.args), (value) => companionOk(id, "artifact.pending", value));
    case "artifact.moveCheck":
      return respond(id, backend.artifactMoveCheck(frame.args), (value) => companionOk(id, "artifact.moveCheck", value));
    case "artifact.get":
      return respond(id, backend.artifactGet(frame.args), (value) => companionOk(id, "artifact.get", value));
    case "artifacts.list":
      return respond(id, backend.artifactList(frame.args), (value) => companionOk(id, "artifacts.list", value));
    case "inbox.set":
      return respond(id, backend.inboxSet(frame.args.canvasName, frame.args.nodeId), (value) => companionOk(id, "inbox.set", value));
    case "quickReplies.get":
      return respond(id, backend.quickReplies(), (value) => companionOk(id, "quickReplies.get", value));
    case "portrait.get": {
      const { portraitIdentity, size, theme } = frame.args;
      const format = frame.args.format ?? "svg";
      const read = () => backend.portrait(portraitIdentity, size, theme, format);
      return respond(id, format === "png" ? context.gates.portraitPng(read) : read(), (value) =>
        companionOk(id, "portrait.get", value),
      );
    }
    case "canvas.open":
      // The connection numbers the scene: its seq is the session's, not the canvas's.
      return respond(id, backend.canvasScene(frame.args.canvasName), (scene) =>
        companionOk(id, "canvas.open", { seq: 0, ...scene }),
      );
    case "canvas.close":
      return companionOk(id, "canvas.close", {});
    case "content.get": {
      const release = context.gates.content();
      if (release === undefined)
        return companionFail(id, companionError("rate-limited", "Too many files at once. Wait for one to arrive."));
      try {
        return await contentGet(id, backend, frame.args);
      } catch {
        return companionFail(id, companionError("internal", COMPANION_ERROR_COPY.internal));
      } finally {
        release();
      }
    }
    case "content.stage": {
      const release = context.gates.stage();
      if (release === undefined)
        return companionFail(id, companionError("rate-limited", "Send one piece at a time, and wait for it to land."));
      try {
        return await contentStage(id, backend, context.gates.uploads, frame.args);
      } finally {
        release();
      }
    }
    case "machines.list":
      return respond(id, backend.machines(), (machines) => companionOk(id, "machines.list", { machines }));
    case "machine.get": {
      const release = context.gates.machine();
      if (release === undefined)
        return companionFail(id, companionError("rate-limited", "Already reading two machines. Wait for one to answer."));
      try {
        return await respond(id, backend.machine(frame.args.name, frame.args.minLevel), (value) =>
          companionOk(id, "machine.get", value),
        );
      } finally {
        release();
      }
    }
    case "tailnet.peers":
      return respond(id, backend.tailnetPeers(), (value) => companionOk(id, "tailnet.peers", value));
  }
};
