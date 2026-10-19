/**
 * A seat's need crosses the seats channel in the urgency module's own types,
 * with no older vocabulary beside them. That holds only because both ends run
 * one build: the seats channel opens after a hello from the same build, and no
 * seats frame is read before it.
 */
import { PassThrough } from "node:stream";
import { Effect, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LinkBuildMismatch, makeLinkSession } from "../src/main/junto/link/session";
import { decodeLinkFrame, LinkHelloSchema } from "../src/main/junto/link/protocol";
import type { LinkChannelHandler, LinkHello, LinkSession } from "../src/main/junto/link/types";
import { decodeSeatsStatus, toSeatsStatus } from "../src/main/junto/term/seats-status";
import { initialSnapshot, topNeed, type BindingId } from "../src/shared/harness-domain";
import { Level, rankOf } from "../src/shared/wire/urgency";

const sessions: LinkSession[] = [];
afterEach(async () => { await Promise.all(sessions.splice(0).map((session) => session.close())); });

const BUILD = "a".repeat(64);
const hello = (name: string, build = BUILD): LinkHello =>
  Schema.decodeUnknownSync(LinkHelloSchema)({ build, installationId: `${name}-install`, machineName: name });

const AT = 1_792_000_000_000;
const status = () => {
  const snapshot = initialSnapshot("mini-binding" as BindingId, AT);
  return toSeatsStatus({ snapshot, need: topNeed(snapshot) }, AT + 1_000)!;
};

const seats = () => {
  const decoded: unknown[] = [];
  const decodeEvent = vi.fn((payload: unknown) => {
    const wire = decodeSeatsStatus(payload);
    decoded.push(wire);
    return wire;
  });
  const opened = vi.fn(() => Effect.void);
  const handler: LinkChannelHandler = {
    decodeRequest: (payload) => payload,
    decodeResponse: (payload) => payload,
    decodeEvent,
    handleEvent: () => Effect.void,
    opened,
  };
  return { handler, decodeEvent, opened, decoded };
};

const raw = (handler: LinkChannelHandler) => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.on("data", (bytes) => { decodeLinkFrame(JSON.parse(bytes.toString())); });
  const session = makeLinkSession({
    readable: input, writable: output, self: hello("macbook"), admit: async () => {}, channels: { seats: handler }, run: Effect.runPromise,
  });
  sessions.push(session);
  return { session, send: (frame: unknown) => input.write(`${JSON.stringify(frame)}\n`) };
};

describe("seats channel: opens only after a hello from the same build", () => {
  it("refuses a seats frame before hello and never reads it", async () => {
    const f = seats();
    const link = raw(f.handler);
    link.send({ type: "event", channel: "seats", payload: status() });
    await expect(link.session.ready).rejects.toThrow("hello must be first");
    expect(f.decodeEvent).not.toHaveBeenCalled();
    expect(f.opened).not.toHaveBeenCalled();
  });

  it("never opens for a peer on another build, and reads nothing it sends", async () => {
    const f = seats();
    const link = raw(f.handler);
    link.send({ type: "hello", ...hello("mini", "b".repeat(64)) });
    link.send({ type: "event", channel: "seats", payload: status() });
    await expect(link.session.ready).rejects.toBeInstanceOf(LinkBuildMismatch);
    await link.session.closed;
    expect(f.opened).not.toHaveBeenCalled();
    expect(f.decodeEvent).not.toHaveBeenCalled();
  });

  it("opens after a same-build hello, and the need decodes in the module's types", async () => {
    const f = seats();
    const link = raw(f.handler);
    link.send({ type: "hello", ...hello("mini") });
    await link.session.ready;
    await vi.waitFor(() => expect(f.opened).toHaveBeenCalledTimes(1));
    link.send({ type: "event", channel: "seats", payload: status() });
    await vi.waitFor(() => expect(f.decoded).toHaveLength(1));
    expect(f.decoded[0]).toMatchObject({ need: { cause: "starting", level: Level.working, urgency: rankOf(Level.working) } });
  });

  it("refuses a need in any other vocabulary", () => {
    const wire = status();
    expect(() => decodeSeatsStatus({ ...wire, need: { ...wire.need, level: "ready" } })).toThrow();
    expect(() => decodeSeatsStatus({ ...wire, need: { ...wire.need, urgency: 10 } })).toThrow();
  });
});
