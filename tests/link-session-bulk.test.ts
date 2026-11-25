import { PassThrough } from "node:stream";
import { Effect, Schema } from "effect";
import { afterEach, expect, it } from "vitest";
import { makeLinkSession, type LinkSessionOptions } from "../src/core/link/session";
import { LinkHelloSchema, decodeLinkFrame } from "../src/core/link/protocol";
import type { LinkChannelHandler, LinkHello, LinkSession } from "../src/core/link/types";
import { FILE_BYTES_FRAME_MAX } from "../src/shared/files-bytes-link";

/**
 * The link's bulk lane (0.12.1, X3, remote-security terms 1 and 2): a
 * `file-bytes` frame has a bound of its own, a third byte request in flight is
 * refused with the link kept, and a bulk frame waits behind every other frame.
 */

const sessions: LinkSession[] = [];
afterEach(async () => { await Promise.all(sessions.splice(0).map((session) => session.close())); });
const hello = (name: string): LinkHello => Schema.decodeUnknownSync(LinkHelloSchema)({ build: "a".repeat(64), installationId: `${name}-install`, machineName: name });
const Payload = Schema.Struct({ value: Schema.String });
const decode = Schema.decodeUnknownSync(Payload, { onExcessProperty: "error" });
const channel = (handleRequest: LinkChannelHandler["handleRequest"] = (_context, payload) => Effect.succeed(payload)): LinkChannelHandler =>
  ({ decodeRequest: decode, decodeResponse: decode, decodeEvent: decode, handleRequest, handleEvent: () => Effect.void });
const raw = (options: Partial<LinkSessionOptions> = {}) => {
  const input = new PassThrough(); const output = new PassThrough();
  const frames: ReturnType<typeof decodeLinkFrame>[] = [];
  let pending = "";
  output.on("data", (bytes: Buffer) => {
    pending += bytes.toString();
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      frames.push(decodeLinkFrame(JSON.parse(pending.slice(0, newline))));
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
    }
  });
  const session = makeLinkSession({ readable: input, writable: output, self: hello("macbook"), admit: async () => {}, channels: { status: channel() }, run: Effect.runPromise, ...options });
  sessions.push(session);
  const send = (frame: unknown) => input.write(JSON.stringify(frame) + "\n");
  return { session, send, input, output, frames };
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

it("closes the link on a file-bytes frame over its own bound, before its channel sees it", async () => {
  let seen = 0;
  const f = raw({ channels: { status: channel(), "file-bytes": channel(() => Effect.sync(() => { seen += 1; return { value: "x" }; })) } });
  f.send({ type: "hello", ...hello("mini") }); await f.session.ready;
  // Under the link's 1 MiB frame bound, over the bulk channel's.
  f.send({ type: "request", id: "r1", op: "op-1", channel: "file-bytes", payload: { value: "x".repeat(FILE_BYTES_FRAME_MAX) } });
  const ended = await f.session.closed;
  expect(ended.reason).toBe("bound-exceeded");
  expect(seen).toBe(0);
});

it("keeps a status frame of the same size: the bulk bound is the bulk channel's alone", async () => {
  const f = raw();
  f.send({ type: "hello", ...hello("mini") }); await f.session.ready;
  f.send({ type: "request", id: "r1", op: "op-1", channel: "status", payload: { value: "x".repeat(FILE_BYTES_FRAME_MAX) } });
  await settle();
  const answered = f.frames.find((frame) => frame.type === "response" && frame.id === "r1");
  expect(answered).toMatchObject({ ok: true });
});

it("refuses a third byte request while two are unanswered, and keeps the link", async () => {
  const f = raw({ channels: { status: channel(), "file-bytes": channel(() => Effect.never) } });
  f.send({ type: "hello", ...hello("mini") }); await f.session.ready;
  for (const id of ["b1", "b2", "b3"]) f.send({ type: "request", id, op: `op-${id}`, channel: "file-bytes", payload: { value: id } });
  await settle();
  const third = f.frames.find((frame) => frame.type === "response" && frame.id === "b3");
  expect(third).toMatchObject({ ok: false });
  expect(f.frames.some((frame) => frame.type === "response" && (frame.id === "b1" || frame.id === "b2"))).toBe(false);
  // The link is up: another channel still answers.
  f.send({ type: "request", id: "s1", op: "op-s1", channel: "status", payload: { value: "still" } });
  await settle();
  expect(f.frames.find((frame) => frame.type === "response" && frame.id === "s1")).toMatchObject({ ok: true, payload: { value: "still" } });
});

it("writes a bulk frame only when no other frame waits", async () => {
  const f = raw({ channels: { status: channel(), "file-bytes": channel() } });
  f.send({ type: "hello", ...hello("mini") }); await f.session.ready;
  const before = f.frames.length;
  const sends = [
    f.session.sendEvent("status", { value: "first" }),
    f.session.sendEvent("file-bytes", { value: "bulk" }),
    f.session.sendEvent("status", { value: "second" }),
  ];
  await Promise.all(sends);
  await settle();
  const order = f.frames.slice(before).flatMap((frame) => (frame.type === "event" ? [(frame.payload as { value: string }).value] : []));
  expect(order).toEqual(["first", "second", "bulk"]);
});
