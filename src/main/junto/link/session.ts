import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { Effect, Schema } from "effect";
import { failureSentence, OperationId, type EncodedCause, type EncodedFailure } from "@shared/failure";
import { decodeEncodedFailure, describeCause, encodeError } from "../failure-encode";
import { decodeLinkFrame, LinkHelloSchema, type LinkFrame } from "./protocol";
import { linkLog, type LinkLogLevel } from "./log";
import {
  isMachineLinkError, LinkBuildMismatch, linkClosed, LinkFrameInvalid, LinkHelloRefused, LinkRequestFailed, LinkUnavailable,
  type FrameProblem, type LinkChannel, type LinkChannelContext, type LinkChannelHandler, type LinkChannels, type LinkClosed,
  type LinkClosedReason, type LinkHello, type LinkSession, type MachineLinkError,
} from "./types";

export { LinkBuildMismatch } from "./types";

const DEFAULT_LIMITS = { frameBytes: 1024 * 1024, queuedBytes: 4 * 1024 * 1024, pendingRequests: 32, inboundCalls: 32, helloTimeoutMs: 10_000, requestTimeoutMs: 30_000 } as const;
const CLOSE_FLUSH_MS = 1_000;
export interface LinkSessionOptions {
  readonly readable: Readable;
  readonly writable: Writable;
  readonly self: LinkHello;
  readonly admit: (hello: LinkHello) => Promise<void>;
  readonly channels: LinkChannels;
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  /** The machine a dialer expects, named in failures before its hello arrives. */
  readonly expected?: string;
  /** Tests may lower limits, never widen the production bounds. */
  readonly limits?: Partial<Record<keyof typeof DEFAULT_LIMITS, number>>;
}
interface Pending {
  readonly channel: LinkChannel;
  readonly operationId: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: MachineLinkError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}
const isOperationId = Schema.is(OperationId);
const frameInvalid = (problem: FrameProblem, message: string, machine?: string): LinkFrameInvalid =>
  new LinkFrameInvalid({ problem, message, ...(machine === undefined ? {} : { machine }) });
/** A channel decoder's failure, carried as its path and issue kind only. */
const decoded = <A>(problem: FrameProblem, what: string, decode: () => A): A => {
  try { return decode(); } catch (cause) { throw frameInvalid(problem, `${what}: ${describeCause(cause).message}`); }
};
const bound = (text: string): EncodedCause => ({ tag: "LinkBound", message: text });

const reasonFor = (first: MachineLinkError): LinkClosedReason => {
  switch (first._tag) {
    case "LinkHelloRefused": case "LinkBuildMismatch": case "LinkPeerNotPinned": return "refused";
    case "LinkFrameInvalid": return first.problem === "frame-bound" ? "bound-exceeded" : "frame-invalid";
    case "LinkUnavailable": return first.reason === "shutting-down" ? "shutting-down" : "failed";
    case "LinkClosed": return first.reason;
    case "LinkRequestFailed": return "failed";
  }
};

/** What the other end is told: the first cause, from the closing end's own view. */
const closeFailure = (stopped: LinkClosed, first: MachineLinkError, self: string): EncodedFailure => {
  if (first._tag !== "LinkClosed") return encodeError(first, { machine: self });
  const [head, ...rest] = stopped.causes;
  if (head === undefined) return encodeError({ _tag: "LinkClosed", message: stopped.message.replace(/^.*?, this machine closed it: ?/, "") || "closed on request" }, { machine: self });
  return encodeError({ _tag: head.tag, message: head.message, causes: rest }, { machine: self });
};

/** One session implementation over either an owner socket or an SSH duplex. */
export const makeLinkSession = (options: LinkSessionOptions): LinkSession => {
  const limits = { ...DEFAULT_LIMITS } as Record<keyof typeof DEFAULT_LIMITS, number>;
  for (const [key, value] of Object.entries(options.limits ?? {})) {
    if (!Object.hasOwn(limits, key) || value === undefined || !Number.isInteger(value) || value < 1 || value > limits[key as keyof typeof limits]) {
      throw new LinkUnavailable({ reason: "invalid-limits", message: `Link limit ${key} must be an integer from 1 through its production bound` });
    }
    limits[key as keyof typeof limits] = value;
  }
  const self = Object.freeze(Schema.decodeUnknownSync(LinkHelloSchema, { onExcessProperty: "error" })(options.self));
  const channels = { ...options.channels };
  const sessionId = randomUUID();
  const controller = new AbortController();
  const abortedEffect = Effect.callback<never>(resume => {
    const abort = (): void => resume(Effect.interrupt);
    if (controller.signal.aborted) { abort(); return; }
    controller.signal.addEventListener("abort", abort, { once: true });
    return Effect.sync(() => controller.signal.removeEventListener("abort", abort));
  });
  const runOwned = <A, E>(effect: Effect.Effect<A, E>): Promise<A> => options.run(Effect.raceFirst(effect, abortedEffect));
  // A socket is one duplex: destroying its read side ends the write side too.
  const duplex = (options.readable as unknown) === options.writable;
  const pending = new Map<string, Pending>();
  const inboundIds = new Set<string>();
  const completedIds = new Set<string>();
  const channelQueues = new Map<LinkChannel, Promise<void>>();
  let inboundCalls = 0;
  let peer: LinkHello | undefined;
  let helloSeen: LinkHello | undefined;
  let stopped: LinkClosed | undefined;
  let queuedBytes = 0;
  let writeTail = Promise.resolve();
  let resolveReady!: (peer: LinkHello) => void;
  let rejectReady!: (error: MachineLinkError) => void;
  let resolveClosed!: (closed: LinkClosed) => void;
  const ready = new Promise<LinkHello>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const closed = new Promise<LinkClosed>(resolve => { resolveClosed = resolve; });
  // The service may attach its observer after construction, including immediate EOF.
  void ready.catch(() => {});
  const peerName = (): string | undefined => peer?.machineName ?? helloSeen?.machineName ?? options.expected;
  const log = (level: LinkLogLevel, message: string, fields: Record<string, unknown> = {}): void => {
    const machine = peerName();
    // A log write is the end of the line: it has nowhere further to report.
    void options.run(linkLog(level, message, { machine: self.machineName, sessionId, ...(machine === undefined ? {} : { peer: machine }), ...fields })).catch(() => undefined);
  };
  const context = (operationId?: string): LinkChannelContext => {
    if (peer === undefined) throw new LinkUnavailable({ reason: "not-admitted", message: "The link hello is not admitted yet" });
    return { peer, sessionId, signal: controller.signal, ...(operationId === undefined ? {} : { operationId }),
      sendEvent: (channel, payload) => Effect.tryPromise({ try: () => sendEvent(channel, payload), catch: classify }),
      request: (channel, payload, op) => Effect.tryPromise({ try: () => request(channel, payload, op), catch: classify }),
      close: cause => Effect.promise(() => close(cause)),
    };
  };
  const classify = (cause: unknown): MachineLinkError => isMachineLinkError(cause) ? cause :
    linkClosed({ ...(peerName() === undefined ? {} : { machine: peerName()! }), by: "this-end", reason: "failed", cause });
  const closedFrom = (first: MachineLinkError): LinkClosed => first._tag === "LinkClosed" ? first :
    linkClosed({ ...(peerName() === undefined ? {} : { machine: peerName()! }), by: "this-end", reason: reasonFor(first), cause: first });
  const thisEnd = (reason: LinkClosedReason, causes: ReadonlyArray<EncodedCause> = []): LinkClosed =>
    linkClosed({ ...(peerName() === undefined ? {} : { machine: peerName()! }), by: "this-end", reason, causes });
  const finish = (cause: unknown, tellPeer = true): void => {
    if (stopped !== undefined) return;
    const first = classify(cause);
    const ended = closedFrom(first);
    stopped = ended;
    clearTimeout(helloTimer);
    controller.abort();
    rejectReady(first);
    for (const row of pending.values()) { clearTimeout(row.timer); row.reject(ended); }
    pending.clear();
    log(ended.by === "this-end" && ended.reason === "closed" ? "Info" : "Warning", "link closed", {
      by: ended.by, reason: ended.reason, failure: encodeError(first, { machine: self.machineName }),
      ...(ended.exitCode === undefined ? {} : { exitCode: ended.exitCode }), ...(ended.signal === undefined ? {} : { signal: ended.signal }),
    });
    // The closing end says why, once, before its output ends.
    let farewell: Buffer | undefined;
    if (tellPeer && ended.by === "this-end" && !options.writable.destroyed && !options.writable.writableEnded) {
      try { farewell = Buffer.from(JSON.stringify(decodeLinkFrame({ type: "close", failure: closeFailure(ended, first, self.machineName) })) + "\n"); }
      catch (encodeCause) { log("Warning", "link close reason did not encode", { failure: encodeError(encodeCause, { machine: self.machineName }) }); }
    }
    if (!duplex) options.readable.destroy();
    if (farewell !== undefined && farewell.length - 1 <= limits.frameBytes) {
      options.writable.end(farewell);
      setTimeout(() => options.writable.destroy(), CLOSE_FLUSH_MS).unref?.();
    } else {
      options.writable.destroy();
    }
    if (duplex && farewell === undefined) options.readable.destroy();
    if (peer !== undefined) {
      const ctx = context();
      for (const [name, channel] of Object.entries(channels)) if (channel?.closed !== undefined) {
        void options.run(channel.closed(ctx)).catch(hookCause => log("Warning", "link channel close hook failed", { channel: name, failure: encodeError(hookCause, { machine: self.machineName }) }));
      }
    }
    resolveClosed(ended);
  };
  const helloTimer = setTimeout(() => finish(thisEnd("hello-timeout")), limits.helloTimeoutMs);
  options.readable.on("error", (cause: Error) => finish(cause));
  if (!duplex) options.writable.on("error", (cause: Error) => finish(cause));
  options.writable.on("close", () => finish(linkClosed({ ...(peerName() === undefined ? {} : { machine: peerName()! }), by: "peer", reason: "output-closed", causes: [] }), false));
  const write = (input: unknown): Promise<void> => {
    if (stopped !== undefined) return Promise.reject(stopped);
    let bytes: Buffer;
    try {
      bytes = Buffer.from(JSON.stringify(decodeLinkFrame(input)) + "\n");
      if (bytes.length - 1 > limits.frameBytes || queuedBytes + bytes.length > limits.queuedBytes) throw thisEnd("bound-exceeded", [bound("Link output exceeds its bound")]);
    } catch (cause) { finish(cause); return Promise.reject(stopped ?? classify(cause)); }
    queuedBytes += bytes.length;
    const flight = writeTail.then(() => new Promise<void>((resolve, reject) => {
      if (stopped !== undefined) { reject(stopped); return; }
      let settled = false;
      const complete = (cause?: Error | null): void => {
        if (settled) return;
        settled = true; controller.signal.removeEventListener("abort", aborted);
        if (cause) reject(classify(cause)); else resolve();
      };
      const aborted = (): void => complete(stopped ?? thisEnd("closed"));
      controller.signal.addEventListener("abort", aborted, { once: true });
      try { options.writable.write(bytes, complete); } catch (cause) { complete(cause instanceof Error ? cause : classify(cause)); }
    })).finally(() => { queuedBytes -= bytes.length; });
    writeTail = flight.catch(cause => { finish(cause); });
    return flight;
  };
  const outbound = (channel: LinkChannel): LinkChannelHandler => {
    const selected = channels[channel];
    if (selected === undefined) throw new LinkUnavailable({ reason: "channel-unavailable", message: `Link channel ${channel} is unavailable`, ...(peerName() === undefined ? {} : { machine: peerName()! }) });
    return selected;
  };
  const inbound = (channel: LinkChannel): LinkChannelHandler => {
    const selected = channels[channel];
    if (selected === undefined) throw frameInvalid("unknown-channel", `Link channel ${channel} is unavailable`, peerName());
    return selected;
  };
  const checkAdmission = async (): Promise<LinkHello> => {
    if (stopped !== undefined) throw stopped;
    const admitted = await ready.catch(() => { throw stopped ?? thisEnd("failed"); });
    if (stopped !== undefined) throw stopped;
    await options.admit(admitted);
    if (stopped !== undefined) throw stopped;
    return admitted;
  };
  const request = async (channel: LinkChannel, payload: unknown, operationId: string = randomUUID()): Promise<unknown> => {
    await checkAdmission();
    if (!isOperationId(operationId)) throw frameInvalid("schema", "An operation id is 1 to 64 letters, digits, dots, dashes or underscores", peerName());
    const decodedPayload = decoded("payload", `The ${channel} request does not match its schema`, () => outbound(channel).decodeRequest(payload));
    if (pending.size >= limits.pendingRequests) { const error = thisEnd("bound-exceeded", [bound("Too many pending link requests")]); finish(error); throw error; }
    const id = randomUUID();
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => finish(thisEnd("request-timeout")), limits.requestTimeoutMs);
      pending.set(id, { channel, operationId, resolve, reject, timer });
    });
    void response.catch(() => {});
    log("Debug", "link request sent", { channel, operationId, requestId: id });
    try { await write({ type: "request", id, op: operationId, channel, payload: decodedPayload }); }
    catch (cause) { finish(cause); }
    return response;
  };
  const sendEvent = async (channel: LinkChannel, payload: unknown): Promise<void> => {
    await checkAdmission();
    await write({ type: "event", channel, payload: decoded("payload", `The ${channel} event does not match its schema`, () => outbound(channel).decodeEvent(payload)) });
  };
  const close = async (cause?: unknown): Promise<void> => {
    finish(cause === undefined ? thisEnd("closed") : isMachineLinkError(cause) ? cause : thisEnd("closed", [describeCause(cause), ...(classify(cause) as LinkClosed).causes.slice(1)]));
    await closed;
  };
  const enqueue = (channel: LinkChannel, work: () => Promise<void>): void => {
    if (++inboundCalls > limits.inboundCalls) { finish(thisEnd("bound-exceeded", [bound("Too many incoming link calls")])); return; }
    const previous = channelQueues.get(channel) ?? Promise.resolve();
    const flight = previous.then(async () => { if (stopped === undefined) await work(); }).catch(cause => finish(cause)).finally(() => { inboundCalls--; });
    channelQueues.set(channel, flight);
  };
  const encodeDetail = (selected: LinkChannelHandler, cause: unknown): unknown => {
    if (selected.failureSchema === undefined || !Schema.is(selected.failureSchema)(cause)) return undefined;
    try { return Schema.encodeUnknownSync(selected.failureSchema)(cause); }
    catch (encodeCause) { log("Warning", "link failure detail did not encode", { failure: encodeError(encodeCause, { machine: self.machineName }) }); return undefined; }
  };
  const receive = async (frame: LinkFrame): Promise<void> => {
    if (stopped !== undefined) return;
    if (frame.type === "close") {
      const failure = decodeEncodedFailure(frame.failure);
      finish(linkClosed({ ...(peerName() === undefined ? {} : { machine: peerName()! }), by: "peer", reason: "peer-closed", causes: [{ tag: failure.tag, message: failure.message }, ...failure.causes] }), false);
      return;
    }
    if (peer === undefined) {
      if (frame.type !== "hello") throw new LinkHelloRefused({ check: "first-frame", message: "Link hello must be first", ...(peerName() === undefined ? {} : { machine: peerName()! }) });
      const { type: _type, ...hello } = frame;
      helloSeen = Object.freeze(hello);
      if (hello.installationId === self.installationId) throw new LinkHelloRefused({ machine: hello.machineName, check: "self-link", message: "A Junto installation cannot link to itself" });
      await options.admit(helloSeen);
      if (hello.build !== self.build) throw LinkBuildMismatch.of(hello, self.build);
      if (stopped !== undefined) return;
      peer = helloSeen;
      clearTimeout(helloTimer);
      resolveReady(peer);
      log("Info", "link opened", { peerBuild: peer.build, peerInstallationId: peer.installationId });
      const ctx = context();
      for (const [name, channel] of Object.entries(channels)) if (channel?.opened !== undefined) {
        enqueue(name as LinkChannel, async () => { await checkAdmission(); await runOwned(channel.opened!(ctx)); });
      }
      return;
    }
    if (frame.type === "hello") throw new LinkHelloRefused({ machine: peer.machineName, check: "repeated", message: "Link hello cannot be repeated" });
    const selected = inbound(frame.channel);
    if (frame.type === "response") {
      await checkAdmission();
      const waiting = pending.get(frame.id);
      if (waiting === undefined || waiting.channel !== frame.channel || waiting.operationId !== frame.op) throw frameInvalid("unmatched-response", "Link response does not match a pending request", peer.machineName);
      if (frame.ok) {
        const value = decoded("payload", `The ${frame.channel} response does not match its schema`, () => selected.decodeResponse(frame.payload));
        clearTimeout(waiting.timer); pending.delete(frame.id);
        log("Debug", "link request answered", { channel: frame.channel, operationId: frame.op, requestId: frame.id });
        waiting.resolve(value);
        return;
      }
      const failure = decodeEncodedFailure(frame.failure);
      const detail = failure.detail === undefined || selected.failureSchema === undefined ? undefined
        : decoded("payload", `The ${frame.channel} failure detail does not match its schema`, () => Schema.decodeUnknownSync(selected.failureSchema!, { onExcessProperty: "error" })(failure.detail));
      clearTimeout(waiting.timer); pending.delete(frame.id);
      log("Warning", "link request failed on the peer", { channel: frame.channel, operationId: frame.op, requestId: frame.id, failure });
      waiting.reject(new LinkRequestFailed({
        machine: peer.machineName, channel: frame.channel, operationId: frame.op, failure, ...(detail === undefined ? {} : { detail }),
        message: `${peer.machineName} could not complete the ${frame.channel} request: ${failureSentence(failure)}`,
      }));
      return;
    }
    if (frame.type === "event") {
      const payload = decoded("payload", `The ${frame.channel} event does not match its schema`, () => selected.decodeEvent(frame.payload));
      if (selected.handleEvent === undefined) throw frameInvalid("no-handler", "Link channel does not accept events", peer.machineName);
      enqueue(frame.channel, async () => { await checkAdmission(); await runOwned(selected.handleEvent!(context(), payload)); });
      return;
    }
    const payload = decoded("payload", `The ${frame.channel} request does not match its schema`, () => selected.decodeRequest(frame.payload));
    if (selected.handleRequest === undefined) throw frameInvalid("no-handler", "Link channel does not accept requests", peer.machineName);
    if (inboundIds.has(frame.id) || completedIds.has(frame.id)) throw frameInvalid("duplicate-request", "Link request id was already used", peer.machineName);
    inboundIds.add(frame.id);
    enqueue(frame.channel, async () => {
      await checkAdmission();
      log("Debug", "link request received", { channel: frame.channel, operationId: frame.op, requestId: frame.id });
      try {
        const response = await runOwned(selected.handleRequest!(context(frame.op), payload));
        await checkAdmission();
        await write({ type: "response", id: frame.id, op: frame.op, channel: frame.channel, ok: true, payload: selected.decodeResponse(response) });
      } catch (cause) {
        if (stopped !== undefined) return;
        const failure = encodeError(cause, { machine: self.machineName, operationId: frame.op, detail: encodeDetail(selected, cause) });
        log("Warning", "link request failed", { channel: frame.channel, operationId: frame.op, requestId: frame.id, failure });
        await checkAdmission();
        await write({ type: "response", id: frame.id, op: frame.op, channel: frame.channel, ok: false, failure });
      } finally {
        inboundIds.delete(frame.id); completedIds.add(frame.id);
        if (completedIds.size > 256) completedIds.delete(completedIds.values().next().value!);
      }
    });
  };
  const read = async (): Promise<void> => {
    let pieces: Buffer[] = [];
    let count = 0;
    try {
      for await (const chunk of options.readable) {
        if (!(chunk instanceof Uint8Array)) throw frameInvalid("bytes", "Link input must contain bytes", peerName());
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        let offset = 0;
        while (offset < bytes.length) {
          const newline = bytes.indexOf(10, offset);
          const end = newline < 0 ? bytes.length : newline;
          count += end - offset;
          if (count > limits.frameBytes) throw frameInvalid("frame-bound", "Link input exceeds its frame bound", peerName());
          pieces.push(bytes.subarray(offset, end));
          if (newline < 0) break;
          const line = decoded("utf8", "Link input is not UTF-8", () => new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(pieces, count)));
          pieces = []; count = 0;
          const json = decoded("json", "Link input is not JSON", () => JSON.parse(line) as unknown);
          await receive(decoded("schema", "Link frame does not match the protocol", () => decodeLinkFrame(json)));
          offset = newline + 1;
          if (stopped !== undefined) return;
        }
      }
      finish(linkClosed({ ...(peerName() === undefined ? {} : { machine: peerName()! }), by: "peer", reason: "input-ended",
        causes: count > 0 ? [{ tag: "LinkFrameInvalid", message: "Link ended with an incomplete frame" }] : [] }), false);
    } catch (cause) { finish(cause); }
  };
  void write({ type: "hello", ...self }).catch(cause => finish(cause));
  void read();
  return { sessionId, ready, closed, request, sendEvent, close };
};
