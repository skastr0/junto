// #915 item 2: a shadow quad is the element grown by its recipe's reach, with
// the element as its hole, so the drop has room to draw and the fragment stage
// stops inside the element. Inset layers are flagged for the shader.

import { describe, expect, it } from "vitest";
import { asCanvasName } from "@shared/model";
import type { CardFact } from "../src/window/canvas/contract";
import { at, shadow, shadowReach } from "../src/window/canvas/paint/refs";
import { createScene } from "../src/window/canvas/engine/scene";
import { seat } from "./support/model-nodes";

describe("a shadow's reach", () => {
  it("is the larger offset, the spread and half the blur, over the outer layers", () => {
    // card: 0 10 28 0 → 10 + 14.
    expect(shadowReach("card")).toBe(24);
    // attention: the drop (10 + 14) outreaches the glow band (2 + 9).
    expect(shadowReach("attention")).toBe(24);
    // cluster: offset 5 or 10, negative spread adds nothing, no blur → 10.25.
    expect(shadowReach("cluster")).toBe(11);
  });

  it("grows the element's box and names the element as the hole", () => {
    const quad = shadow({ key: "s", z: 0, rect: at(0, 0, 200, 100) }, { shadow: { name: "card" } }, { radii: 12 });
    expect(quad.rect).toEqual({ x: -24, y: -24, width: 248, height: 148 });
    expect(quad.hole).toBe(24);
    // The radii stay the element's.
    expect(quad.radii).toBe(12);
  });

  it("keeps a caller's own growth and hole", () => {
    const quad = shadow({ key: "s", z: 0, rect: at(-20, -20, 240, 140) }, { shadow: { name: "seat" } }, { radii: 12, hole: 20 });
    expect(quad.rect).toEqual({ x: -20, y: -20, width: 240, height: 140 });
    expect(quad.hole).toBe(20);
  });

  it("rounds a disc's shadow to the element", () => {
    const quad = shadow({ key: "s", z: 0, rect: at(0, 0, 40, 40) }, { shadow: { name: "cluster" } }, { shape: "disc" });
    expect(quad.radii).toBe(20);
  });
});

describe("the shadow table", () => {
  it("flags each inset layer in the spec's third word", () => {
    const card: CardFact = { id: "a", row: seat("a"), derived: { regionDepth: 0, blocked: false, z: 0 } };
    const scene = createScene({
      painter: () => ({
        quads: [
          shadow({ key: "u", z: 0, rect: at(0, 0, 100, 100) }, { shadow: { name: "region-urgency", tint: { token: "main" } } }),
          shadow({ key: "c", z: 0, rect: at(0, 0, 100, 100) }, { shadow: { name: "card" } }),
        ],
        dim: { opacity: 1, saturate: 1 },
        lift: 0,
      }),
    });
    scene.apply({ kind: "load", canvas: asCanvasName("factory"), cards: [card], wires: [] });
    scene.prepare({ x: -100, y: -100, width: 800, height: 600 }, "near");
    const { meta } = scene.shadowSnapshot();
    const masks = Array.from({ length: meta.length / 4 }, (_, index) => meta[index * 4 + 2]);
    // region-urgency has inset layers; card has none.
    expect(masks.some((mask) => mask !== 0)).toBe(true);
    expect(masks).toContain(0);
  });
});
