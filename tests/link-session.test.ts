import { PassThrough } from "node:stream";
import { Effect, Schema } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { LinkBuildMismatch, makeLinkSession, type LinkSessionOptions } from "../src/main/junto/link/session";
import { LinkHelloSchema, decodeLinkFrame } from "../src/main/junto/link/protocol";
import { linkClosed, LinkPeerNotPinned, LinkRequestFailed, type LinkChannelContext, type LinkChannelHandler, type LinkHello, type LinkSession } from "../src/main/junto/link/types";

const sessions: LinkSession[] = [];
afterEach(async () => { await Promise.all(sessions.splice(0).map(session => session.close())); });
const hello = (name: string, build = "a".repeat(64)): LinkHello => Schema.decodeUnknownSync(LinkHelloSchema)({ build, installationId: name + "-install", machineName: name });
const Payload = Schema.Struct({ value: Schema.String });
const decode = Schema.decodeUnknownSync(Payload, { onExcessProperty: "error" });
const channel = (handleRequest: LinkChannelHandler["handleRequest"] = (_context, payload) => Effect.succeed(payload)): LinkChannelHandler => ({ decodeRequest: decode, decodeResponse: decode, decodeEvent: decode, handleRequest, handleEvent: () => Effect.void });
const pair = (a: Partial<LinkSessionOptions> = {}, b: Partial<LinkSessionOptions> = {}) => {
  const ab = new PassThrough(); const ba = new PassThrough();
  const left = makeLinkSession({ readable: ba, writable: ab, self: hello("macbook"), admit: async () => {}, channels: { status: channel() }, run: Effect.runPromise, ...a });
  const right = makeLinkSession({ readable: ab, writable: ba, self: hello("mini"), admit: async () => {}, channels: { status: channel() }, run: Effect.runPromise, ...b });
  sessions.push(left, right);
  return { left, right };
};
const raw = (options: Partial<LinkSessionOptions> = {}) => {
  const input = new PassThrough(); const output = new PassThrough();
  const frames: ReturnType<typeof decodeLinkFrame>[] = [];
  output.on("data", bytes => { frames.push(decodeLinkFrame(JSON.parse(bytes.toString()))); });
  const session = makeLinkSession({ readable: input, writable: output, self: hello("macbook"), admit: async () => {}, channels: { status: channel() }, run: Effect.runPromise, ...options });
  sessions.push(session);
  const send = (frame: unknown) => input.write(JSON.stringify(frame) + "\n");
  return { session, send, input, output, frames };
};

it("admits symmetric hellos and routes strictly decoded requests in both directions", async () => {
  let checks = 0;
  const { left, right } = pair({ admit: async peer => { expect(peer.machineName).toBe("mini"); checks++; } }, { admit: async peer => { expect(peer.machineName).toBe("macbook"); checks++; } });
  const peers = await Promise.all([left.ready, right.ready]);
  expect(peers.map(peer => peer.machineName)).toEqual(["mini", "macbook"]);
  expect(await Promise.all([left.request("status", { value: "left" }), right.request("status", { value: "right" })])).toEqual([{ value: "left" }, { value: "right" }]);
  expect(checks).toBeGreaterThan(2);
});

it("refuses build mismatch and pin refusal without dispatching a channel", async () => {
  let called = false;
  const { left, right } = pair({}, { self: hello("mini", "b".repeat(64)), channels: { status: channel(() => Effect.sync(() => { called = true; return { value: "bad" }; })) } });
  await expect(left.ready).rejects.toThrow("Update mini");
  await right.closed;
  expect(called).toBe(false);
  const refused = pair({ admit: async () => { throw new LinkPeerNotPinned({ machine: "mini", message: "installation pin changed" }); } });
  await expect(refused.left.ready).rejects.toThrow("installation pin changed");
});

it("checks the binding before reporting a build mismatch and never opens a channel", async () => {
  const admit = vi.fn(async () => {});
  const opened = vi.fn(() => Effect.void);
  const f = raw({ admit, channels: { status: { ...channel(), opened } } });
  const peer = hello("mini", "b".repeat(64));
  f.send({ type: "hello", ...peer });
  await expect(f.session.ready).rejects.toBeInstanceOf(LinkBuildMismatch);
  expect(admit).toHaveBeenCalledWith(peer, undefined);
  expect(opened).not.toHaveBeenCalled();
  const refused = raw({ admit: async () => { throw new LinkPeerNotPinned({ machine: "mini", message: "installation pin changed" }); } });
  refused.send({ type: "hello", ...peer });
  await expect(refused.session.ready).rejects.toThrow("installation pin changed");
});

it("closes on excess channel payload fields before a handler sees them", async () => {
  let called = false;
  const f = raw({ channels: { status: channel(() => Effect.sync(() => { called = true; return { value: "bad" }; })) } });
  f.send({ type: "hello", ...hello("mini") }); await f.session.ready;
  f.send({ type: "request", id: "bad", op: "op-bad", channel: "status", payload: { value: "ok", exec: "shell" } });
  await f.session.closed;
  expect(called).toBe(false);
});

it("rechecks admission before events and aborts the channel context on close", async () => {
  let admitted = true;
  let signal: AbortSignal | undefined;
  let resolveOpened!: () => void;
  const opened = new Promise<void>(resolve => { resolveOpened = resolve; });
  let events = 0;
  const f = raw({ admit: async () => { if (!admitted) throw new LinkPeerNotPinned({ machine: "mini", message: "peer was removed" }); }, channels: { status: { ...channel(), opened: context => Effect.sync(() => { signal = context.signal; resolveOpened(); }), handleEvent: () => Effect.sync(() => { events++; }) } } });
  f.send({ type: "hello", ...hello("mini") }); await f.session.ready; await opened;
  admitted = false;
  f.send({ type: "event", channel: "status", payload: { value: "after removal" } });
  await f.session.closed;
  expect(events).toBe(0); expect(signal?.aborted).toBe(true);
});

it("bounds partial input, rejects invalid UTF-8, and requires hello first", async () => {
  const f = raw({ limits: { frameBytes: 256 } });
  f.input.write(Buffer.alloc(257, 65));
  await expect(f.session.ready).rejects.toThrow("frame bound");
  const g = raw(); g.input.write(Buffer.from([0xff, 10]));
  await expect(g.session.ready).rejects.toThrow();
  const h = raw(); h.send({ type: "event", channel: "status", payload: { value: "early" } });
  await expect(h.session.ready).rejects.toThrow("hello must be first");
});

it("strictly decodes responses before resolving a pending request", async () => {
  const f = raw(); f.send({ type: "hello", ...hello("mini") }); await f.session.ready;
  const pending = f.session.request("status", { value: "request" });
  const observed = new Promise<void>(resolve => f.output.once("data", () => resolve()));
  await observed;
  const request = f.frames.find(frame => frame.type === "request");
  if (request?.type !== "request") throw new Error("request was not written");
  f.send({ type: "response", id: request.id, op: request.op, channel: "status", ok: true, payload: { value: "reply", juntoHome: "/private" } });
  await expect(pending).rejects.toThrow();
  await f.session.closed;
});

// Real time, a 20 ms bound: fake timers hang under bun test, which never advances them.
it("closes on request timeout and rejects pending work without automatic replay", async () => {
  let calls = 0;
  let started!: () => void;
  const handling = new Promise<void>(resolve => { started = resolve; });
  let cleaned!: () => void;
  const cleanup = new Promise<void>(resolve => { cleaned = resolve; });
  const { left } = pair({ limits: { requestTimeoutMs: 20 } }, { channels: { status: channel(() => { calls++; started(); return Effect.never.pipe(Effect.ensuring(Effect.sync(cleaned))); }) } });
  await left.ready;
  const failed = expect(left.request("status", { value: "one" })).rejects.toThrow("outcome is uncertain");
  await handling;
  await failed;
  expect(calls).toBe(1);
  await cleanup;
}, 5_000);

it("bounds incoming queued calls while keeping response handling independent", async () => {
  const f = raw({ limits: { inboundCalls: 1 }, channels: { status: channel(() => Effect.never) } });
  f.send({ type: "hello", ...hello("mini") }); await f.session.ready;
  f.send({ type: "request", id: "one", op: "op-one", channel: "status", payload: { value: "one" } });
  f.send({ type: "request", id: "two", op: "op-two", channel: "status", payload: { value: "two" } });
  await f.session.closed;
  await expect(f.session.request("status", { value: "later" })).rejects.toThrow("Too many incoming");
});

it("rejects a response on another channel and a repeated hello", async () => {
  const f = raw({ channels: { status: channel(), rows: channel() } });
  f.send({ type: "hello", ...hello("mini") }); await f.session.ready;
  const response = f.session.request("status", { value: "request" });
  await new Promise<void>(resolve => f.output.once("data", () => resolve()));
  const request = f.frames.find(frame => frame.type === "request");
  if (request?.type !== "request") throw new Error("request was not written");
  f.send({ type: "response", id: request.id, op: request.op, channel: "rows", ok: true, payload: { value: "wrong" } });
  await expect(response).rejects.toThrow("does not match");
  const g = raw(); g.send({ type: "hello", ...hello("mini") }); await g.session.ready;
  g.send({ type: "hello", ...hello("mini") }); await g.session.closed;
  await expect(g.session.request("status", { value: "later" })).rejects.toThrow("cannot be repeated");
});

it("rejects an envelope's unknown fields, channels and absent payload", () => {
  for (const frame of [
    { type: "hello", ...hello("mini"), command: "shell" },
    { type: "request", id: "one", op: "op", channel: "shell", payload: {} },
    { type: "request", id: "one", op: "op", channel: "status" },
    { type: "request", id: "one", channel: "status", payload: {} },
  ]) expect(() => decodeLinkFrame(frame)).toThrow();
});

it("names the files channel in a frame and closes on it while no handler is bound", async () => {
  expect(() => decodeLinkFrame({ type: "request", id: "one", op: "op", channel: "files", payload: {} })).not.toThrow();
  const f = raw();
  f.send({ type: "hello", ...hello("mini") }); await f.session.ready;
  f.send({ type: "request", id: "files-1", op: "op-files", channel: "files", payload: {} });
  await f.session.closed;
});

class SeatSpawnFailed extends Schema.TaggedError<SeatSpawnFailed>()("SeatSpawnFailed", { seatId: Schema.String, exitCode: Schema.Number, message: Schema.String }) {}

it("answers a failed request with its real cause, typed, never a generic phrase", async () => {
  const failing = channel(() => Effect.fail(new SeatSpawnFailed({ seatId: "agent-01M4G59ER01QPV3WBTEK3Z84TP", exitCode: 1, message: "native PTY backend is unavailable: Cannot find module 'node-pty'" })));
  const handler: LinkChannelHandler = { ...failing, failureSchema: SeatSpawnFailed };
  const { left } = pair({ channels: { status: handler } }, { channels: { status: handler } });
  await left.ready;
  const failure = await left.request("status", { value: "start" }, "op-seat-start").then(() => undefined, (cause: unknown) => cause);
  expect(failure).toBeInstanceOf(LinkRequestFailed);
  const failed = failure as LinkRequestFailed;
  expect(failed.message).toContain("Cannot find module 'node-pty'");
  expect(failed.message).not.toContain("Channel request failed");
  expect(failed.operationId).toBe("op-seat-start");
  expect(failed.failure).toMatchObject({ tag: "SeatSpawnFailed", machine: "mini", operationId: "op-seat-start" });
  expect(failed.detail).toBeInstanceOf(SeatSpawnFailed);
  expect((failed.detail as SeatSpawnFailed).exitCode).toBe(1);
});

it("carries an untyped handler failure's tag and cause chain, scrubbed", async () => {
  const thrown = new Error("spawn failed", { cause: new Error("ENOENT token=abcd1234") });
  const { left } = pair({}, { channels: { status: channel(() => Effect.fail(thrown)) } });
  await left.ready;
  const failed = await left.request("status", { value: "x" }).then(() => undefined, (cause: unknown) => cause) as LinkRequestFailed;
  expect(failed.failure.causes).toEqual([{ tag: "Error", message: "ENOENT token=[redacted]" }]);
  expect(failed.message).toBe("mini could not complete the status request: spawn failed: ENOENT token=[redacted]");
});

it("puts the operation id on every request frame and hands it to the handler", async () => {
  let resolveSeen!: (operationId: string | undefined) => void;
  const seen = new Promise<string | undefined>(resolve => { resolveSeen = resolve; });
  const f = raw({ channels: { status: channel((context, payload) => Effect.sync(() => { resolveSeen(context.operationId); return payload; })) } });
  f.send({ type: "hello", ...hello("mini") }); await f.session.ready;
  const pending = f.session.request("status", { value: "a" }, "op-mine");
  await new Promise<void>(resolve => f.output.once("data", () => resolve()));
  const request = f.frames.find(frame => frame.type === "request");
  expect(request).toMatchObject({ type: "request", op: "op-mine" });
  if (request?.type !== "request") throw new Error("request was not written");
  f.send({ type: "response", id: request.id, op: request.op, channel: "status", ok: true, payload: { value: "b" } });
  await expect(pending).resolves.toEqual({ value: "b" });
  f.send({ type: "request", id: "in-1", op: "op-theirs", channel: "status", payload: { value: "c" } });
  expect(await seen).toBe("op-theirs");
}, 5_000);

it("tells the other end who closed and why, and says it was the peer", async () => {
  const { left, right } = pair();
  await Promise.all([left.ready, right.ready]);
  class ExchangeClosed extends Schema.TaggedError<ExchangeClosed>()("ExchangeClosed", { message: Schema.String }) {}
  await left.close(new ExchangeClosed({ message: "only the machine that edits a canvas answers a signal" }));
  const mine = await left.closed;
  expect(mine).toMatchObject({ by: "this-end", reason: "closed", causes: [{ tag: "ExchangeClosed" }] });
  const theirs = await right.closed;
  expect(theirs).toMatchObject({ by: "peer", reason: "peer-closed", machine: "macbook", causes: [{ tag: "ExchangeClosed", message: "only the machine that edits a canvas answers a signal" }] });
  expect(theirs.message).toBe("The link to macbook closed, the other machine closed it: only the machine that edits a canvas answers a signal");
  await expect(right.request("status", { value: "late" })).rejects.toThrow("only the machine that edits a canvas");
});

it("keeps the process's exit and stderr tail on every later failure", async () => {
  const { left } = pair();
  await left.ready;
  const pending = left.request("status", { value: "slow" });
  await left.close(linkClosed({ machine: "mini", by: "process", reason: "process-exited", exitCode: 1, stderrTail: "junto link: core is not running" }));
  await expect(pending).rejects.toThrow("The link to mini closed, its SSH process ended: exit code 1: junto link: core is not running");
  const later = await left.request("status", { value: "later" }).then(() => undefined, (cause: unknown) => cause);
  expect(later).toMatchObject({ _tag: "LinkClosed", by: "process", exitCode: 1, stderrTail: "junto link: core is not running" });
});

it("drops a peer's detail on a channel without a failure schema", async () => {
  const f = raw(); f.send({ type: "hello", ...hello("mini") }); await f.session.ready;
  const pending = f.session.request("status", { value: "x" });
  await new Promise<void>(resolve => f.output.once("data", () => resolve()));
  const request = f.frames.find(frame => frame.type === "request");
  if (request?.type !== "request") throw new Error("request was not written");
  f.send({ type: "response", id: request.id, op: request.op, channel: "status", ok: false,
    failure: { tag: "X", message: "refused", machine: "mini", operationId: request.op, causes: [], detail: { anything: "goes" } } });
  const failed = await pending.then(() => undefined, (cause: unknown) => cause) as LinkRequestFailed;
  expect(failed.failure.detail).toBeUndefined();
  expect(failed.detail).toBeUndefined();
});

it("slows a burst of events instead of closing the link", async () => {
  const handled: string[] = [];
  let open!: () => void;
  const gate = new Promise<void>(resolve => { open = resolve; });
  const events: LinkChannelHandler = { ...channel(), handleEvent: (_context, payload) => Effect.promise(async () => {
    await gate; handled.push((payload as { value: string }).value);
  }) };
  const f = raw({ limits: { inboundEvents: 4 }, channels: { status: events } });
  f.send({ type: "hello", ...hello("mini") }); await f.session.ready;
  for (let index = 0; index < 40; index++) f.send({ type: "event", channel: "status", payload: { value: `e${index}` } });
  await new Promise(resolve => setTimeout(resolve, 20));
  let closed = false;
  void f.session.closed.then(() => { closed = true; });
  expect(handled).toEqual([]);
  open();
  await new Promise<void>(resolve => { const poll = () => handled.length === 40 ? resolve() : setTimeout(poll, 2); poll(); });
  expect(handled[39]).toBe("e39");
  expect(closed).toBe(false);
}, 5_000);

it("pauses on held event bytes too, and refuses a request from an event handler", async () => {
  const handled: string[] = [];
  let refused: unknown;
  let open!: () => void;
  const gate = new Promise<void>(resolve => { open = resolve; });
  const events: LinkChannelHandler = { ...channel(), handleEvent: (context, payload) => Effect.gen(function* () {
    // A cast cannot bring the request back.
    refused = yield* Effect.flip((context as unknown as LinkChannelContext).request("status", { value: "x" }));
    yield* Effect.promise(() => gate);
    handled.push((payload as { value: string }).value);
  }) };
  const f = raw({ limits: { inboundEvents: 64, inboundEventBytes: 2048 }, channels: { status: events } });
  f.send({ type: "hello", ...hello("mini") }); await f.session.ready;
  // One chunk per frame, so a paused reader leaves the rest unread in the stream.
  for (let index = 0; index < 30; index++) {
    f.send({ type: "event", channel: "status", payload: { value: `${index}`.padStart(200, "x") } });
    await new Promise(resolve => setImmediate(resolve));
  }
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(refused).toMatchObject({ _tag: "LinkUnavailable", reason: "request-from-event" });
  expect(f.frames.some(frame => frame.type === "request")).toBe(false);
  // 2 KiB of held events stopped the reader: the rest is still unread in the stream.
  expect(f.input.readableLength).toBeGreaterThan(0);
  open();
  await new Promise<void>(resolve => { const poll = () => handled.length === 30 ? resolve() : setTimeout(poll, 2); poll(); });
  let closed = false;
  void f.session.closed.then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(closed).toBe(false);
}, 5_000);

it("refuses a request from a channel's opened hook too", async () => {
  let refused: unknown;
  const hooked: LinkChannelHandler = { ...channel(), opened: (context) => Effect.flip((context as unknown as LinkChannelContext).request("status", { value: "x" })).pipe(Effect.map(error => { refused = error; })) };
  const f = raw({ channels: { status: hooked } });
  f.send({ type: "hello", ...hello("mini") }); await f.session.ready;
  await new Promise<void>(resolve => { const poll = () => refused !== undefined ? resolve() : setTimeout(poll, 2); poll(); });
  expect(refused).toMatchObject({ _tag: "LinkUnavailable", reason: "request-from-event" });
  expect(f.frames.some(frame => frame.type === "request")).toBe(false);
}, 5_000);

class SettingRefused extends Schema.TaggedError<SettingRefused>()("SettingRefused", { operationId: Schema.String.pipe(Schema.check(Schema.isPattern(/^[A-Za-z0-9._-]+$/))), message: Schema.String }) {}

it("carries a typed refusal whose detail holds a UUID operation id, and drops a detail its schema refuses with the link open", async () => {
  const operationId = "818e529c-3b4d-4e5f-8a7b-1c2d3e4f5a6b";
  const refusing: LinkChannelHandler = { ...channel(() => Effect.fail(new SettingRefused({ operationId, message: "effortLevel is not verified" }))), failureSchema: SettingRefused };
  const { left } = pair({ channels: { status: refusing } }, { channels: { status: refusing } });
  await left.ready;
  const failed = await left.request("status", { value: "x" }, operationId).then(() => undefined, (cause: unknown) => cause) as LinkRequestFailed;
  expect(failed.detail).toBeInstanceOf(SettingRefused);
  expect((failed.detail as SettingRefused).operationId).toBe(operationId);

  const f = raw({ channels: { status: refusing } });
  f.send({ type: "hello", ...hello("mini") }); await f.session.ready;
  const pending = f.session.request("status", { value: "a" }, "op-bad").then(() => undefined, (cause: unknown) => cause);
  await new Promise<void>(resolve => f.output.once("data", () => resolve()));
  const request = f.frames.find(frame => frame.type === "request");
  if (request?.type !== "request") throw new Error("request was not written");
  f.send({ type: "response", id: request.id, op: request.op, channel: "status", ok: false,
    failure: { tag: "SettingRefused", message: "refused", machine: "mini", causes: [], detail: { _tag: "SettingRefused", operationId: "[redacted]", message: "refused" } } });
  const refused = await pending as LinkRequestFailed;
  expect(refused).toBeInstanceOf(LinkRequestFailed);
  expect(refused.detail).toBeUndefined();
  let closed = false;
  void f.session.closed.then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(closed).toBe(false);
}, 5_000);

const until = (ready: () => boolean): Promise<void> => new Promise(resolve => { const poll = () => ready() ? resolve() : setTimeout(poll, 2); poll(); });
const lineBytes = (frame: unknown): number => Buffer.byteLength(JSON.stringify(frame)) + 1;
const held = (handled: string[]): { handler: LinkChannelHandler; open: () => void } => {
  let open!: () => void;
  const gate = new Promise<void>(resolve => { open = resolve; });
  return { open, handler: { ...channel(), handleEvent: (_context, payload) => Effect.promise(async () => { await gate; handled.push((payload as { value: string }).value); }) } };
};

it("sends the largest frame into an empty window and holds the next until the peer credits it", async () => {
  const handled: string[] = [];
  const rows = held(handled);
  const limits = { frameBytes: 256, eventWindow: 257 };
  const { left, right } = pair({ limits, channels: { status: channel(), rows: channel() } }, { limits, channels: { status: channel(), rows: rows.handler } });
  await Promise.all([left.ready, right.ready]);
  // The value fills the frame to its bound exactly: 256 bytes plus the newline is the whole window.
  const largest = { value: "x".repeat(256 - lineBytes({ type: "event", channel: "rows", payload: { value: "" } }) + 1) };
  expect(lineBytes({ type: "event", channel: "rows", payload: largest })).toBe(257);
  await left.sendEvent("rows", largest);
  let second = false;
  const next = left.sendEvent("rows", { value: "second" }).then(() => { second = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(second).toBe(false);
  rows.open();
  await next;
  await until(() => handled.length === 2);
  expect(handled[1]).toBe("second");
}, 5_000);

it("answers a request while the rows window is full and uncredited", async () => {
  const handled: string[] = [];
  const rows = held(handled);
  const limits = { frameBytes: 256, eventWindow: 300 };
  const { left, right } = pair({ limits, channels: { status: channel(), rows: channel() } }, { limits, channels: { status: channel(), rows: rows.handler } });
  await Promise.all([left.ready, right.ready]);
  const sends = Array.from({ length: 20 }, (_, index) => left.sendEvent("rows", { value: `r${index}`.padEnd(100, "x") }));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(await left.request("status", { value: "through" })).toEqual({ value: "through" });
  rows.open();
  await Promise.all(sends);
  await until(() => handled.length === 20);
}, 5_000);

it("refuses credit for a channel without a window, before hello, and for more bytes than were sent", async () => {
  for (const [frame, problem] of [
    [{ type: "credit", channel: "status", bytes: 10 }, "credit-unwindowed"],
    [{ type: "credit", channel: "rows", bytes: 10 }, "credit-excess"],
  ] as const) {
    const f = raw({ channels: { status: channel(), rows: channel() } });
    f.send({ type: "hello", ...hello("mini") }); await f.session.ready;
    f.send(frame);
    const ended = await f.session.closed;
    expect(ended.reason).toBe("frame-invalid");
    expect(ended.causes[0]?.tag).toBe("LinkFrameInvalid");
    expect(ended.message).toMatch(problem === "credit-unwindowed" ? /has no window/ : /exceeds the bytes sent/);
  }
  const early = raw({ channels: { rows: channel() } });
  early.send({ type: "credit", channel: "rows", bytes: 10 });
  await expect(early.session.ready).rejects.toThrow("Link hello must be first");
  // Credit for bytes that were sent, then one byte more than what is left.
  const f = raw({ channels: { status: channel(), rows: channel() } });
  f.send({ type: "hello", ...hello("mini") }); await f.session.ready;
  await f.session.sendEvent("rows", { value: "a" });
  const sent = lineBytes({ type: "event", channel: "rows", payload: { value: "a" } });
  f.send({ type: "credit", channel: "rows", bytes: sent });
  await f.session.sendEvent("rows", { value: "b" });
  f.send({ type: "credit", channel: "rows", bytes: sent + 1 });
  expect((await f.session.closed).message).toMatch(/exceeds the bytes sent/);
}, 5_000);

it("closes a peer that sends rows past the window, holding no more than one window", async () => {
  const handled: string[] = [];
  const rows = held(handled);
  const f = raw({ limits: { frameBytes: 256, eventWindow: 300 }, channels: { status: channel(), rows: rows.handler } });
  f.send({ type: "hello", ...hello("mini") }); await f.session.ready;
  const event = { type: "event", channel: "rows", payload: { value: "x".repeat(100) } };
  f.send(event); f.send(event);
  await new Promise(resolve => setTimeout(resolve, 10));
  let closed = false;
  void f.session.closed.then(() => { closed = true; });
  expect(closed).toBe(false);
  f.send(event);
  const ended = await f.session.closed;
  expect(ended.reason).toBe("bound-exceeded");
  expect(ended.message).toMatch(/exceeds its window/);
  rows.open();
}, 5_000);

it("closes a link whose peer keeps rows uncredited past the request timeout", async () => {
  const f = raw({ limits: { requestTimeoutMs: 50 }, channels: { status: channel(), rows: channel() } });
  f.send({ type: "hello", ...hello("mini") }); await f.session.ready;
  await f.session.sendEvent("rows", { value: "never credited" });
  const ended = await f.session.closed;
  expect(ended.reason).toBe("credit-timeout");
  expect(ended.message).toMatch(/stopped taking events/);
}, 5_000);

it("refuses a send from an event handler that would wait for credit, and bounds the sends waiting", async () => {
  let refused: unknown;
  const f = raw({ limits: { frameBytes: 256, eventWindow: 300, queuedBytes: 400 }, channels: {
    rows: channel(),
    status: { ...channel(), handleEvent: (context) => Effect.flip(context.sendEvent("rows", { value: "from a handler" })).pipe(Effect.map(error => { refused = error; })) },
  } });
  f.send({ type: "hello", ...hello("mini") }); await f.session.ready;
  // 251 bytes out, so the handler's 70 would pass the 300-byte window.
  await f.session.sendEvent("rows", { value: "x".repeat(195) });
  f.send({ type: "event", channel: "status", payload: { value: "go" } });
  await until(() => refused !== undefined);
  expect(refused).toMatchObject({ _tag: "LinkUnavailable", reason: "send-from-event" });
  expect(f.frames.filter(frame => frame.type === "event")).toHaveLength(1);
  // 206 and 156 bytes wait within the 400-byte bound; 60 more do not.
  const waiting = [f.session.sendEvent("rows", { value: "y".repeat(150) }), f.session.sendEvent("rows", { value: "z".repeat(100) })];
  await expect(f.session.sendEvent("rows", { value: "over" })).rejects.toMatchObject({ _tag: "LinkUnavailable", reason: "send-queue-full" });
  await f.session.close();
  await Promise.allSettled(waiting);
}, 5_000);

it("counts the same bytes at both ends over many multibyte frames, so the window returns to empty", async () => {
  const f = raw({ limits: { frameBytes: 256, eventWindow: 300 }, channels: { status: channel(), rows: channel() } });
  f.send({ type: "hello", ...hello("mini") }); await f.session.ready;
  const credited = (): number => f.frames.filter(frame => frame.type === "credit").reduce((sum, frame) => sum + (frame as { bytes: number }).bytes, 0);
  let sent = 0;
  for (let index = 0; index < 200; index++) {
    const frame = { type: "event", channel: "rows", payload: { value: `${index} ção 😀 日本 ${"é".repeat(index % 40)}` } };
    // An honest peer: never more than the window out without credit.
    await until(() => sent - credited() + lineBytes(frame) <= 300);
    sent += lineBytes(frame);
    f.send(frame);
  }
  await until(() => credited() === sent);
  // And this end's own sends are credited back to exactly zero: a full window goes out at once.
  let credit = 0;
  for (let index = 0; index < 50; index++) {
    const payload = { value: `${index} ção 😀 ${"日".repeat(index % 30)}` };
    await f.session.sendEvent("rows", payload);
    const bytes = lineBytes({ type: "event", channel: "rows", payload });
    f.send({ type: "credit", channel: "rows", bytes });
    credit += bytes;
  }
  await new Promise(resolve => setTimeout(resolve, 10));
  const largest = { value: "x".repeat(256 - lineBytes({ type: "event", channel: "rows", payload: { value: "" } }) + 1) };
  await f.session.sendEvent("rows", largest);
  expect(credit).toBeGreaterThan(0);
  let closed = false;
  void f.session.closed.then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(closed).toBe(false);
}, 5_000);

it("keeps a rows channel's opened hook out of its window, so no empty credit goes out", async () => {
  let opened = false;
  const f = raw({ channels: { status: channel(), rows: { ...channel(), opened: () => Effect.sync(() => { opened = true; }) } } });
  f.send({ type: "hello", ...hello("mini") }); await f.session.ready;
  await until(() => opened);
  f.send({ type: "event", channel: "rows", payload: { value: "a" } });
  await until(() => f.frames.some(frame => frame.type === "credit"));
  expect(f.frames.filter(frame => frame.type === "credit")).toEqual([{ type: "credit", channel: "rows", bytes: lineBytes({ type: "event", channel: "rows", payload: { value: "a" } }) }]);
  let closed = false;
  void f.session.closed.then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 5));
  expect(closed).toBe(false);
}, 5_000);

it("lets a fiber an opened hook leaves behind wait for credit, while the hook itself is refused", async () => {
  let send!: (value: string) => Promise<unknown>;
  let refusedInHook: unknown;
  const rows: LinkChannelHandler = { ...channel(), opened: (context) => Effect.gen(function* () {
    send = value => Effect.runPromise(context.sendEvent("rows", { value }).pipe(Effect.as("sent"), Effect.catch(error => Effect.succeed(error))));
    // Fills the window from inside the hook, then one more would wait: refused here.
    yield* context.sendEvent("rows", { value: "x".repeat(195) });
    refusedInHook = yield* Effect.flip(context.sendEvent("rows", { value: "y".repeat(100) }));
  }) };
  const f = raw({ limits: { frameBytes: 256, eventWindow: 300 }, channels: { status: channel(), rows } });
  f.send({ type: "hello", ...hello("mini") }); await f.session.ready;
  await until(() => refusedInHook !== undefined);
  expect(refusedInHook).toMatchObject({ _tag: "LinkUnavailable", reason: "send-from-event" });
  // After the hook returned, the same context waits for credit instead.
  const later = send("z".repeat(100));
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(f.frames.filter(frame => frame.type === "event")).toHaveLength(1);
  f.send({ type: "credit", channel: "rows", bytes: lineBytes({ type: "event", channel: "rows", payload: { value: "x".repeat(195) } }) });
  expect(await later).toBe("sent");
  expect(f.frames.filter(frame => frame.type === "event")).toHaveLength(2);
}, 5_000);
