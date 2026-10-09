import { randomUUID } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import { Effect, Schema } from "effect";
import { decodeLinkFrame, LinkHelloSchema, type LinkFrame } from "./protocol";
import { MachineLinkError, type LinkChannel, type LinkChannels, type LinkChannelContext, type LinkHello, type LinkSession } from "./types";

const DEFAULT_LIMITS = { frameBytes: 1024 * 1024, queuedBytes: 4 * 1024 * 1024, pendingRequests: 32, inboundCalls: 32, helloTimeoutMs: 10_000, requestTimeoutMs: 30_000 } as const;
export interface LinkSessionOptions {
  readonly readable: Readable;
  readonly writable: Writable;
  readonly self: LinkHello;
  readonly admit: (hello: LinkHello) => Promise<void>;
  readonly channels: LinkChannels;
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
  /** Tests may lower limits, never widen the production bounds. */
  readonly limits?: Partial<Record<keyof typeof DEFAULT_LIMITS, number>>;
}
interface Pending {
  readonly channel: LinkChannel;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: MachineLinkError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}
const failure = (cause: unknown): MachineLinkError => cause instanceof MachineLinkError ? cause : new MachineLinkError(cause instanceof Error ? cause.message : "Link failed");

/** A closed hello is available for diagnostics, but was never admitted. */
export class LinkBuildMismatch extends MachineLinkError {
  readonly peer: LinkHello;
  constructor(peer: LinkHello) {
    super(`Update ${peer.machineName} before connecting Junto`);
    this.peer = Object.freeze({ ...peer });
  }
}

/** One session implementation over either an owner socket or an SSH duplex. */
export const makeLinkSession = (options: LinkSessionOptions): LinkSession => {
  const limits = { ...DEFAULT_LIMITS } as Record<keyof typeof DEFAULT_LIMITS, number>;
  for (const [key, value] of Object.entries(options.limits ?? {})) {
    if (!Object.hasOwn(limits, key) || value === undefined || !Number.isInteger(value) || value < 1 || value > limits[key as keyof typeof limits]) throw new MachineLinkError("Invalid link limits");
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
  const pending = new Map<string, Pending>();
  const inboundIds = new Set<string>();
  const completedIds = new Set<string>();
  const channelQueues = new Map<LinkChannel, Promise<void>>();
  let inboundCalls = 0;
  let peer: LinkHello | undefined;
  let stopped: MachineLinkError | undefined;
  let queuedBytes = 0;
  let writeTail = Promise.resolve();
  let resolveReady!: (peer: LinkHello) => void;
  let rejectReady!: (error: MachineLinkError) => void;
  let resolveClosed!: () => void;
  const ready = new Promise<LinkHello>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
  // The service may attach its observer after construction, including immediate EOF.
  void ready.catch(() => {});
  const context = (): LinkChannelContext => {
    if (peer === undefined) throw new MachineLinkError("Link hello is not admitted");
    return { peer, sessionId, signal: controller.signal,
      sendEvent: (channel, payload) => Effect.tryPromise({ try: () => sendEvent(channel, payload), catch: failure }),
      request: (channel, payload) => Effect.tryPromise({ try: () => request(channel, payload), catch: failure }),
    };
  };
  const finish = (cause: unknown): void => {
    if (stopped !== undefined) return;
    stopped = failure(cause);
    clearTimeout(helloTimer);
    controller.abort();
    rejectReady(stopped);
    for (const row of pending.values()) { clearTimeout(row.timer); row.reject(stopped); }
    pending.clear();
    options.readable.destroy();
    options.writable.destroy();
    if (peer !== undefined) {
      const ctx = context();
      // Close notification is best effort; the aborted context owns cancellation.
      for (const channel of Object.values(channels)) if (channel?.closed !== undefined) {
        try { void options.run(channel.closed(ctx)).catch(() => {}); } catch { /* Closed hooks cannot reopen a session. */ }
      }
    }
    resolveClosed();
  };
  const helloTimer = setTimeout(() => finish(new MachineLinkError("Link hello timed out")), limits.helloTimeoutMs);
  const onError = (cause: Error): void => finish(cause);
  options.readable.on("error", onError);
  options.writable.on("error", onError);
  options.writable.on("close", () => finish(new MachineLinkError("Link output closed")));
  const write = (input: unknown): Promise<void> => {
    if (stopped !== undefined) return Promise.reject(stopped);
    let bytes: Buffer;
    try {
      bytes = Buffer.from(JSON.stringify(decodeLinkFrame(input)) + "\n");
      if (bytes.length - 1 > limits.frameBytes || queuedBytes + bytes.length > limits.queuedBytes) throw new MachineLinkError("Link output exceeds its bound");
    } catch (cause) { finish(cause); return Promise.reject(failure(cause)); }
    queuedBytes += bytes.length;
    const flight = writeTail.then(() => new Promise<void>((resolve, reject) => {
      if (stopped !== undefined) { reject(stopped); return; }
      let settled = false;
      const complete = (cause?: Error | null): void => {
        if (settled) return;
        settled = true; controller.signal.removeEventListener("abort", aborted);
        if (cause) reject(failure(cause)); else resolve();
      };
      const aborted = (): void => complete(stopped ?? new MachineLinkError("Link closed"));
      controller.signal.addEventListener("abort", aborted, { once: true });
      try { options.writable.write(bytes, complete); } catch (cause) { complete(failure(cause)); }
    })).finally(() => { queuedBytes -= bytes.length; });
    writeTail = flight.catch(cause => { finish(cause); });
    return flight;
  };
  const handler = (channel: LinkChannel) => {
    const selected = channels[channel];
    if (selected === undefined) throw new MachineLinkError(`Link channel ${channel} is unavailable`);
    return selected;
  };
  const checkAdmission = async (): Promise<LinkHello> => {
    const admitted = await ready;
    if (stopped !== undefined) throw stopped;
    await options.admit(admitted);
    if (stopped !== undefined) throw stopped;
    return admitted;
  };
  const request = async (channel: LinkChannel, payload: unknown): Promise<unknown> => {
    await checkAdmission();
    const decoded = handler(channel).decodeRequest(payload);
    if (pending.size >= limits.pendingRequests) { const error = new MachineLinkError("Too many pending link requests"); finish(error); throw error; }
    const id = randomUUID();
    const response = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => finish(new MachineLinkError("Link request timed out; its outcome is uncertain")), limits.requestTimeoutMs);
      pending.set(id, { channel, resolve, reject, timer });
    });
    void response.catch(() => {});
    try { await write({ type: "request", id, channel, payload: decoded }); }
    catch (cause) { finish(cause); }
    return response;
  };
  const sendEvent = async (channel: LinkChannel, payload: unknown): Promise<void> => {
    await checkAdmission();
    await write({ type: "event", channel, payload: handler(channel).decodeEvent(payload) });
  };
  const enqueue = (channel: LinkChannel, work: () => Promise<void>): void => {
    if (++inboundCalls > limits.inboundCalls) { finish(new MachineLinkError("Too many incoming link calls")); return; }
    const previous = channelQueues.get(channel) ?? Promise.resolve();
    const flight = previous.then(async () => { if (stopped === undefined) await work(); }).catch(cause => finish(cause)).finally(() => { inboundCalls--; });
    channelQueues.set(channel, flight);
  };
  const receive = async (frame: LinkFrame): Promise<void> => {
    if (stopped !== undefined) return;
    if (peer === undefined) {
      if (frame.type !== "hello") throw new MachineLinkError("Link hello must be first");
      const { type: _type, ...hello } = frame;
      if (hello.installationId === self.installationId) throw new MachineLinkError("A Junto installation cannot link to itself");
      await options.admit(Object.freeze(hello));
      if (hello.build !== self.build) throw new LinkBuildMismatch(hello);
      if (stopped !== undefined) return;
      peer = Object.freeze(hello);
      clearTimeout(helloTimer);
      resolveReady(peer);
      const ctx = context();
      for (const [name, channel] of Object.entries(channels)) if (channel?.opened !== undefined) {
        enqueue(name as LinkChannel, async () => { await checkAdmission(); await runOwned(channel.opened!(ctx)); });
      }
      return;
    }
    if (frame.type === "hello") throw new MachineLinkError("Link hello cannot be repeated");
    const selected = handler(frame.channel);
    if (frame.type === "response") {
      await checkAdmission();
      const waiting = pending.get(frame.id);
      if (waiting === undefined || waiting.channel !== frame.channel) throw new MachineLinkError("Link response does not match a pending request");
      const decoded = frame.ok ? selected.decodeResponse(frame.payload) : undefined;
      clearTimeout(waiting.timer); pending.delete(frame.id);
      if (frame.ok) waiting.resolve(decoded); else waiting.reject(new MachineLinkError(frame.error.message));
      return;
    }
    if (frame.type === "event") {
      const payload = selected.decodeEvent(frame.payload);
      if (selected.handleEvent === undefined) throw new MachineLinkError("Link channel does not accept events");
      enqueue(frame.channel, async () => { await checkAdmission(); await runOwned(selected.handleEvent!(context(), payload)); });
      return;
    }
    const payload = selected.decodeRequest(frame.payload);
    if (selected.handleRequest === undefined) throw new MachineLinkError("Link channel does not accept requests");
    if (inboundIds.has(frame.id) || completedIds.has(frame.id)) throw new MachineLinkError("Link request id was already used");
    inboundIds.add(frame.id);
    enqueue(frame.channel, async () => {
      await checkAdmission();
      try {
        const response = await runOwned(selected.handleRequest!(context(), payload));
        await checkAdmission();
        await write({ type: "response", id: frame.id, channel: frame.channel, ok: true, payload: selected.decodeResponse(response) });
      } catch (cause) {
        if (stopped !== undefined) return;
        await checkAdmission();
        await write({ type: "response", id: frame.id, channel: frame.channel, ok: false,
          error: { message: cause instanceof MachineLinkError ? cause.message.slice(0, 1024) || "Channel request failed" : "Channel request failed" } });
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
        if (!(chunk instanceof Uint8Array)) throw new MachineLinkError("Link input must contain bytes");
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        let offset = 0;
        while (offset < bytes.length) {
          const newline = bytes.indexOf(10, offset);
          const end = newline < 0 ? bytes.length : newline;
          count += end - offset;
          if (count > limits.frameBytes) throw new MachineLinkError("Link input exceeds its frame bound");
          pieces.push(bytes.subarray(offset, end));
          if (newline < 0) break;
          const line = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(pieces, count));
          pieces = []; count = 0;
          await receive(decodeLinkFrame(JSON.parse(line)));
          offset = newline + 1;
          if (stopped !== undefined) return;
        }
      }
      finish(new MachineLinkError(count > 0 ? "Link ended with an incomplete frame" : "Link input ended"));
    } catch (cause) { finish(cause); }
  };
  void write({ type: "hello", ...self }).catch(cause => finish(cause));
  void read();
  return { sessionId, ready, closed, request, sendEvent, close: async () => { finish(new MachineLinkError("Link closed")); await closed; } };
};
