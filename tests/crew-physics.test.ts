import { Result } from "effect";
import { describe, expect, it } from "vitest";
import { decodeCanvasDoc, edgeGrant, type CanvasDoc, type CanvasEdge } from "../src/shared/canvas";
import { admitPure, asNodeId, canvasDocToCapabilityView, type Port } from "../src/shared/physics";

const docWith = (edges: readonly CanvasEdge[]): CanvasDoc => ({
  nodes: ["author", "reviewer"].map((id) => ({
    id, type: "text" as const, text: id, x: 0, y: 0, width: 200, height: 100,
    ether: { entity: { kind: "agent", name: id } },
  })),
  edges,
});

const edge = (verb: "messages", mask?: readonly Port[]): CanvasEdge => ({
  id: verb, fromNode: "reviewer", toNode: "author",
  ether: { verb, ...(mask === undefined ? {} : { mask }) },
});

const allows = (doc: CanvasDoc, from: string, to: string, port: Port): boolean =>
  Result.isSuccess(admitPure(canvasDocToCapabilityView(doc), asNodeId(from), asNodeId(to), port));

describe("crew edge authority", () => {
  it("defaults peer observation and immediate prompt to the messages relationship", () => {
    const doc = docWith([edge("messages")]);
    for (const port of ["msg.list", "msg.send", "msg.prompt", "seat.wait", "terminal.read"] as const) {
      expect(allows(doc, "author", "reviewer", port), port).toBe(true);
      expect(allows(doc, "reviewer", "author", port), port).toBe(true);
    }
    expect(allows(doc, "reviewer", "author", "verdict.post")).toBe(false);
  });

  it("attenuates prompt independently and preserves an empty mask through decode", () => {
    const doc = docWith([edge("messages", ["msg.send", "terminal.read"])]);
    expect(allows(doc, "author", "reviewer", "msg.send")).toBe(true);
    expect(allows(doc, "author", "reviewer", "terminal.read")).toBe(true);
    expect(allows(doc, "author", "reviewer", "msg.prompt")).toBe(false);
    const decoded = decodeCanvasDoc(docWith([edge("messages", [])]));
    expect(Result.isSuccess(decoded)).toBe(true);
    if (Result.isFailure(decoded)) throw decoded.failure;
    expect(decoded.success.edges[0]?.ether?.mask).toEqual([]);
    expect(allows(decoded.success, "author", "reviewer", "msg.send")).toBe(false);
  });

  it("cannot manufacture review, task update, input or signal power in a mask", () => {
    const doc = docWith([edge("messages", ["verdict.post", "tasks.update", "terminal.read"])]);
    expect(edgeGrant(doc, doc.edges[0]!)?.ports).toEqual(["terminal.read"]);
    expect(allows(doc, "reviewer", "author", "verdict.post")).toBe(false);
    for (const invalid of ["terminal.write", "terminal.resize", "terminal.signal"]) {
      const raw = docWith([edge("messages")]);
      expect(Result.isFailure(decodeCanvasDoc({
        ...raw, edges: [{ ...raw.edges[0], ether: { verb: "messages", mask: [invalid] } }],
      })), invalid).toBe(true);
    }
  });

  it("does not turn malformed attenuation into unmasked authority", () => {
    const doc = docWith([edge("messages")]);
    for (const mask of [undefined, null, "msg.send", ["unknown.port"], [123]]) {
      expect(Result.isFailure(decodeCanvasDoc({
        ...doc, edges: [{ ...doc.edges[0], ether: { verb: "messages", mask } }],
      }))).toBe(true);
    }
  });

  it("does not infer a broader relationship from an explicitly invalid verb", () => {
    const doc = docWith([edge("messages")]);
    for (const verb of [undefined, null, "reviewz", 123]) {
      const decoded = decodeCanvasDoc({
        ...doc, edges: [{ ...doc.edges[0], ether: { verb } }],
      });
      expect(Result.isSuccess(decoded)).toBe(true);
      if (Result.isFailure(decoded)) throw decoded.failure;
      expect(decoded.success.edges).toEqual([]);
    }
  });
});
