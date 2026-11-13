// The record's remaining fields (contract "Drawing records"): the far name
// tag's scale rule and the style transition a same-key repaint starts.

import { describe, expect, it } from "vitest";
import { asCanvasName } from "@shared/model";
import type { CardFact, CardView, PaintEnv, Quad, QuadStyle } from "../src/window/canvas/contract";
import { createScene } from "../src/window/canvas/engine/scene";
import { SCALE_RULE, QUAD_FLOATS } from "../src/window/canvas/engine/quad";
import { seat } from "./support/model-nodes";

const fact = (): CardFact => ({ id: "a", row: seat("a"), derived: { regionDepth: 0, blocked: false, z: 0 } });
const env: PaintEnv = { measure: (run) => run.text.length * run.size * 0.6 };

const styleWhen = (selected: boolean): QuadStyle => ({
  fill: { kind: "flat", color: { token: selected ? "cyan" : "amber" } },
});

const sceneWith = (quads: (view: CardView) => ReadonlyArray<Quad>) => {
  const scene = createScene({
    painter: (_fact, _live, view, _env) => ({ quads: quads(view), dim: { opacity: 1, saturate: 1 }, lift: 0 }),
  });
  scene.apply({ kind: "load", canvas: asCanvasName("factory"), cards: [fact()], wires: [] });
  return scene;
};

const word = (scene: ReturnType<typeof createScene>, slot: number, index: number): number =>
  scene.quadBuffer.u32[slot * QUAD_FLOATS + index]!;

const float = (scene: ReturnType<typeof createScene>, slot: number, index: number): number =>
  scene.quadBuffer.f32[slot * QUAD_FLOATS + index]!;

describe("the far name tag", () => {
  it("packs its own scale rule, not board", () => {
    const scene = sceneWith(() => [{
      key: "tag",
      kind: "shape",
      band: "lifted",
      z: 60,
      rect: { x: 10, y: 40, width: 120, height: 20 },
      tiers: 15,
      scale: { kind: "seatTag", cap: 2, anchor: { x: 26, y: 26 } },
      style: {},
    }]);
    expect(word(scene, 0, 17)).toBe(SCALE_RULE.seatTag);
    expect(float(scene, 0, 18)).toBe(2);
    expect(float(scene, 0, 25)).toBe(26);
  });
});

describe("a style change on the same key", () => {
  it("keeps the style it left and when, and a same-style repaint keeps it running", () => {
    const scene = sceneWith((view) => [{
      key: "shell",
      kind: "shape",
      band: "cards",
      z: 1,
      rect: { x: 0, y: 0, width: 216, height: 56 },
      tiers: 15,
      scale: { kind: "board" },
      style: styleWhen(view.selected),
    }]);
    scene.setWallClock(1_000);
    const first = word(scene, 0, 27);
    scene.apply({ kind: "selection", fact: { nodeIds: ["a"] } });
    const second = word(scene, 0, 27);
    expect(second).not.toBe(first);
    expect(word(scene, 0, 28)).toBe(first);
    expect(float(scene, 0, 29)).toBe(1_000);
    scene.setWallClock(1_100);
    scene.apply({ kind: "selection", fact: { nodeIds: ["a"] } });
    expect(word(scene, 0, 27)).toBe(second);
    expect(word(scene, 0, 28)).toBe(first);
    expect(float(scene, 0, 29)).toBe(1_000);
  });
});
