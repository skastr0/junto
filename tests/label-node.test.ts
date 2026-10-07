import { describe, expect, it } from "vitest";
import { WELL_KNOWN_ENTITY_KINDS, type CanvasDoc } from "../src/shared/canvas";
import { resolveSpec, roleOf } from "../src/shared/physics";
import { toFlow } from "../src/renderer/lib/convert";
import { makeGroupNode, makeLabelNode, makeTextNode } from "../src/renderer/lib/node-factories";
import { isLabelNode } from "../src/renderer/lib/presentation";
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
    expect(WELL_KNOWN_ENTITY_KINDS).toContain("label");
    const role = roleOf(resolveSpec({ isGroup: false, kind: "label" }));
    expect(role).toBe("geography");
  });

  it("makeLabelNode stamps entity.kind label with bare map defaults", () => {
    const node = makeLabelNode(12, 34);
    expect(isLabelNode(node)).toBe(true);
    expect(node.type).toBe("text");
    expect(node.text).toBe("Label");
    expect(node.ether?.entity?.kind).toBe("label");
    expect(node.id.startsWith("label-")).toBe(true);
    expect(node.width).toBe(160);
    expect(node.height).toBe(40);
    // No factory seat material.
    expect(node.ether?.terminal).toBeUndefined();
    expect(node.ether?.tasks).toBeUndefined();
    expect(node.ether?.host).toBeUndefined();
  });

  it("toFlow marks labels non-connectable (no handles)", () => {
    const label = makeLabelNode(0, 0);
    const note = makeTextNode(100, 0);
    const doc: CanvasDoc = { nodes: [label, note], edges: [] };
    const { nodes } = toFlow(doc, emptyContext);
    const flowLabel = nodes.find((n) => n.id === label.id);
    const flowNote = nodes.find((n) => n.id === note.id);
    expect(flowLabel?.connectable).toBe(false);
    expect(flowNote?.connectable).toBe(true);
  });

  it("toFlow keeps regions out of React Flow marquee hit-testing", () => {
    const region = makeGroupNode(0, 0);
    const { nodes } = toFlow({ nodes: [region], edges: [] }, emptyContext);

    expect(nodes[0]?.selectable).toBe(false);
  });

  // The window-frame grab lives entirely in GroupNode chrome: React Flow must
  // never drag a region itself, and the wrapper must stay pointer-transparent
  // so the interior keeps working as pane (marquee / deselect / add item).
  it("toFlow leaves region drag to chrome and keeps the wrapper pointer-transparent", () => {
    const region = makeGroupNode(0, 0);
    const { nodes } = toFlow({ nodes: [region], edges: [] }, emptyContext);

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
