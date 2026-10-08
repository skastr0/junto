import { describe, expect, it } from "vitest";
import type { CanvasEdge, CanvasNode } from "../src/main/junto/station/frozen-document";
import {
  canvasFromDocument,
  nodeOfDocument,
  wireOfDocument,
} from "../src/main/junto/station/frozen-from-document";

const seat = (id: string, x = 0): CanvasNode =>
  ({
    id,
    type: "text",
    text: id,
    x,
    y: 0,
    width: 216,
    height: 96,
    ether: {
      entity: { kind: "agent", name: `local:${id}` },
      terminal: { bindingId: `binding-${id}`, harness: "claude" },
    },
  }) as CanvasNode;

describe("rows held per node and edge object", () => {
  it("converts an untouched node once across documents", () => {
    const lead = seat("lead");
    const first = canvasFromDocument("factory", {
      nodes: [lead, seat("nodes")],
      edges: [],
    });
    const second = canvasFromDocument("factory", {
      nodes: [lead, seat("nodes", 400)],
      edges: [],
    });
    expect(second).not.toBe(first);
    expect(second.nodes.get("lead" as never)).toBe(
      first.nodes.get("lead" as never),
    );
    expect(second.nodes.get("nodes" as never)).toMatchObject({ x: 400 });
  });

  it("converts again when a node moves in the stack", () => {
    const lead = seat("lead");
    const low = nodeOfDocument("factory", lead, 0);
    expect(nodeOfDocument("factory", lead, 0)).toBe(low);
    expect(nodeOfDocument("factory", lead, 3)).toMatchObject({ z: 3 });
  });

  it("remembers a refusal and holds a wire", () => {
    const edge = {
      id: "e1",
      fromNode: "lead",
      toNode: "nodes",
      ether: { verb: "messages" },
    } as unknown as CanvasEdge;
    const wire = wireOfDocument(edge);
    expect(wire).toMatchObject({ id: "e1", from: "lead", to: "nodes" });
    expect(wireOfDocument(edge)).toBe(wire);
    const bare = { id: "e2", fromNode: "lead", toNode: "nodes" } as CanvasEdge;
    expect(wireOfDocument(bare)).toBeUndefined();
    expect(wireOfDocument(bare)).toBeUndefined();
  });
});
