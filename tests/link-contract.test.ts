/**
 * A link channel's contract, through two real sessions over a pair of
 * streams: the typed client at one end, the handlers bound by the same
 * contract at the other. The `@ts-expect-error` lines are the compile half:
 * each is a change the contract refuses at the caller or at the handler.
 */
import { PassThrough, Transform } from "node:stream";
import { Effect, Fiber, Schema } from "effect";
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

/**
 * A marker on a channel of its own. The peer reads frames in the order they
 * were written, and acts on an interrupt as it reads it, so a marker sent
 * after an interrupt, once handled there, proves the interrupt was read.
 */
const Marker = linkContract("seats", RpcGroup.make(), { event: Schema.Struct({ mark: Schema.Int }) });

const sessions: LinkSession[] = [];
afterEach(async () => { await Promise.all(sessions.splice(0).map((session) => session.close())); });
const hello = (name: string): LinkHello => Schema.decodeUnknownSync(LinkHelloSchema)({ build: "a".repeat(64), installationId: `${name}-install`, machineName: name });

/** `sent` sees each frame the left end writes, as it crosses. */
const pair = (left: LinkChannels, right: LinkChannels, sent: (frame: LinkFrame) => void = () => {}) => {
  const ab = new PassThrough(); const ba = new PassThrough();
  let line = "";
  const tap = new Transform({ transform(chunk: Buffer, _encoding, done) {
    line += chunk.toString();
    for (let newline = line.indexOf("\n"); newline >= 0; newline = line.indexOf("\n")) { sent(decodeLinkFrame(JSON.parse(line.slice(0, newline)))); line = line.slice(newline + 1); }
    done(null, chunk);
  } });
  tap.pipe(ab);
  const a = makeLinkSession({ readable: ba, writable: tap, self: hello("macbook"), admit: async () => {}, channels: left, run: Effect.runPromise });
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
    request: (_machine, channel, payload, options) => Effect.tryPromise({ try: (signal) => session.request(channel, payload, options?.operationId, options?.tag, signal), catch: toLink }),
    sendEvent: (_machine, channel, payload) => Effect.tryPromise({ try: () => session.sendEvent(channel, payload), catch: toLink }),
  });
};
type EchoClient = Effect.Success<ReturnType<typeof linkClient<typeof Echo>>>;
const client = <A, E>(session: LinkSession, use: (echo: EchoClient) => Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.flatMap(linkClient(Echo), use).pipe(Effect.provideService(MachineLink, over(session))));
/** A call left running, so the test can interrupt its caller. */
const forked = <A, E>(session: LinkSession, use: (echo: EchoClient) => Effect.Effect<A, E>) =>
  Effect.runFork(Effect.flatMap(linkClient(Echo), use).pipe(Effect.provideService(MachineLink, over(session))));

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

  it("binds a channel with events and no requests: its group is empty", async () => {
    const Events = linkContract("rows", RpcGroup.make(), { event: Schema.Struct({ n: Schema.Int }) });
    const got: Array<number> = [];
    const { a } = pair({ rows: bindLinkChannel(Events, { requests: {}, event: () => Effect.void }) },
      { rows: bindLinkChannel(Events, { requests: {}, event: ({ n }) => Effect.sync(() => { got.push(n); }) }) });
    await Effect.runPromise(Effect.flatMap(linkClient(Events), (rows) => rows.sendEvent("mini", { n: 7 })).pipe(Effect.provideService(MachineLink, over(a))));
    await expect.poll(() => got).toEqual([7]);
  });

  it("closes on an event sent to a channel that carries none", async () => {
    const raw = facingRaw({ rows: bindLinkChannel(Quiet, { requests: { Ping: () => Effect.succeed("pong" as const) } }) });
    await raw.session.ready;
    raw.send({ type: "event", channel: "rows", payload: {} });
    expect((await raw.session.closed).message).toContain("does not accept events");
  });
});

describe("a caller interrupted mid-request", () => {
  it("interrupts the peer's handler and aborts its signal; the channel then serves the next request", async () => {
    const seen: Array<{ readonly interrupted: boolean; readonly aborted: boolean }> = [];
    let started = false;
    const served = bindLinkChannel(Echo, {
      requests: {
        Say: ({ text }, context) => text !== "slow" ? Effect.succeed({ said: text, at: new Date(0) }) : Effect.sync(() => { started = true; }).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Effect.sync(() => { seen.push({ interrupted: true, aborted: context.signal.aborted }); })),
        ),
        Count: () => Effect.succeed([]),
      },
      event: () => Effect.void,
    });
    const { a } = pair({ status: asker() }, { status: served });
    const fiber = forked(a, (echo) => echo.Say("mini", { text: "slow" }));
    await expect.poll(() => started).toBe(true);
    await Effect.runPromise(Fiber.interrupt(fiber));
    await expect.poll(() => seen).toEqual([{ interrupted: true, aborted: true }]);
    // Requests on one channel run in turn at the peer: this one would wait behind the slow one forever.
    expect(await client(a, (echo) => echo.Say("mini", { text: "next" }))).toMatchObject({ said: "next" });
  });

  it("skips a request interrupted while it waits its turn: its handler never runs", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const counted: Array<number> = [];
    const served = bindLinkChannel(Echo, {
      requests: {
        Say: ({ text }) => Effect.promise(() => gate).pipe(Effect.as({ said: text, at: new Date(0) })),
        Count: ({ upTo }) => Effect.sync(() => { counted.push(upTo); return []; }),
      },
      event: () => Effect.void,
    });
    const sent: Array<LinkFrame> = [];
    const marks: Array<number> = [];
    const { a } = pair(
      { status: asker(), seats: bindLinkChannel(Marker, { requests: {}, event: () => Effect.void }) },
      { status: served, seats: bindLinkChannel(Marker, { requests: {}, event: ({ mark }) => Effect.sync(() => { marks.push(mark); }) }) },
      (frame) => sent.push(frame),
    );
    const first = client(a, (echo) => echo.Say("mini", { text: "first" }));
    const queued = forked(a, (echo) => echo.Count("mini", { upTo: 1 }));
    // The peer holds it, queued behind the first: only then is it interrupted.
    await expect.poll(() => sent.filter((frame) => frame.type === "request").length).toBe(2);
    await Effect.runPromise(Fiber.interrupt(queued));
    expect(sent.at(-1)).toMatchObject({ type: "interrupt" });
    // The first is released only once the peer has read the interrupt, never after a guess at time.
    await Effect.runPromise(Effect.flatMap(linkClient(Marker), (marker) => marker.sendEvent("mini", { mark: 1 })).pipe(Effect.provideService(MachineLink, over(a))));
    await expect.poll(() => marks).toEqual([1]);
    release();
    expect(await first).toMatchObject({ said: "first" });
    expect(await client(a, (echo) => echo.Count("mini", { upTo: 2 }))).toEqual([]);
    expect(counted).toEqual([2]);
  });

  it("drops a late answer to an interrupted request, and the link stays open", async () => {
    const held: Array<LinkFrame & { readonly type: "request" }> = [];
    const interrupts: Array<LinkFrame> = [];
    const raw = facingRaw({ status: asker() }, (frame) => {
      if (frame.type === "request" && (frame.payload as { readonly text?: string }).text === "slow") { held.push(frame); return undefined; }
      if (frame.type === "request") return { type: "response", id: frame.id, op: frame.op, channel: frame.channel, ok: true, payload: { said: "now", at: "1970-01-01T00:00:00.000Z" } };
      if (frame.type !== "interrupt") return undefined;
      interrupts.push(frame);
      // A peer that answers anyway: the interrupt crossed its answer.
      const late = held.find((request) => request.id === frame.id)!;
      return { type: "response", id: late.id, op: late.op, channel: late.channel, ok: true, payload: { said: "late", at: "1970-01-01T00:00:00.000Z" } };
    });
    const fiber = forked(raw.session, (echo) => echo.Say("mini", { text: "slow" }, { operationId: "op-slow" }));
    await expect.poll(() => held.length).toBe(1);
    await Effect.runPromise(Fiber.interrupt(fiber));
    await expect.poll(() => interrupts).toEqual([{ type: "interrupt", id: held[0]!.id, op: "op-slow", channel: "status" }]);
    expect(await client(raw.session, (echo) => echo.Say("mini", { text: "fast" }))).toMatchObject({ said: "now" });
  });
});

describe("an answer no request waits for", () => {
  it("is dropped with the link open, whatever its id: one never sent, or interrupted long ago", async () => {
    const raw = facingRaw({ status: asker() }, (frame) => frame.type === "request"
      ? { type: "response", id: frame.id, op: frame.op, channel: frame.channel, ok: true, payload: { said: "now", at: "1970-01-01T00:00:00.000Z" } } : undefined);
    await raw.session.ready;
    raw.send({ type: "response", id: "never-sent", op: "op-x", channel: "status", ok: true, payload: { said: "stray", at: "1970-01-01T00:00:00.000Z" } });
    raw.send({ type: "response", id: "never-sent-2", op: "op-y", channel: "status", ok: false, failure: { tag: "Stray", message: "stray", machine: "mini", operationId: "op-y", causes: [] } });
    // Frames are read in order: this answer comes after both strays were read.
    expect(await client(raw.session, (echo) => echo.Say("mini", { text: "fast" }))).toMatchObject({ said: "now" });
  });

  it("still closes the link when it names a request this end waits for, on another operation", async () => {
    const raw = facingRaw({ status: asker() }, (frame) => frame.type === "request"
      ? { type: "response", id: frame.id, op: "op-other", channel: frame.channel, ok: true, payload: { said: "x", at: "1970-01-01T00:00:00.000Z" } } : undefined);
    const refused = await client(raw.session, (echo) => Effect.flip(echo.Say("mini", { text: "hi" }, { operationId: "op-mine" })));
    expect(refused).toMatchObject({ _tag: "LinkClosed", reason: "frame-invalid" });
    expect((await raw.session.closed).message).toContain("does not match a pending request");
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
