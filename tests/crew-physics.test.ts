import { Effect, Result, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { Wire, decodeWire, wireGrant, wireKinds, type Canvas } from "../src/shared/model";
import { admitPure, asNodeId, type Port } from "../src/shared/physics";
import { canvasToCapabilityView } from "../src/shared/physics/view";
import { THIS_MACHINE } from "./support/machines";
import { canvasOf, seat, wire } from "./support/model-nodes";

// What a messages wire between two seats lets each do to the other, and that
// a mask can only take from it.

const seats = [seat("author"), seat("reviewer")];

const messages = (mask?: readonly Port[]): Wire => ({
  ...wire("messages", "reviewer", "author", "messages"),
  ...(mask === undefined ? {} : { mask: [...mask] }),
});

const canvasWith = (wires: readonly Wire[]): Canvas => canvasOf(seats, wires);

const allows = (canvas: Canvas, from: string, to: string, port: Port): boolean =>
  Result.isSuccess(admitPure(canvasToCapabilityView(canvas, { editingMachine: THIS_MACHINE }), asNodeId(from), asNodeId(to), port));

/** Whether a wire read from outside the process is taken. */
const decodes = (input: unknown): boolean =>
  Result.isSuccess(Effect.runSync(Effect.result(decodeWire(input))));

describe("crew wire authority", () => {
  it("defaults peer observation and immediate prompt to the messages relationship", () => {
    const canvas = canvasWith([messages()]);
    for (const port of ["msg.list", "msg.send", "msg.prompt", "seat.wait", "terminal.read"] as const) {
      expect(allows(canvas, "author", "reviewer", port), port).toBe(true);
      expect(allows(canvas, "reviewer", "author", port), port).toBe(true);
    }
    expect(allows(canvas, "reviewer", "author", "verdict.post")).toBe(false);
  });

  it("attenuates prompt independently, and an empty mask grants nothing", () => {
    const canvas = canvasWith([messages(["msg.send", "terminal.read"])]);
    expect(allows(canvas, "author", "reviewer", "msg.send")).toBe(true);
    expect(allows(canvas, "author", "reviewer", "terminal.read")).toBe(true);
    expect(allows(canvas, "author", "reviewer", "msg.prompt")).toBe(false);
    // An empty mask is kept as written: it is not read as no mask at all.
    const empty = messages([]);
    expect(Schema.decodeUnknownSync(Wire)(empty).mask).toEqual([]);
    expect(allows(canvasWith([empty]), "author", "reviewer", "msg.send")).toBe(false);
  });

  it("cannot manufacture review, task update, input or signal power in a mask", () => {
    const masked = messages(["verdict.post", "tasks.update", "terminal.read"]);
    expect(wireGrant(masked, wireKinds(seats))?.ports).toEqual(["terminal.read"]);
    expect(allows(canvasWith([masked]), "reviewer", "author", "verdict.post")).toBe(false);
    for (const invalid of ["terminal.write", "terminal.resize", "terminal.signal"]) {
      expect(decodes({ ...messages(), mask: [invalid] }), invalid).toBe(false);
    }
  });

  it("does not turn malformed attenuation into unmasked authority", () => {
    for (const mask of [null, "msg.send", ["unknown.port"], [123]]) {
      expect(decodes({ ...messages(), mask }), JSON.stringify(mask)).toBe(false);
    }
  });

  it("does not take a wire whose verb is not one", () => {
    for (const verb of [undefined, null, "reviewz", 123]) {
      expect(decodes({ ...messages(), verb }), String(verb)).toBe(false);
    }
  });
});
