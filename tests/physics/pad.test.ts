import { describe, expect, it } from "vitest";
import { HashSet, Result } from "effect";
import type { CanvasDoc } from "../../src/shared/canvas";
import { WELL_KNOWN_ENTITY_KINDS } from "../../src/shared/canvas";
import {
  KindSpecs,
  NodeContracts,
  OPS_BY_SINK,
  PortForWorkOp,
  SINK_KINDS,
  admitPure,
  asNodeId,
  canvasDocToCapabilityView,
  opsForSink,
  resolveSpec,
  roleOf,
} from "../../src/shared/physics";
import { makePadNode } from "../../src/renderer/lib/node-factories";

const agentNode = (id: string): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  text: id,
  x: 0,
  y: 0,
  width: 120,
  height: 48,
  ether: { entity: { kind: "agent" } },
});

describe("pad physics sink", () => {
  it("is a well-known sink with pad.read and pad.patch only", () => {
    expect(SINK_KINDS).toContain("pad");
    expect(WELL_KNOWN_ENTITY_KINDS).toContain("pad");
    expect(KindSpecs.pad.role).toBe("sink");
    expect(roleOf(resolveSpec({ isGroup: false, kind: "pad" }))).toBe("sink");
    expect([...KindSpecs.pad.offers].sort()).toEqual(["pad.patch", "pad.read"]);
    expect([...opsForSink("pad")]).toEqual(["pad.read", "pad.patch"]);
    expect([...OPS_BY_SINK.pad]).toEqual(["pad.read", "pad.patch"]);
    expect(PortForWorkOp["pad.read"]).toBe("pad.read");
    expect(PortForWorkOp["pad.patch"]).toBe("pad.patch");
    expect([...NodeContracts.pad.ports].sort()).toEqual(["pad.patch", "pad.read"]);
  });

  it("makePadNode authors an empty legal sink", () => {
    const node = makePadNode(12, 34);
    expect(node.type).toBe("text");
    expect(node.text).toBe("pad");
    expect(node.ether?.entity?.kind).toBe("pad");
    expect(node.id.startsWith("pad-")).toBe(true);
    expect(node.x).toBe(12);
    expect(node.y).toBe(34);
    expect(node.ether?.board).toBeUndefined();
    expect(node.ether?.tasks).toBeUndefined();
    expect(node.ether?.host).toBeUndefined();
    expect(roleOf(resolveSpec({ isGroup: false, kind: node.ether?.entity?.kind }))).toBe(
      "sink",
    );
  });

  it("admits pad.read and pad.patch on an actor→pad access edge", () => {
    const pad = makePadNode(200, 0);
    const doc: CanvasDoc = {
      nodes: [agentNode("agent"), pad],
      edges: [{ id: "e1", fromNode: "agent", toNode: pad.id }],
    };
    const view = canvasDocToCapabilityView(doc);
    const read = admitPure(view, asNodeId("agent"), asNodeId(pad.id), "pad.read");
    const patch = admitPure(view, asNodeId("agent"), asNodeId(pad.id), "pad.patch");
    expect(Result.isSuccess(read)).toBe(true);
    expect(Result.isSuccess(patch)).toBe(true);
  });

  it("denies pad ports without an edge", () => {
    const pad = makePadNode(200, 0);
    const doc: CanvasDoc = {
      nodes: [agentNode("agent"), pad],
      edges: [],
    };
    const view = canvasDocToCapabilityView(doc);
    const denied = admitPure(view, asNodeId("agent"), asNodeId(pad.id), "pad.read");
    expect(Result.isFailure(denied)).toBe(true);
  });

  it("does not offer board or task ports", () => {
    expect(HashSet.has(KindSpecs.pad.offers, "board.list")).toBe(false);
    expect(HashSet.has(KindSpecs.pad.offers, "tasks.list")).toBe(false);
    expect(HashSet.has(KindSpecs.pad.offers, "browser.automate")).toBe(false);
  });
});
