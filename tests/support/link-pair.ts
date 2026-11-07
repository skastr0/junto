/**
 * Real link sessions for tests, and `MachineLink` over them, so a channel's
 * typed client and handlers run as they do in the core: never a direct
 * handler call. `rows-channel.ts` is a different thing: it drives the rows
 * contract by hand.
 */
import { PassThrough, Transform, type Writable } from "node:stream";
import { Effect, Layer, Schema } from "effect";
import { decodeLinkFrame, LinkHelloSchema, type LinkFrame } from "../../src/core/link/protocol";
import { isMachineLinkError, MachineLink } from "../../src/core/link/service";
import { makeLinkSession } from "../../src/core/link/session";
import { linkClosed, LinkUnavailable, type LinkChannels, type LinkHello, type LinkSession } from "../../src/core/link/types";

export const hello = (name: string, installationId = `${name}-install`): LinkHello =>
  Schema.decodeUnknownSync(LinkHelloSchema)({ build: "a".repeat(64), installationId, machineName: name });

/** Sessions a test opened; `closeAll` is for its `afterEach`. */
export const makeSessions = () => {
  const open: LinkSession[] = [];
  const keep = (...sessions: LinkSession[]): void => { open.push(...sessions); };
  return { keep, closeAll: async (): Promise<void> => { await Promise.all(open.splice(0).map((session) => session.close())); } };
};

export type Run = <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;

export type Peer = {
  readonly channels: LinkChannels;
  readonly self: LinkHello;
  /** How this end runs its handlers' effects: the core's runtime, with its log. Default is a bare run. */
  readonly run?: Run;
};

/** Calls `frame` with each NDJSON frame written through it, as it crosses. */
const tapped = (into: Writable, frame: (frame: LinkFrame) => void): Transform => {
  let line = "";
  const tap = new Transform({ transform(chunk: Buffer, _encoding, done) {
    line += chunk.toString();
    for (let newline = line.indexOf("\n"); newline >= 0; newline = line.indexOf("\n")) {
      frame(decodeLinkFrame(JSON.parse(line.slice(0, newline))));
      line = line.slice(newline + 1);
    }
    done(null, chunk);
  } });
  tap.pipe(into);
  return tap;
};

/** A real session at each end; `sent` sees each frame the left end writes. */
export const pair = (left: Peer, right: Peer, options: { readonly sent?: (frame: LinkFrame) => void } = {}) => {
  const ab = new PassThrough();
  const ba = new PassThrough();
  const leftOut = options.sent === undefined ? ab : tapped(ab, options.sent);
  const a = makeLinkSession({ readable: ba, writable: leftOut, self: left.self, admit: async () => {}, channels: left.channels, run: left.run ?? Effect.runPromise });
  const b = makeLinkSession({ readable: ab, writable: ba, self: right.self, admit: async () => {}, channels: right.channels, run: right.run ?? Effect.runPromise });
  return { a, b };
};

/**
 * A real session facing an end written by hand, which says `peer`'s hello and
 * writes what `reply` returns to each frame; `frames` holds every frame the
 * session wrote.
 */
export const facingRaw = (self: LinkHello, peer: LinkHello, channels: LinkChannels, reply: (frame: LinkFrame) => unknown = () => undefined, run: Run = Effect.runPromise) => {
  const toSession = new PassThrough();
  const fromSession = new PassThrough();
  const frames: LinkFrame[] = [];
  const send = (frame: unknown) => toSession.write(`${JSON.stringify(frame)}\n`);
  let pending = "";
  fromSession.on("data", (bytes: Buffer) => {
    pending += bytes.toString();
    for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
      const frame = decodeLinkFrame(JSON.parse(pending.slice(0, newline)));
      pending = pending.slice(newline + 1);
      frames.push(frame);
      if (frame.type === "hello") send({ type: "hello", ...peer });
      else { const answer = reply(frame); if (answer !== undefined) send(answer); }
    }
  });
  const session = makeLinkSession({ readable: toSession, writable: fromSession, self, admit: async () => {}, channels, run });
  return { session, send, frames };
};

type MachineLinkShape = typeof MachineLink.Service;

/**
 * `MachineLink` over one session, or over the session `current` names now.
 * With none it answers as the live link does when no link to that machine is
 * open. The caller's interruption reaches the session as its signal, as in the
 * live link. `rest` answers the operations a test needs beyond request and send.
 */
export const machineLinkOver = (current: LinkSession | (() => LinkSession | undefined), rest: Partial<MachineLinkShape> = {}): MachineLinkShape => {
  const held = typeof current === "function" ? current : () => current;
  const unused = Effect.die("unused");
  const toLink = (machine: string) => (cause: unknown) => isMachineLinkError(cause) ? cause : linkClosed({ machine, by: "this-end", reason: "failed", cause });
  const unlinked = (machine: string) => new LinkUnavailable({ machine, reason: "not-linked", message: `${machine} is not linked` });
  return MachineLink.of({
    setChannels: () => unused, listen: () => unused, connect: () => unused, connectSetup: () => unused, disconnect: () => unused, peerBuild: () => unused,
    request: (machine, channel, payload, options) => {
      const session = held();
      return session === undefined
        ? Effect.fail(unlinked(machine))
        : Effect.tryPromise({ try: (signal) => session.request(channel, payload, options?.operationId, options?.tag, signal), catch: toLink(machine) });
    },
    sendEvent: (machine, channel, payload) => {
      const session = held();
      return session === undefined
        ? Effect.fail(unlinked(machine))
        : Effect.tryPromise({ try: () => session.sendEvent(channel, payload), catch: toLink(machine) });
    },
    ...rest,
  });
};

export const machineLinkLayer = (current: LinkSession | (() => LinkSession | undefined)) => Layer.succeed(MachineLink, machineLinkOver(current));
