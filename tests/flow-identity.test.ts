import { describe, expect, it } from "vitest";
import { keepHeldNodes, sameCard, saysTheSame } from "../src/renderer/lib/flow-identity";

type TestNode = {
  readonly id: string;
  readonly position: { readonly x: number; readonly y: number };
  readonly data: object;
  readonly style?: object;
  readonly selected?: boolean;
  readonly measured?: { readonly width: number; readonly height: number };
  readonly dragging?: boolean;
};

const data = { canvas: "factory", id: "a", kind: "note", blocked: false };
const style = { width: 240, height: 120 };
const rebuilt = (id: string, x = 0, extra: Partial<TestNode> = {}): TestNode => ({
  id, position: { x, y: 0 }, data, style, ...extra,
});
/** A node as React Flow holds it after measuring: a copy, with what it measured. */
const measured = (node: TestNode): TestNode => ({ ...node, measured: { width: 240, height: 120 } });

describe("a rebuild leaves alone the nodes React Flow already holds", () => {
  it("keeps every held node, measurement and all, when the canvas says the same", () => {
    const fromCanvas = [rebuilt("a"), rebuilt("b", 300), rebuilt("c", 600)];
    const held = fromCanvas.map(measured);
    expect(keepHeldNodes(held, fromCanvas)).toBe(held);
  });

  it("after a move of one card, replaces that card and no other", () => {
    const held = [rebuilt("a"), rebuilt("b", 300), rebuilt("c", 600)].map(measured);
    const next = keepHeldNodes(held, [rebuilt("a"), rebuilt("b", 340), rebuilt("c", 600)]);
    expect(next).not.toBe(held);
    expect(next[0]).toBe(held[0]);
    expect(next[2]).toBe(held[2]);
    expect(next[1]).not.toBe(held[1]);
    expect(next[1]?.position.x).toBe(340);
  });

  it("keeps a card React Flow already moved to where the canvas now has it", () => {
    // The drop: React Flow holds the dragged card at its new place, in a new
    // position object and marked as no longer dragging. The canvas agrees.
    const dropped = { ...measured(rebuilt("a")), position: { x: 80, y: 0 }, dragging: false };
    const held = [dropped, measured(rebuilt("b", 300))];
    expect(keepHeldNodes(held, [rebuilt("a", 80), rebuilt("b", 300)])).toBe(held);
  });

  it("takes the rebuilt node when anything a rebuild sets differs", () => {
    const held = measured(rebuilt("a"));
    expect(saysTheSame(held, rebuilt("a", 0, { selected: true }))).toBe(false);
    expect(saysTheSame(held, rebuilt("a", 0, { data: { ...data, blocked: true } }))).toBe(false);
    expect(saysTheSame(held, rebuilt("a", 0, { style: { width: 300, height: 120 } }))).toBe(false);
    expect(saysTheSame(held, rebuilt("a"))).toBe(true);
  });

  it("follows the canvas for nodes added, removed and reordered", () => {
    const a = measured(rebuilt("a"));
    const b = measured(rebuilt("b", 300));
    const added = keepHeldNodes([a, b], [rebuilt("a"), rebuilt("b", 300), rebuilt("c", 600)]);
    expect(added.map((node) => node.id)).toEqual(["a", "b", "c"]);
    expect(added[0]).toBe(a);
    expect(added[1]).toBe(b);
    const removed = keepHeldNodes([a, b], [rebuilt("b", 300)]);
    expect(removed).toEqual([b]);
    expect(removed[0]).toBe(b);
    const reordered = keepHeldNodes([a, b], [rebuilt("b", 300), rebuilt("a")]);
    expect(reordered[0]).toBe(b);
    expect(reordered[1]).toBe(a);
    expect(reordered).not.toEqual([a, b]);
  });
});

describe("a card renders for its own facts only", () => {
  const props = (over: object = {}) => ({ id: "a", selected: false, data, ...over });

  it("needs no render when React Flow moved, measured or dragged the node", () => {
    expect(sameCard(props(), props({ positionAbsoluteX: 80, dragging: true, width: 240, zIndex: 3 }))).toBe(true);
  });

  it("needs no render for data that is a new object saying the same", () => {
    expect(sameCard(props(), props({ data: { ...data } }))).toBe(true);
  });

  it("renders when it is selected, or a fact on its data changed", () => {
    expect(sameCard(props(), props({ selected: true }))).toBe(false);
    expect(sameCard(props(), props({ data: { ...data, blocked: true } }))).toBe(false);
    expect(sameCard(props(), props({ data: { ...data, regionDepth: 1 } }))).toBe(false);
    expect(sameCard(props(), props({ id: "b" }))).toBe(false);
  });
});
