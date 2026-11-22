// A removal marks its card and the next paint-order rebuild drops every
// marked card in one pass (issue 915): a batch of K removals is O(N), not a
// search and a splice each. The order the scene answers stays exact.

import { describe, expect, it } from "vitest";
import { asCanvasName } from "@shared/model";
import type { CardFact, Quad } from "../src/window/canvas/contract";
import { createScene } from "../src/window/canvas/engine/scene";
import { seat } from "./support/model-nodes";

const body = (): Quad[] =>
  [{ key: "body", kind: "shape", band: "cards", z: 1, rect: { x: 0, y: 0, width: 200, height: 60 }, tiers: 15, scale: { kind: "board" }, style: {} }] as unknown as Quad[];

const fact = (id: string, z: number): CardFact => ({ id, row: { ...seat(id), x: 0, y: 0 }, derived: { regionDepth: 0, blocked: false, z } }) as CardFact;

const everywhere = { x: -1000, y: -1000, width: 4000, height: 4000 };

describe("removing cards", () => {
  it("keeps the paint order exact through batches of removals and re-adds", () => {
    const scene = createScene({ painter: () => ({ quads: body(), dim: { opacity: 1, saturate: 1 }, lift: 0 }) });
    const ids = Array.from({ length: 50 }, (_, i) => `c${String(i).padStart(2, "0")}`);
    scene.apply({ kind: "load", canvas: asCanvasName("factory"), cards: ids.map((id, i) => fact(id, 50 - i)), wires: [] });
    // Paint order is z ascending: the last id is lowest.
    expect(scene.query(everywhere)).toEqual([...ids].reverse());
    // A batch of removals before any rebuild.
    const gone = new Set(ids.filter((_, i) => i % 3 === 0));
    for (const id of gone) scene.apply({ kind: "removeCard", id });
    expect(scene.query(everywhere)).toEqual([...ids].reverse().filter((id) => !gone.has(id)));
    // A removed id comes back at a new z, and a removal of a card never seen is nothing.
    scene.apply({ kind: "card", fact: fact("c00", 100) });
    scene.apply({ kind: "removeCard", id: "nobody" });
    expect(scene.query(everywhere)).toEqual([...[...ids].reverse().filter((id) => !gone.has(id)), "c00"]);
    // Removed and re-added inside one batch: one entry, not two.
    scene.apply({ kind: "removeCard", id: "c01" });
    scene.apply({ kind: "card", fact: fact("c01", 0) });
    const order = scene.query(everywhere);
    expect(order.filter((id) => id === "c01")).toEqual(["c01"]);
    expect(order[0]).toBe("c01");
    expect(new Set(order).size).toBe(order.length);
  });
});
