import { describe, expect, it } from "vitest";
import type { CanvasDoc } from "../src/shared/canvas";
import {
  connectionFocusSelection,
  edgeImpactClass,
  nodeImpactClass,
} from "../src/renderer/lib/impact-mode";

const agent = (id: string, label: string): CanvasDoc["nodes"][number] => ({
  id,
  type: "text",
  text: label,
  x: 0,
  y: 0,
  width: 200,
  height: 80,
  ether: { entity: { kind: "agent", name: `local:${id}` } },
});

const mailDoc = (): CanvasDoc => ({
  nodes: [
    agent("hub", "Lead"),
    agent("a1", "Ship"),
    agent("a2", "Release"),
    agent("outsider", "Other"),
  ],
  edges: [
    {
      id: "e-a1",
      fromNode: "a1",
      toNode: "hub",
      ether: { verb: "messages" },
    },
    {
      id: "e-a2",
      fromNode: "a2",
      toNode: "hub",
      ether: { verb: "messages" },
    },
  ],
});

describe("connectionFocusSelection — direct neighborhood focus", () => {
  it("keeps the root, incident edges, and their neighboring nodes only", () => {
    const doc = mailDoc();
    const focus = connectionFocusSelection(doc, "a1");

    expect(focus.active).toBe(true);
    expect(focus.cone.nodeIds).toEqual(new Set(["a1", "hub"]));
    expect(focus.cone.edgeIds).toEqual(new Set(["e-a1"]));
    expect(focus.seedLabel).toBe("1 connected - 1 edge");
    expect(nodeImpactClass(true, focus.cone, "a1")).toBe("impact-in impact-root");
    expect(nodeImpactClass(true, focus.cone, "hub")).toBe("impact-in");
    expect(nodeImpactClass(true, focus.cone, "a2")).toBeUndefined();
    expect(edgeImpactClass(true, focus.cone, "e-a1")).toBe("impact-edge-in");
    expect(edgeImpactClass(true, focus.cone, "e-a2")).toBeUndefined();
  });

  it("still focuses an isolated node so the operator can dismiss the noise", () => {
    const doc = mailDoc();
    const focus = connectionFocusSelection(doc, "outsider");

    expect(focus.active).toBe(true);
    expect(focus.cone.nodeIds).toEqual(new Set(["outsider"]));
    expect(focus.cone.edgeIds.size).toBe(0);
    expect(focus.seedLabel).toBe("0 connected - 0 edges");
  });

  it("stays inactive when the requested node no longer exists", () => {
    const focus = connectionFocusSelection(mailDoc(), "missing");
    expect(focus.active).toBe(false);
    expect(focus.cone.nodeIds.size).toBe(0);
  });
});
