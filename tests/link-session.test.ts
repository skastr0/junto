import { PassThrough } from "node:stream";
import { Effect, Schema } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { LinkBuildMismatch, makeLinkSession, type LinkSessionOptions } from "../src/main/junto/link/session";
import { LinkHelloSchema, decodeLinkFrame } from "../src/main/junto/link/protocol";
import { MachineLinkError, type LinkChannelHandler, type LinkHello, type LinkSession } from "../src/main/junto/link/types";

const sessions: LinkSession[] = [];
afterEach(async () => { await Promise.all(sessions.splice(0).map(session => session.close())); vi.useRealTimers(); });
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
  const refused = pair({ admit: async () => { throw new MachineLinkError("installation pin changed"); } });
  await expect(refused.left.ready).rejects.toThrow("installation pin changed");
});

it("checks the binding before reporting a build mismatch and never opens a channel", async () => {
  const admit = vi.fn(async () => {});
  const opened = vi.fn(() => Effect.void);
  const f = raw({ admit, channels: { status: { ...channel(), opened } } });
  const peer = hello("mini", "b".repeat(64));
  f.send({ type: "hello", ...peer });
  await expect(f.session.ready).rejects.toBeInstanceOf(LinkBuildMismatch);
  expect(admit).toHaveBeenCalledWith(peer);
  expect(opened).not.toHaveBeenCalled();
  const refused = raw({ admit: async () => { throw new MachineLinkError("installation pin changed"); } });
  refused.send({ type: "hello", ...peer });
  await expect(refused.session.ready).rejects.toThrow("installation pin changed");
});

it("closes on excess channel payload fields before a handler sees them", async () => {
  let called = false;
  const f = raw({ channels: { status: channel(() => Effect.sync(() => { called = true; return { value: "bad" }; })) } });
  f.send({ type: "hello", ...hello("mini") }); await f.session.ready;
  f.send({ type: "request", id: "bad", channel: "status", payload: { value: "ok", exec: "shell" } });
  await f.session.closed;
  expect(called).toBe(false);
});

it("rechecks admission before events and aborts the channel context on close", async () => {
  let admitted = true;
  let signal: AbortSignal | undefined;
  let resolveOpened!: () => void;
  const opened = new Promise<void>(resolve => { resolveOpened = resolve; });
  let events = 0;
  const f = raw({ admit: async () => { if (!admitted) throw new MachineLinkError("peer was removed"); }, channels: { status: { ...channel(), opened: context => Effect.sync(() => { signal = context.signal; resolveOpened(); }), handleEvent: () => Effect.sync(() => { events++; }) } } });
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
  f.send({ type: "response", id: request.id, channel: "status", ok: true, payload: { value: "reply", juntoHome: "/private" } });
  await expect(pending).rejects.toThrow();
  await f.session.closed;
});

it("closes on request timeout and rejects pending work without automatic replay", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  let calls = 0;
  let started!: () => void;
  const handling = new Promise<void>(resolve => { started = resolve; });
  let cleaned!: () => void;
  const cleanup = new Promise<void>(resolve => { cleaned = resolve; });
  const { left } = pair({ limits: { requestTimeoutMs: 20 } }, { channels: { status: channel(() => { calls++; started(); return Effect.never.pipe(Effect.ensuring(Effect.sync(cleaned))); }) } });
  await left.ready;
  const failed = expect(left.request("status", { value: "one" })).rejects.toThrow("outcome is uncertain");
  await handling;
  await vi.advanceTimersByTimeAsync(20);
  await failed;
  expect(calls).toBe(1);
  await cleanup;
});

it("bounds incoming queued calls while keeping response handling independent", async () => {
  const f = raw({ limits: { inboundCalls: 1 }, channels: { status: channel(() => Effect.never) } });
  f.send({ type: "hello", ...hello("mini") }); await f.session.ready;
  f.send({ type: "request", id: "one", channel: "status", payload: { value: "one" } });
  f.send({ type: "request", id: "two", channel: "status", payload: { value: "two" } });
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
  f.send({ type: "response", id: request.id, channel: "rows", ok: true, payload: { value: "wrong" } });
  await expect(response).rejects.toThrow("does not match");
  const g = raw(); g.send({ type: "hello", ...hello("mini") }); await g.session.ready;
  g.send({ type: "hello", ...hello("mini") }); await g.session.closed;
  await expect(g.session.request("status", { value: "later" })).rejects.toThrow("cannot be repeated");
});

it("rejects an envelope's unknown fields, channels and absent payload", () => {
  for (const frame of [
    { type: "hello", ...hello("mini"), command: "shell" },
    { type: "request", id: "one", channel: "shell", payload: {} },
    { type: "request", id: "one", channel: "status" },
  ]) expect(() => decodeLinkFrame(frame)).toThrow();
});
