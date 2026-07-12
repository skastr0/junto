import { describe, expect, it } from "vitest";
import { Either } from "effect";
import { decodeCanvasDoc, type CanvasDoc } from "../src/shared/canvas";
import { connectDoc, deriveConnections } from "../src/shared/connect";
import { glyphKey, signalKey } from "../src/shared/refs";

const doc: CanvasDoc = {
  nodes: [
    {
      id: "proj-prism",
      type: "text",
      x: 0,
      y: 0,
      width: 200,
      height: 80,
      text: "prism",
      ether: { entity: { kind: "project" }, bindings: [{ source: "tower", ref: { type: "project", key: "prism" } }] },
    },
    {
      id: "agent-orion",
      type: "text",
      x: 0,
      y: 200,
      width: 200,
      height: 80,
      text: "profile-09 · remote-a",
      ether: { entity: { kind: "agent" }, bindings: [{ source: "hermes", ref: { type: "agent", key: "remote-a:profile-09" } }] },
    },
    {
      id: "gly-1",
      type: "text",
      x: 300,
      y: 0,
      width: 200,
      height: 46,
      text: "VL-001",
      ether: { entity: { kind: "glyph" }, bindings: [{ source: "tower", ref: { type: "glyph", key: glyphKey("prism", "forge", "VL-001") } }] },
    },
    {
      id: "sig-1",
      type: "text",
      x: 300,
      y: 200,
      width: 200,
      height: 46,
      text: "work-delivered",
      ether: { entity: { kind: "signal" }, bindings: [{ source: "tower", ref: { type: "signal", key: signalKey("prism", "forge", "sig_abc") } }] },
    },
  ],
  edges: [],
};

describe("provenance connections", () => {
  it("links a glyph node to its project", () => {
    const edges = deriveConnections(doc);
    expect(edges.some((e) => e.fromNode === "gly-1" && e.toNode === "proj-prism" && e.label === "in")).toBe(true);
  });

  it("links a signal node to its project and to the emitting agent", () => {
    const edges = deriveConnections(doc, { signalAgents: { sig_abc: "profile-09" } });
    expect(edges.some((e) => e.fromNode === "sig-1" && e.toNode === "proj-prism" && e.label === "in")).toBe(true);
    expect(edges.some((e) => e.fromNode === "sig-1" && e.toNode === "agent-orion" && e.label === "from")).toBe(true);
  });

  it("omits the agent link when no source-agent map is given", () => {
    const edges = deriveConnections(doc);
    expect(edges.some((e) => e.toNode === "agent-orion")).toBe(false);
  });

  it("all derived edges are kind relates", () => {
    const edges = deriveConnections(doc, { signalAgents: { sig_abc: "profile-09" } });
    expect(edges.every((e) => e.ether?.kind === "relates")).toBe(true);
  });

  it("produces a valid canvas and is idempotent", () => {
    const once = connectDoc(doc, { signalAgents: { sig_abc: "profile-09" } });
    expect(Either.isRight(decodeCanvasDoc(once))).toBe(true);
    const twice = connectDoc(once, { signalAgents: { sig_abc: "profile-09" } });
    expect(twice.edges.length).toBe(once.edges.length);
  });
});
