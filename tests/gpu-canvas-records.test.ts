// The record's remaining fields (contract "Drawing records"): the far name
// tag's scale rule and the style transition a same-key repaint starts.

import { describe, expect, it } from "vitest";
import { asCanvasName } from "@shared/model";
import { farSeatScale } from "@shared/canvas-tier";
import type { CardFact, CardView, PaintEnv, Quad, QuadStyle } from "../src/window/canvas/contract";
import { atlasScale, createScene } from "../src/window/canvas/engine/scene";
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

describe("the owner slot", () => {
  it("names the card's own owner slot, not slot zero, and a move writes that entry", () => {
    const second: CardFact = { id: "b", row: seat("b", { x: 400, y: 200 }), derived: { regionDepth: 0, blocked: false, z: 0 } };
    const scene = createScene({
      painter: (_fact, _live, _view, _env) => ({
        quads: [{
          key: "shell",
          kind: "shape",
          band: "cards",
          z: 1,
          rect: { x: 0, y: 0, width: 216, height: 56 },
          tiers: 15,
          scale: { kind: "board" },
          style: {},
        }],
        dim: { opacity: 1, saturate: 1 },
        lift: 0,
      }),
    });
    scene.apply({ kind: "load", canvas: asCanvasName("factory"), cards: [fact(), second], wires: [] });
    expect(word(scene, 0, 15)).toBe(0);
    expect(word(scene, 1, 15)).toBe(1);
    // A drag is the owner entry, never the record's card-local rect.
    scene.moveCard("b", { x: 640, y: 260 });
    expect(float(scene, 1, 0)).toBe(0);
    expect(scene.ownerBuffer[1 * 8]).toBe(640);
    expect(scene.ownerBuffer[1 * 8 + 1]).toBe(260);
  });

  it("carries the drawn card size, which the far seat rule centres the ring on", () => {
    const scene = sceneWith(() => []);
    expect(scene.ownerBuffer[5]).toBe(216);
    expect(scene.ownerBuffer[6]).toBe(56);
    scene.resizeCard("a", { x: 0, y: 0, width: 300, height: 80 });
    expect(scene.ownerBuffer[5]).toBe(300);
    expect(scene.ownerBuffer[6]).toBe(80);
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

describe("the atlas cell a record draws from", () => {
  const textQuad = (key: string): Quad => ({
    key,
    kind: "text",
    band: "cards",
    z: 1,
    rect: { x: 8, y: 12, width: 120, height: 16 },
    tiers: 15,
    scale: { kind: "board" },
    style: {},
    text: { text: "Planner", font: "mono", size: 12, weight: 500, truncate: "end", width: 120 },
  });

  const sceneWithSource = (source: (quad: Quad, scale: number) => number) => {
    let zoom = 1;
    let revision = 0;
    const seen: number[] = [];
    const scene = createScene({
      painter: () => ({ quads: [textQuad("name")], dim: { opacity: 1, saturate: 1 }, lift: 0 }),
      source: (quad, scale) => {
        seen.push(scale);
        return source(quad, scale) + revision;
      },
      scale: () => zoom,
      atlasRevision: () => revision,
    });
    scene.apply({ kind: "load", canvas: asCanvasName("factory"), cards: [fact()], wires: [] });
    return {
      scene,
      seen,
      setZoom: (next: number): void => {
        zoom = next;
      },
      bumpRevision: (): void => {
        revision += 1;
      },
      view: { x: -100, y: -100, width: 800, height: 600 },
    };
  };

  it("packs the source the atlas answers instead of none", () => {
    const { scene } = sceneWithSource((_quad, scale) => Math.round(scale * 100));
    expect(word(scene, 0, 23)).toBe(100);
  });

  it("re-resolves a visible text record when the raster scale bucket changes", () => {
    const { scene, setZoom, view } = sceneWithSource((_quad, scale) => Math.round(scale * 100));
    scene.prepare(view, "near");
    setZoom(2);
    scene.prepare(view, "near");
    expect(word(scene, 0, 23)).toBe(200);
  });

  it("re-resolves when a raster lands and the atlas revision moves", () => {
    const { scene, bumpRevision, view } = sceneWithSource(() => 0);
    scene.prepare(view, "near");
    expect(word(scene, 0, 23)).toBe(0);
    bumpRevision();
    scene.prepare(view, "near");
    expect(word(scene, 0, 23)).toBe(1);
  });

  it("keeps a shape record at no atlas cell", () => {
    const scene = sceneWith(() => [{
      key: "shell",
      kind: "shape",
      band: "cards",
      z: 1,
      rect: { x: 0, y: 0, width: 216, height: 56 },
      tiers: 15,
      scale: { kind: "board" },
      style: {},
    }]);
    expect(word(scene, 0, 23)).toBe(0xffffffff);
  });
});

describe("a connect in progress", () => {
  it("tells the painter every card is connecting on the way in and out", () => {
    const seen = new Map<string, boolean>();
    const scene = createScene({
      painter: (card, _live, view) => {
        seen.set(card.id, view.connecting === true);
        return { quads: [], dim: { opacity: 1, saturate: 1 }, lift: 0 };
      },
    });
    const b: CardFact = { id: "b", row: seat("b", { x: 400, y: 200 }), derived: { regionDepth: 0, blocked: false, z: 0 } };
    scene.apply({ kind: "load", canvas: asCanvasName("factory"), cards: [fact(), b], wires: [] });
    expect(seen.get("a")).toBe(false);
    scene.apply({ kind: "wireMode", mode: "connecting" });
    expect(seen.get("a")).toBe(true);
    expect(seen.get("b")).toBe(true);
    scene.apply({ kind: "wireMode", mode: "rest" });
    expect(seen.get("a")).toBe(false);
    expect(seen.get("b")).toBe(false);
  });
});

describe("the ring angle hook", () => {
  it("answers the ring's spin, not a band's turn that paints first", () => {
    const turning = (key: string, z: number, periodMs: number): Quad => ({
      key,
      kind: "sprite",
      band: "cards",
      z,
      rect: { x: 0, y: 0, width: 52, height: 52 },
      tiers: 15,
      scale: { kind: "board" },
      style: {},
      sprite: { atlas: "mark", cell: { col: 0, row: 0 } },
      motion: { kind: "turn", periodMs },
    });
    const scene = createScene({
      painter: () => ({
        quads: [turning("ring.band", 1, 2_400), turning("ring.spin", 3, 1_440)],
        dim: { opacity: 1, saturate: 1 },
        lift: 0,
      }),
    });
    scene.apply({ kind: "load", canvas: asCanvasName("factory"), cards: [fact()], wires: [] });
    // 360 ms into the spin's 1440 ms lap is a quarter turn, clockwise; the
    // band's slower lap would read 54 degrees.
    expect(scene.ringAngle("a", 360)).toBeCloseTo(90, 9);
  });
});

describe("the shader clock", () => {
  // Date.now() in a float32 uniform quantizes to about two minutes, so the
  // shader runs on page-relative milliseconds. A turning ring keeps the DOM's
  // wall phase by anchoring its record: now - (wall % period).
  const turning = (): Quad => ({
    key: "ring",
    kind: "shape",
    band: "cards",
    z: 1,
    rect: { x: 0, y: 0, width: 52, height: 52 },
    tiers: 15,
    scale: { kind: "board" },
    style: { fill: { kind: "flat", color: { token: "cyan" } } },
    motion: { kind: "turn", periodMs: 1_000 },
  });

  it("writes a page-relative instant whose phase matches the wall clock", () => {
    const scene = sceneWith(() => [turning()]);
    const wall = 1_700_000_000_123;
    scene.setClocks({ now: 250, wall });
    scene.apply({ kind: "selection", fact: { nodeIds: ["a"] } });
    const since = float(scene, 0, 21);
    expect(since).toBe(250 - (wall % 1_000));
    expect(((250 - since) % 1_000) / 1_000).toBeCloseTo((wall % 1_000) / 1_000, 6);
  });

  it("starts a style transition on the page-relative clock", () => {
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
    scene.setClocks({ now: 400, wall: 1_700_000_000_123 });
    scene.apply({ kind: "selection", fact: { nodeIds: ["a"] } });
    expect(float(scene, 0, 29)).toBe(400);
    expect(scene.hasMotion(401)).toBe(true);
    expect(scene.hasMotion(600)).toBe(false);
  });
});

describe("a theme switch", () => {
  it("repaints every card, so generated art is handed the new mode", () => {
    const painted: Array<{ id: string; mode: string }> = [];
    const scene = createScene({
      painter: (card, _live, view) => {
        painted.push({ id: card.id, mode: view.mode });
        return { quads: [], dim: { opacity: 1, saturate: 1 }, lift: 0 };
      },
    });
    const b: CardFact = { id: "b", row: seat("b", { x: 400, y: 200 }), derived: { regionDepth: 0, blocked: false, z: 0 } };
    scene.apply({ kind: "load", canvas: asCanvasName("factory"), cards: [fact(), b], wires: [] });
    painted.length = 0;
    scene.apply({ kind: "theme", mode: "bright" });
    expect(painted.map((entry) => entry.id).sort()).toEqual(["a", "b"]);
    expect(painted.every((entry) => entry.mode === "bright")).toBe(true);
  });
});

describe("a sprite's raster scale", () => {
  it("includes the scale-rule multiplier the shader draws it at", () => {
    const scales: number[] = [];
    const scene = createScene({
      painter: () => ({
        quads: [{
          key: "portrait",
          kind: "sprite",
          band: "cards",
          z: 1,
          rect: { x: 10, y: 10, width: 34, height: 34 },
          tiers: 15,
          scale: { kind: "seat", cap: 1.75, anchor: { x: 27, y: 27 } },
          style: {},
          sprite: { atlas: "mark", cell: { col: 0, row: 1 } },
        }],
        dim: { opacity: 1, saturate: 1 },
        lift: 0,
      }),
      source: (_quad, scale) => {
        scales.push(scale);
        return 3;
      },
      scale: () => 0.3,
      zoom: () => 0.3,
    });
    scene.apply({ kind: "load", canvas: asCanvasName("factory"), cards: [fact()], wires: [] });
    const near = scales.at(-1)!;
    scene.prepare({ x: -100, y: -100, width: 800, height: 600 }, "far");
    const far = scales.at(-1)!;
    // The far ring is drawn at farSeat times its board size, so the cell is
    // rasterized at that same scale; the camera scale alone reads blurry.
    expect(far).toBeCloseTo(atlasScale(0.3 * Math.min(farSeatScale(0.3), 1.75)), 9);
    expect(far).toBeGreaterThan(atlasScale(0.3));
    expect(near).toBeCloseTo(atlasScale(0.3), 9);
  });
});

describe("a live resize", () => {
  it("hands the painter the size the pointer holds, not the row it left", () => {
    const scene = createScene({
      painter: (drawn) => ({
        quads: [{
          key: "body",
          kind: "shape",
          band: "cards",
          z: 1,
          rect: { x: 0, y: 0, width: drawn.row.width, height: drawn.row.height },
          tiers: 15,
          scale: { kind: "board" },
          style: {},
        }],
        dim: { opacity: 1, saturate: 1 },
        lift: 0,
      }),
    });
    scene.apply({ kind: "load", canvas: asCanvasName("factory"), cards: [fact()], wires: [] });
    expect(float(scene, 0, 2)).toBe(200);
    scene.resizeCard("a", { x: 0, y: 0, width: 300, height: 80 });
    expect(float(scene, 0, 2)).toBe(300);
    expect(float(scene, 0, 3)).toBe(80);
    expect(scene.ownerBuffer[5]).toBe(300);
    expect(scene.ownerBuffer[6]).toBe(80);
  });
});

describe("a hovered part", () => {
  it("tells the painter which part the pointer is over, and repaints when it moves", () => {
    const seen: Array<string | undefined> = [];
    const scene = createScene({
      painter: (_fact, _live, view) => {
        seen.push(view.hoveredPart);
        return { quads: [], dim: { opacity: 1, saturate: 1 }, lift: 0 };
      },
    });
    scene.apply({ kind: "load", canvas: asCanvasName("factory"), cards: [fact()], wires: [] });
    scene.setHover("a", "regionFrame");
    expect(seen.at(-1)).toBe("regionFrame");
    scene.setHover("a", "regionTitle");
    expect(seen.at(-1)).toBe("regionTitle");
    scene.setHover("a");
    expect(seen.at(-1)).toBeUndefined();
  });
});

describe("a shadow's element hole", () => {
  it("packs the inset and gives each spec an offset in vec4s", () => {
    const shadowAt = (key: string, name: string, hole: number, z: number): Quad => ({
      key,
      kind: "shadow",
      band: "lifted",
      z,
      rect: { x: 0, y: 0, width: 100, height: 60 },
      tiers: 15,
      scale: { kind: "board" },
      radii: 8,
      hole,
      style: { shadow: { name, tint: { token: "green" } } },
    });
    const scene = sceneWith(() => [shadowAt("reach", "reach", 6, 70), shadowAt("far", "reach-far", 18, 71)]);
    expect(float(scene, 0, 31)).toBe(6);
    expect(float(scene, 1, 31)).toBe(18);
    const snapshot = scene.shadowSnapshot();
    // The reach is two layers at vec4 0; reach-far is one layer after those
    // four vec4s, not after two.
    expect(Array.from(snapshot.meta.slice(0, 8))).toEqual([2, 0, 0, 0, 1, 4, 0, 0]);
    expect(snapshot.layers.length).toBe(3 * 8);
  });
});
