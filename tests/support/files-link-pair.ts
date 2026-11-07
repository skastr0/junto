/**
 * Two real link sessions over a pair of streams, and `MachineLink` over one of
 * them, so the files channel's typed client and handlers run as they do in the
 * core (the same shape as tests/link-contract.test.ts).
 */
import { PassThrough } from "node:stream";
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

export type Peer = {
  readonly channels: LinkChannels;
  readonly self: LinkHello;
  /** How this end runs its handlers' effects: the core's runtime, with its log. Default is a bare run. */
  readonly run?: <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;
};

export const pair = (left: Peer, right: Peer) => {
  const ab = new PassThrough();
  const ba = new PassThrough();
  const a = makeLinkSession({ readable: ba, writable: ab, self: left.self, admit: async () => {}, channels: left.channels, run: left.run ?? Effect.runPromise });
  const b = makeLinkSession({ readable: ab, writable: ba, self: right.self, admit: async () => {}, channels: right.channels, run: right.run ?? Effect.runPromise });
  return { a, b };
};

/** A session facing an end written by hand, which says hello and writes what `reply` returns to each frame. */
export const facingRaw = (self: LinkHello, peer: LinkHello, channels: LinkChannels, reply: (frame: LinkFrame) => unknown = () => undefined) => {
  const toSession = new PassThrough();
  const fromSession = new PassThrough();
  const send = (frame: unknown) => toSession.write(`${JSON.stringify(frame)}\n`);
  let pending = "";
  fromSession.on("data", (bytes: Buffer) => {
    pending += bytes.toString();
    for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
      const frame = decodeLinkFrame(JSON.parse(pending.slice(0, newline)));
      pending = pending.slice(newline + 1);
      if (frame.type === "hello") send({ type: "hello", ...peer });
      else { const answer = reply(frame); if (answer !== undefined) send(answer); }
    }
  });
  const session = makeLinkSession({ readable: toSession, writable: fromSession, self, admit: async () => {}, channels, run: Effect.runPromise });
  return { session, send };
};

/**
 * `MachineLink` over the session `current` names now. With none it answers as
 * the live link does when no link to that machine is open.
 */
export const machineLinkOver = (current: () => LinkSession | undefined) => {
  const unused = Effect.die("unused");
  const toLink = (cause: unknown) => isMachineLinkError(cause) ? cause : linkClosed({ by: "this-end", reason: "failed", cause });
  const unlinked = (machine: string) => new LinkUnavailable({ machine, reason: "not-linked", message: `${machine} is not linked` });
  return MachineLink.of({
    setChannels: () => unused, listen: () => unused, connect: () => unused, connectSetup: () => unused, disconnect: () => unused, peerBuild: () => unused,
    request: (machine, channel, payload, options) => {
      const session = current();
      return session === undefined
        ? Effect.fail(unlinked(machine))
        : Effect.tryPromise({ try: () => session.request(channel, payload, options?.operationId, options?.tag), catch: toLink });
    },
    sendEvent: (machine, channel, payload) => {
      const session = current();
      return session === undefined
        ? Effect.fail(unlinked(machine))
        : Effect.tryPromise({ try: () => session.sendEvent(channel, payload), catch: toLink });
    },
  });
};

export const machineLinkLayer = (current: () => LinkSession | undefined) => Layer.succeed(MachineLink, machineLinkOver(current));
