import { describe, expect, it } from "vitest";
import {
  connectionFocusSelection,
  edgeImpactClass,
  nodeImpactClass,
} from "../src/renderer/lib/impact-mode";
import { canvasOf, seat, wire } from "./support/model-nodes";

const agent = (id: string, label: string) => seat(id, { label: label as never });

const mailCanvas = () =>
  canvasOf(
    [agent("hub", "Lead"), agent("a1", "Ship"), agent("a2", "Release"), agent("outsider", "Other")],
    [wire("e-a1", "a1", "hub", "messages"), wire("e-a2", "a2", "hub", "messages")],
  );

describe("connectionFocusSelection — direct neighborhood focus", () => {
  it("keeps the root, incident edges, and their neighboring nodes only", () => {
    const focus = connectionFocusSelection(mailCanvas(), "a1");

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
    const focus = connectionFocusSelection(mailCanvas(), "outsider");

    expect(focus.active).toBe(true);
    expect(focus.cone.nodeIds).toEqual(new Set(["outsider"]));
    expect(focus.cone.edgeIds.size).toBe(0);
    expect(focus.seedLabel).toBe("0 connected - 0 edges");
  });

  it("stays inactive when the requested node no longer exists", () => {
    const focus = connectionFocusSelection(mailCanvas(), "missing");
    expect(focus.active).toBe(false);
    expect(focus.cone.nodeIds.size).toBe(0);
  });
});
