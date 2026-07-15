import { describe, expect, it } from "vitest";
import { Either } from "effect";
import {
  applyMirrorLaw,
  decodeCanvasDoc,
  serializeCanvas,
  type CanvasDoc,
} from "../src/shared/canvas";

// A raw (unknown-typed) document exercising every JSON Canvas node type plus
// the ether extension on both nodes and edges.
const rawDoc = {
  nodes: [
    {
      id: "t1",
      type: "text",
      text: "Hello",
      x: 0,
      y: 0,
      width: 200,
      height: 80,
      color: "2",
      ether: {
        entity: { kind: "project" },
        bindings: [{ source: "tower", ref: { type: "project", key: "demo" } }],
        flags: ["blocker"],
      },
    },
    {
      id: "f1",
      type: "file",
      file: "notes/todo.md",
      subpath: "#section",
      x: 300,
      y: 0,
      width: 200,
      height: 80,
      ether: { flags: ["parked"] },
    },
    {
      id: "l1",
      type: "link",
      url: "https://example.com",
      x: 600,
      y: 0,
      width: 200,
      height: 80,
    },
    {
      id: "grp1",
      type: "group",
      label: "Region",
      background: "#123456",
      backgroundStyle: "cover",
      x: 0,
      y: 200,
      width: 900,
      height: 300,
      ether: {},
    },
  ],
  edges: [
    {
      id: "e1",
      fromNode: "t1",
      toNode: "f1",
      fromSide: "right",
      toSide: "left",
      color: "3",
      label: "link",
    },
  ],
};

describe("canvas contract", () => {
  it("round-trips decode -> serialize -> decode to an identical document", () => {
    const decoded1 = Either.getOrThrow(decodeCanvasDoc(rawDoc));
    const serialized = serializeCanvas(decoded1);
    const decoded2 = Either.getOrThrow(decodeCanvasDoc(JSON.parse(serialized)));
    expect(decoded2).toEqual(decoded1);
  });

  it("still decodes once every ether key is stripped", () => {
    const stripped = {
      nodes: rawDoc.nodes.map((node) => {
        const { ether: _ether, ...rest } = node as typeof node & { ether?: unknown };
        return rest;
      }),
      edges: rawDoc.edges.map((edge) => {
        const { ether: _ether, ...rest } = edge as typeof edge & { ether?: unknown };
        return rest;
      }),
    };
    const decoded = decodeCanvasDoc(stripped);
    expect(Either.isRight(decoded)).toBe(true);
  });

  it("applyMirrorLaw sets edge label + color for blocks edges and color for blocker nodes", () => {
    const doc: CanvasDoc = {
      nodes: [
        { id: "n1", type: "text", text: "Blocker", x: 0, y: 0, width: 200, height: 80, ether: { flags: ["blocker"] } },
        { id: "n2", type: "text", text: "Plain", x: 0, y: 100, width: 200, height: 80 },
      ],
      edges: [
        { id: "e-blocks", fromNode: "n1", toNode: "n2", ether: { kind: "blocks", criteria: { mode: "tasks" } } },
        { id: "e-depends", fromNode: "n1", toNode: "n2", ether: { kind: "depends", criteria: { mode: "wip" } } },
        { id: "e-relates-labeled", fromNode: "n1", toNode: "n2", label: "kept", ether: { kind: "relates" } },
        { id: "e-plain", fromNode: "n1", toNode: "n2" },
      ],
    };

    const mirrored = applyMirrorLaw(doc);

    const blocker = mirrored.nodes.find((n) => n.id === "n1");
    expect(blocker?.color).toBe("1");
    const plainNode = mirrored.nodes.find((n) => n.id === "n2");
    expect(plainNode?.color).toBeUndefined();

    const blocksEdge = mirrored.edges.find((e) => e.id === "e-blocks");
    expect(blocksEdge?.label).toBe("blocks");
    expect(blocksEdge?.color).toBe("1");

    const dependsEdge = mirrored.edges.find((e) => e.id === "e-depends");
    expect(dependsEdge?.label).toBe("depends");
    expect(dependsEdge?.color).toBeUndefined();

    const labeledEdge = mirrored.edges.find((e) => e.id === "e-relates-labeled");
    expect(labeledEdge?.label).toBe("kept");

    const plainEdge = mirrored.edges.find((e) => e.id === "e-plain");
    expect(plainEdge?.label).toBeUndefined();
    expect(plainEdge?.color).toBeUndefined();
  });

  it("serializeCanvas produces a stable key order and is idempotent", () => {
    const decoded = Either.getOrThrow(decodeCanvasDoc(rawDoc));
    const first = serializeCanvas(decoded);
    const second = serializeCanvas(decoded);
    expect(first).toBe(second);

    // Key order within a node follows the canonical NODE_KEY_ORDER.
    const idIndex = first.indexOf('"id"');
    const typeIndex = first.indexOf('"type"');
    const xIndex = first.indexOf('"x"');
    const etherIndex = first.indexOf('"ether"');
    expect(idIndex).toBeGreaterThanOrEqual(0);
    expect(idIndex).toBeLessThan(typeIndex);
    expect(typeIndex).toBeLessThan(xIndex);
    expect(xIndex).toBeLessThan(etherIndex);
    expect(first.endsWith("\n")).toBe(true);
  });
});
