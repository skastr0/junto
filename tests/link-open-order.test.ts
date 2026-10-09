import { PassThrough } from "node:stream";
import { Effect, Schema } from "effect";
import { expect, it } from "vitest";
import { makeLinkSession } from "../src/main/junto/link/session";
import { LinkHelloSchema } from "../src/main/junto/link/protocol";
import type { LinkChannelHandler } from "../src/main/junto/link/types";

it("finishes the channel open hook before handling its events in arrival order", async () => {
  const ab = new PassThrough();
  const ba = new PassThrough();
  const hello = (name: string) => Schema.decodeUnknownSync(LinkHelloSchema)({
    machineName: name, installationId: name + "-install", build: "a".repeat(64),
  });
  const decode = Schema.decodeUnknownSync(Schema.Struct({ value: Schema.String }), { onExcessProperty: "error" });
  const status: LinkChannelHandler = { decodeRequest: decode, decodeResponse: decode, decodeEvent: decode,
    handleRequest: (_context, payload) => Effect.succeed(payload) };
  let release!: () => void;
  let started!: () => void;
  let finished!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const opening = new Promise<void>(resolve => { started = resolve; });
  const handled = new Promise<void>(resolve => { finished = resolve; });
  const order: string[] = [];
  const rows: LinkChannelHandler = { decodeRequest: decode, decodeResponse: decode, decodeEvent: decode,
    opened: () => Effect.promise(async () => { started(); await gate; order.push("opened"); }),
    handleEvent: (_context, payload) => Effect.sync(() => {
      order.push(decode(payload).value);
      if (order.length === 3) finished();
    }),
  };
  const left = makeLinkSession({ readable: ba, writable: ab, self: hello("book"), admit: async () => {},
    channels: { rows, status }, run: Effect.runPromise });
  const right = makeLinkSession({ readable: ab, writable: ba, self: hello("mini"), admit: async () => {},
    channels: { rows: { ...rows, opened: undefined, handleEvent: () => Effect.void }, status }, run: Effect.runPromise });
  try {
    await Promise.all([left.ready, right.ready, opening]);
    await right.sendEvent("rows", { value: "first" });
    await right.sendEvent("rows", { value: "second" });
    // This response proves the reader passed both earlier rows frames while
    // the rows channel's open hook was still waiting on our injected gate.
    expect(await right.request("status", { value: "read-through" })).toEqual({ value: "read-through" });
    expect(order).toEqual([]);
    release();
    await handled;
    expect(order).toEqual(["opened", "first", "second"]);
  } finally {
    release();
    await Promise.all([left.close(), right.close()]);
  }
});
