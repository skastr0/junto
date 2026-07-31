import { describe, expect, it } from "vitest";
import { WELL_KNOWN_ENTITY_KINDS, type CanvasDoc } from "../src/shared/canvas";
import { resolveSpec, roleOf } from "../src/shared/physics";
import { toFlow } from "../src/renderer/lib/convert";
import { makeLabelNode, makeTextNode } from "../src/renderer/lib/node-factories";
import { isLabelNode } from "../src/renderer/lib/presentation";
import { planConnectToTarget } from "../src/renderer/lib/edge-mutations";
import { DEFAULT_NODE_CATALOG_ENTRIES } from "../src/renderer/components/node-palette/NodeCatalogGrid";

const emptyContext = {
  canvasName: "test",
  resolveActorRef: () => undefined,
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

  it("planConnectToTarget refuses labels as source or target", () => {
    const label = makeLabelNode(0, 0);
    const a = { ...makeTextNode(10, 10), id: "a" };
    const b = { ...makeTextNode(20, 20), id: "b" };
    const nodes = [label, a, b];

    const asTarget = planConnectToTarget(["a"], label.id, nodes, []);
    expect(asTarget.toAdd).toEqual([]);
    expect(asTarget.skipped).toEqual([{ source: "a", reason: "invalid-target" }]);

    const asSource = planConnectToTarget([label.id], "b", nodes, []);
    expect(asSource.toAdd).toEqual([]);
    expect(asSource.skipped).toEqual([{ source: label.id, reason: "label-source" }]);
  });

  it("catalog lists Label under canvas with no connections", () => {
    const entry = DEFAULT_NODE_CATALOG_ENTRIES.find((c) => c.id === "label");
    expect(entry).toBeDefined();
    expect(entry?.category).toBe("canvas");
    expect(entry?.label).toBe("Label");
    expect(entry?.connections).toEqual([]);
  });
});
