import { describe, expect, it } from "vitest";
import { NODE_KINDS } from "../src/shared/model";
import { resolveSpec, roleOf } from "../src/shared/physics";
import { toFlowOfCanvas } from "../src/renderer/lib/convert";
import { newRegion, newLabel, newNote } from "../src/renderer/lib/model-factories";
import { targetPlanOn } from "../src/renderer/lib/edge-mutations";
import { asNodeId, type Node } from "../src/shared/model";
import { canvasOf, seat } from "./support/model-nodes";
import { DEFAULT_NODE_CATALOG_ENTRIES } from "../src/renderer/components/node-palette/NodeCatalogGrid";

const emptyContext = {
  canvasName: "test",
  resolveActorRef: () => undefined,
  itemsOf: () => [],
};

describe("label geography node", () => {
  it("is a well-known entity kind but geography role (not physics KindSpecs)", () => {
    expect(NODE_KINDS).toContain("label");
    const role = roleOf(resolveSpec({ isGroup: false, kind: "label" }));
    expect(role).toBe("geography");
  });

  it("newLabel makes bare map text with its defaults", () => {
    const node = newLabel({ x: 12, y: 34, z: 0 });
    expect(node.kind).toBe("label");
    expect(node.text).toBe("Label");
    expect(node.id.startsWith("label-")).toBe(true);
    expect(node.width).toBe(160);
    expect(node.height).toBe(40);
    // No factory seat material.
    expect(node).not.toHaveProperty("bindingId");
    expect(node).not.toHaveProperty("items");
    expect(node).not.toHaveProperty("host");
  });

  it("toFlow marks labels non-connectable (no handles)", () => {
    const label = newLabel({ x: 0, y: 0, z: 0 });
    const note = newNote({ x: 100, y: 0, z: 1 });
    const { nodes } = toFlowOfCanvas(canvasOf([label, note]), emptyContext);
    const flowLabel = nodes.find((n) => n.id === label.id);
    const flowNote = nodes.find((n) => n.id === note.id);
    expect(flowLabel?.connectable).toBe(false);
    expect(flowNote?.connectable).toBe(true);
  });

  it("toFlow keeps regions out of React Flow marquee hit-testing", () => {
    const region = newRegion({ x: 0, y: 0, z: 0 });
    const { nodes } = toFlowOfCanvas(canvasOf([region]), emptyContext);

    expect(nodes[0]?.selectable).toBe(false);
  });

  // The window-frame grab lives entirely in GroupNode chrome: React Flow must
  // never drag a region itself, and the wrapper must stay pointer-transparent
  // so the interior keeps working as pane (marquee / deselect / add item).
  it("toFlow leaves region drag to chrome and keeps the wrapper pointer-transparent", () => {
    const region = newRegion({ x: 0, y: 0, z: 0 });
    const { nodes } = toFlowOfCanvas(canvasOf([region]), emptyContext);

    expect(nodes[0]?.draggable).toBe(false);
    expect(nodes[0]?.connectable).toBe(false);
    expect(nodes[0]?.style?.pointerEvents).toBe("none");
  });

  it("a batch connect refuses labels as source or target", () => {
    const label = { kind: "label", id: asNodeId("label"), text: "Label", x: 0, y: 0, width: 120, height: 40, z: 0 } as Node;
    const canvas = canvasOf([label, seat("a"), seat("b")]);

    const asTarget = targetPlanOn(canvas, ["a"], "label");
    expect(asTarget.toAdd).toEqual([]);
    expect(asTarget.skipped).toEqual([{ source: "a", reason: "invalid-target" }]);

    const asSource = targetPlanOn(canvas, ["label"], "b");
    expect(asSource.toAdd).toEqual([]);
    expect(asSource.skipped).toEqual([{ source: "label", reason: "label-source" }]);
  });

  it("catalog lists Label under canvas", () => {
    const entry = DEFAULT_NODE_CATALOG_ENTRIES.find((c) => c.id === "label");
    expect(entry).toBeDefined();
    expect(entry?.category).toBe("canvas");
    expect(entry?.label).toBe("Label");
  });
});
