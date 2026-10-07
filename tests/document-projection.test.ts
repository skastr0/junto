import { describe, expect, it } from "vitest";
import { asCanvasName, type Node, type Wire } from "../src/shared/model";
import type { Canvas } from "../src/shared/model/canvas";
import { createDocumentProjection } from "../src/renderer/lib/document-projection";

const note = (id: string, text: string, z: number): Node =>
  ({ kind: "note", id, text, x: 0, y: 0, width: 120, height: 60, z }) as unknown as Node;

const wire = (id: string, from: string, to: string): Wire =>
  ({ id, from, to, verb: "relates" }) as unknown as Wire;

const canvasOf = (nodes: ReadonlyArray<Node>, wires: ReadonlyArray<Wire> = []): Canvas => ({
  name: asCanvasName("factory"),
  seq: 0,
  nodes: new Map(nodes.map((node) => [node.id, node])),
  wires: new Map(wires.map((row) => [row.id, row])),
});

describe("the window's document, worked out from the node store", () => {
  it("lists nodes in paint order whatever order the store holds them in", () => {
    const project = createDocumentProjection();
    const doc = project(canvasOf([note("top", "top", 5), note("b", "b", 1), note("a", "a", 1), note("back", "back", -3)]));
    expect(doc.nodes.map((node) => node.id)).toEqual(["back", "a", "b", "top"]);
  });

  it("keeps the document node of every row that did not change", () => {
    const project = createDocumentProjection();
    const a = note("a", "a", 0);
    const b = note("b", "b", 1);
    const before = project(canvasOf([a, b], [wire("w", "a", "b")]));
    const after = project(canvasOf([a, note("b", "b edited", 1)], [...canvasOf([a, b], [wire("w", "a", "b")]).wires.values()]));
    expect(after).not.toBe(before);
    expect(after.nodes[0]).toBe(before.nodes[0]);
    expect(after.nodes[1]).not.toBe(before.nodes[1]);
    expect(after.nodes[1]).toMatchObject({ id: "b", text: "b edited" });
  });

  it("is the same document when nothing in it changed", () => {
    const project = createDocumentProjection();
    const a = note("a", "a", 0);
    const w = wire("w", "a", "a2");
    const a2 = note("a2", "a2", 1);
    const before = project(canvasOf([a, a2], [w]));
    expect(project({ ...canvasOf([a, a2], [w]), seq: 9 })).toBe(before);
  });

  it("keeps a wire that did not change, and drops what is gone", () => {
    const project = createDocumentProjection();
    const a = note("a", "a", 0);
    const b = note("b", "b", 1);
    const w = wire("w", "a", "b");
    const before = project(canvasOf([a, b], [w]));
    const moved = project(canvasOf([{ ...a, x: 40 } as Node, b], [w]));
    expect(moved.edges[0]).toBe(before.edges[0]);
    expect(moved.nodes[1]).toBe(before.nodes[1]);
    const removed = project(canvasOf([b]));
    expect(removed.nodes.map((node) => node.id)).toEqual(["b"]);
    expect(removed.edges).toEqual([]);
    expect(removed.nodes[0]).toBe(before.nodes[1]);
  });

  it("makes a row again when it comes back as a different object", () => {
    const project = createDocumentProjection();
    const a = note("a", "a", 0);
    const first = project(canvasOf([a]));
    project(canvasOf([]));
    const again = project(canvasOf([a]));
    expect(again.nodes[0]).toEqual(first.nodes[0]);
  });
});
