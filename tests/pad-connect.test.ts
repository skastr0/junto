import { describe, expect, test } from "vitest";
import { asPadElementId, emptyPad, type Pad, type PadShape } from "../src/shared/pad";
import { connectEdge, portAt, portOf, shapePorts, snapTarget } from "../src/renderer/components/pad/pad-connect";
import { routeEdge } from "../src/shared/pad-geom";

const shape = (id: string, x: number, y: number, z = 0): PadShape =>
  ({ id: asPadElementId(id), type: "box", x, y, w: 100, h: 60, z }) as PadShape;
const pad = (...shapes: PadShape[]): Pad => ({ ...emptyPad(), shapes });
const reach = { port: 10, snap: 24 };
const A = asPadElementId("a");

describe("pad connectors", () => {
  test("a shape shows a port in the middle of each side", () => {
    expect(shapePorts(shape("a", 0, 0)).map((port) => [port.side, port.at])).toEqual([
      ["top", { x: 50, y: 0 }],
      ["right", { x: 100, y: 30 }],
      ["bottom", { x: 50, y: 60 }],
      ["left", { x: 0, y: 30 }],
    ]);
  });

  test("a port is grabbed within its reach, the topmost shape first", () => {
    expect(portOf(shape("a", 0, 0), { x: 106, y: 34 }, 10)).toBe("right");
    expect(portOf(shape("a", 0, 0), { x: 50, y: 30 }, 10)).toBeUndefined();
    const under = shape("under", 0, 0, 0);
    const over = shape("over", 0, 0, 1);
    expect(portAt(pad(under, over), { x: 50, y: 2 }, 10)?.shape.id).toBe("over");
  });

  test("a dragged edge snaps to a port, then a shape under it, then a shape near it", () => {
    const p = pad(shape("a", 0, 0), shape("b", 300, 0));
    expect(snapTarget(p, { x: 302, y: 31 }, A, reach)).toMatchObject({ shape: { id: "b" }, side: "left" });
    const inside = snapTarget(p, { x: 350, y: 45 }, A, reach);
    expect(inside?.shape.id).toBe("b");
    expect(inside?.side).toBeUndefined();
    expect(snapTarget(p, { x: 285, y: 50 }, A, reach)?.shape.id).toBe("b");
    expect(snapTarget(p, { x: 200, y: 50 }, A, reach)).toBeUndefined();
  });

  test("an edge never snaps back to the shape it starts from", () => {
    expect(snapTarget(pad(shape("a", 0, 0)), { x: 50, y: 30 }, A, reach)).toBeUndefined();
  });

  test("a release writes one edge, keeps only the sides it pinned, and refuses a repeat", () => {
    const b = shape("b", 300, 0);
    const edge = connectEdge(pad(shape("a", 0, 0), b), asPadElementId("e"), A, "right", { shape: b });
    expect(edge).toEqual({ id: "e", from: "a", to: "b", fromSide: "right" });
    const drawn: Pad = { ...pad(shape("a", 0, 0), b), edges: [edge!] };
    expect(connectEdge(drawn, asPadElementId("e2"), A, "right", { shape: b })).toBeUndefined();
    expect(connectEdge(drawn, asPadElementId("e3"), A, "right", { shape: b, side: "top" })).toBeDefined();
  });
});

describe("pad edge routes", () => {
  test("an edge leaves the side facing its target and lands on the target's facing side", async () => {
    const right = routeEdge(shape("a", 0, 0), shape("b", 300, 0));
    expect(right[0]).toEqual({ x: 100, y: 30 });
    expect(right.at(-1)).toEqual({ x: 300, y: 30 });
    const left = routeEdge(shape("b", 300, 0), shape("a", 0, 0));
    expect(left.at(-1)).toEqual({ x: 100, y: 30 });
    const down = routeEdge(shape("a", 0, 0), shape("c", 0, 200));
    expect(down.at(-1)).toEqual({ x: 50, y: 200 });
    const inside = (p: { x: number; y: number }, x: number) => p.x > x && p.x < x + 100 && p.y > 0 && p.y < 60;
    for (const point of right) expect(inside(point, 0) || inside(point, 300)).toBe(false);
  });
});

describe("pad ports on a triangle", () => {
  test("its side ports sit on its slanted sides, not out at its box", () => {
    const tri = { ...shape("t", 0, 0), type: "triangle" } as PadShape;
    const ports = Object.fromEntries(shapePorts(tri).map((port) => [port.side, port.at]));
    expect(ports.left).toEqual({ x: 25, y: 30 });
    expect(ports.right).toEqual({ x: 75, y: 30 });
    expect(ports.top).toEqual({ x: 50, y: 0 });
  });
});
