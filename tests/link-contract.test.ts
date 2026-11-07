/**
 * A link channel's contract, through two real sessions over a pair of
 * streams: the typed client at one end, the handlers bound by the same
 * contract at the other. The `@ts-expect-error` lines are the compile half:
 * each is a change the contract refuses at the caller or at the handler.
 */
import { PassThrough } from "node:stream";
import { Effect, Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";
import { afterEach, describe, expect, it } from "vitest";
import { bindLinkChannel, linkClient, linkContract, type LinkContractChannel } from "../src/core/link/contract";
import { decodeLinkFrame, LinkHelloSchema, type LinkFrame } from "../src/core/link/protocol";
import { isMachineLinkError, MachineLink } from "../src/core/link/service";
import { makeLinkSession } from "../src/core/link/session";
import { linkClosed, LinkRequestFailed, type LinkChannelHandler, type LinkChannels, type LinkHello, type LinkSession } from "../src/core/link/types";

class Busy extends Schema.TaggedError<Busy>()("Busy", { retryAfter: Schema.Number }) {}
class Elsewhere extends Schema.TaggedError<Elsewhere>()("Elsewhere", { message: Schema.String }) {}

/** Two tags with their own answers and refusals; `at` crosses as text and arrives as a Date. */
const Echo = linkContract("status", RpcGroup.make(
  Rpc.make("Say", { payload: { text: Schema.String }, success: Schema.Struct({ said: Schema.String, at: Schema.Date }), error: Busy }),
  Rpc.make("Count", { payload: { upTo: Schema.Int }, success: Schema.Array(Schema.Int) }),
), { event: Schema.Struct({ seen: Schema.Date }) });

const Quiet = linkContract("rows", RpcGroup.make(Rpc.make("Ping", { success: Schema.Literal("pong") })));

const sessions: LinkSession[] = [];
afterEach(async () => { await Promise.all(sessions.splice(0).map((session) => session.close())); });
const hello = (name: string): LinkHello => Schema.decodeUnknownSync(LinkHelloSchema)({ build: "a".repeat(64), installationId: `${name}-install`, machineName: name });

const pair = (left: LinkChannels, right: LinkChannels) => {
  const ab = new PassThrough(); const ba = new PassThrough();
  const a = makeLinkSession({ readable: ba, writable: ab, self: hello("macbook"), admit: async () => {}, channels: left, run: Effect.runPromise });
  const b = makeLinkSession({ readable: ab, writable: ba, self: hello("mini"), admit: async () => {}, channels: right, run: Effect.runPromise });
  sessions.push(a, b);
  return { a, b };
};

/** A session facing an end written by hand, which says hello and writes what `reply` returns to each frame. */
const facingRaw = (channels: LinkChannels, reply: (frame: LinkFrame) => unknown = () => undefined) => {
  const toSession = new PassThrough(); const fromSession = new PassThrough();
  const send = (frame: unknown) => toSession.write(`${JSON.stringify(frame)}\n`);
  let pending = "";
  fromSession.on("data", (bytes: Buffer) => {
    pending += bytes.toString();
    for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
      const frame = decodeLinkFrame(JSON.parse(pending.slice(0, newline)));
      pending = pending.slice(newline + 1);
      if (frame.type === "hello") send({ type: "hello", ...hello("mini") });
      else { const answer = reply(frame); if (answer !== undefined) send(answer); }
    }
  });
  const session = makeLinkSession({ readable: toSession, writable: fromSession, self: hello("macbook"), admit: async () => {}, channels, run: Effect.runPromise });
  sessions.push(session);
  return { session, send };
};

/** `MachineLink` over one session, so the typed client runs as it does in the core. */
const over = (session: LinkSession) => {
  const unused = Effect.die("unused");
  const toLink = (cause: unknown) => isMachineLinkError(cause) ? cause : linkClosed({ by: "this-end", reason: "failed", cause });
  return MachineLink.of({
    setChannels: () => unused, listen: () => unused, connect: () => unused, connectSetup: () => unused, disconnect: () => unused, peerBuild: () => unused,
    request: (_machine, channel, payload, options) => Effect.tryPromise({ try: () => session.request(channel, payload, options?.operationId, options?.tag), catch: toLink }),
    sendEvent: (_machine, channel, payload) => Effect.tryPromise({ try: () => session.sendEvent(channel, payload), catch: toLink }),
  });
};
const client = <A, E>(session: LinkSession, use: (echo: Effect.Success<ReturnType<typeof linkClient<typeof Echo>>>) => Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.flatMap(linkClient(Echo), use).pipe(Effect.provideService(MachineLink, over(session))));

const asker = (): LinkContractChannel => bindLinkChannel(Echo, {
  requests: { Say: () => Effect.die("asker"), Count: () => Effect.die("asker") },
  event: () => Effect.void,
});

describe("a contract channel over a real session pair", () => {
  it("dispatches by tag, and each tag's answer arrives as its own Type", async () => {
    const at = new Date("2026-11-07T10:00:00.000Z");
    const served = bindLinkChannel(Echo, {
      requests: {
        Say: ({ text }) => Effect.succeed({ said: text.toUpperCase(), at }),
        Count: ({ upTo }) => Effect.succeed(Array.from({ length: upTo }, (_, i) => i + 1)),
      },
      event: () => Effect.void,
    });
    const { a } = pair({ status: asker() }, { status: served });
    const said = await client(a, (echo) => echo.Say("mini", { text: "hi" }));
    expect(said).toEqual({ said: "HI", at });
    expect(said.at).toBeInstanceOf(Date);
    expect(await client(a, (echo) => echo.Count("mini", { upTo: 3 }))).toEqual([1, 2, 3]);
  });

  it("carries a refusal its tag's error schema holds as itself; any other as the link's own", async () => {
    const served = bindLinkChannel(Echo, {
      requests: {
        Say: ({ text }) => text === "busy" ? Effect.fail(new Busy({ retryAfter: 5 })) : Effect.die(new Elsewhere({ message: "not in the contract" })),
        Count: () => Effect.succeed([]),
      },
      event: () => Effect.void,
    });
    const { a } = pair({ status: asker() }, { status: served });
    const busy = await client(a, (echo) => Effect.flip(echo.Say("mini", { text: "busy" })));
    expect(busy).toBeInstanceOf(Busy);
    expect(busy).toMatchObject({ _tag: "Busy", retryAfter: 5 });
    const other = await client(a, (echo) => Effect.flip(echo.Say("mini", { text: "other" })));
    expect(other).toBeInstanceOf(LinkRequestFailed);
    expect(other).not.toHaveProperty("detail");
  });

  it("refuses an answer outside its tag's schema for that request only: the link stays open", async () => {
    let answer: unknown = { said: 1, at: "2026-11-07T10:00:00.000Z" };
    const raw = facingRaw({ status: asker() }, (frame) => frame.type === "request"
      ? { type: "response", id: frame.id, op: frame.op, channel: frame.channel, ok: true, payload: answer } : undefined);
    const refused = await client(raw.session, (echo) => Effect.flip(echo.Say("mini", { text: "hi" })));
    expect(refused).toMatchObject({ _tag: "LinkFrameInvalid", problem: "response" });
    answer = { said: "fine", at: "2026-11-07T10:00:00.000Z" };
    expect(await client(raw.session, (echo) => echo.Say("mini", { text: "hi" }))).toEqual({ said: "fine", at: new Date("2026-11-07T10:00:00.000Z") });
  });

  it("closes on a request whose tag the contract does not name, or that has no tag", async () => {
    for (const tag of ["Shout", undefined]) {
      const raw = facingRaw({ status: asker() });
      await raw.session.ready;
      raw.send({ type: "request", id: "r1", op: "op-1", channel: "status", ...(tag === undefined ? {} : { tag }), payload: { text: "hi" } });
      const closed = await raw.session.closed;
      expect(closed).toMatchObject({ by: "this-end", reason: "frame-invalid" });
      expect(closed.message).toContain("has no request");
    }
  });

  it("closes on a tag sent to a channel not yet converted", async () => {
    const decode = (payload: unknown) => payload;
    const legacy: LinkChannelHandler = { decodeRequest: decode, decodeResponse: decode, decodeEvent: decode, handleRequest: (_context, payload) => Effect.succeed(payload) };
    const raw = facingRaw({ status: legacy });
    await raw.session.ready;
    raw.send({ type: "request", id: "r1", op: "op-1", channel: "status", tag: "Say", payload: {} });
    expect((await raw.session.closed).message).toContain("takes no request tag");
  });

  it("sends a typed event, encoded and decoded by the event schema", async () => {
    const seen: Array<Date> = [];
    const served = bindLinkChannel(Echo, {
      requests: { Say: () => Effect.die("unused"), Count: () => Effect.die("unused") },
      event: ({ seen: at }) => Effect.sync(() => { seen.push(at); }),
    });
    const { a } = pair({ status: asker() }, { status: served });
    const at = new Date("2026-11-07T11:00:00.000Z");
    await client(a, (echo) => echo.sendEvent("mini", { seen: at }));
    await expect.poll(() => seen).toEqual([at]);
    expect(seen[0]).toBeInstanceOf(Date);
  });

  it("closes on an event sent to a channel that carries none", async () => {
    const raw = facingRaw({ rows: bindLinkChannel(Quiet, { requests: { Ping: () => Effect.succeed("pong" as const) } }) });
    await raw.session.ready;
    raw.send({ type: "event", channel: "rows", payload: {} });
    expect((await raw.session.closed).message).toContain("does not accept events");
  });
});

describe("a contract change fails the compile of both ends", () => {
  it("types the caller and the handlers by the same contract", () => {
    const typed = Effect.gen(function* () {
      const echo = yield* linkClient(Echo);
      // @ts-expect-error a payload field the Rpc does not name
      yield* echo.Say("mini", { words: "hi" });
      // @ts-expect-error a request tag the contract does not name
      yield* echo.Shout("mini", { text: "hi" });
      const said = yield* echo.Say("mini", { text: "hi" });
      // @ts-expect-error a success field the Rpc does not name
      void said.text;
      const quiet = yield* linkClient(Quiet);
      // @ts-expect-error a channel without events takes no event
      yield* quiet.sendEvent("mini", {});
      return yield* echo.Say("mini", { text: "hi" }).pipe(
        // @ts-expect-error an error the Rpc does not name
        Effect.catchTag("Elsewhere", () => Effect.void),
      );
    });
    void typed;
    bindLinkChannel(Echo, {
      requests: {
        // @ts-expect-error a handler answering with a field the Rpc does not name
        Say: () => Effect.succeed({ text: "hi", at: new Date() }),
        Count: () => Effect.succeed([1]),
      },
      event: () => Effect.void,
    });
    bindLinkChannel(Echo, {
      requests: {
        // @ts-expect-error a handler refusing with an error the Rpc does not name
        Say: () => Effect.fail(new Elsewhere({ message: "no" })),
        Count: () => Effect.succeed([1]),
      },
      event: () => Effect.void,
    });
    // @ts-expect-error a contract with events needs its event handler
    bindLinkChannel(Echo, { requests: { Say: () => Effect.die("x"), Count: () => Effect.die("x") } });
    // @ts-expect-error every request tag needs its handler
    bindLinkChannel(Echo, { requests: { Say: () => Effect.die("x") }, event: () => Effect.void });
    expect(true).toBe(true);
  });
});
