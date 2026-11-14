// The far canvas's two derived layers: region watermarks step with the zoom
// (`region-glance.ts` into `CardView.glance`) and seat clusters replace
// gathered rings (inventory 3). Both are facts the scene derives; the paint
// modules were written with no caller until here.

import { describe, expect, it } from "vitest";
import { asCanvasName } from "@shared/model";
import { ringState } from "@shared/wire/rings";
import type { CardFact, CardView, PaintEnv, Quad, SeatLive } from "../src/window/canvas/contract";
import { ALL_TIERS } from "../src/window/canvas/contract";
import { createScene } from "../src/window/canvas/engine/scene";
import { pickAt, type PickWorld } from "../src/window/canvas/engine/pick";
import { paintCard } from "../src/window/canvas/paint";
import { agentFact, fakeEnv, regionFact, seatLive, view } from "./canvas-paint-fixtures";

const VIEW: { x: number; y: number; width: number; height: number } = { x: -200, y: -200, width: 800, height: 600 };
const SLOT = { rect: { x: 40, y: 120, width: 320, height: 40 }, fontSize: 36, nested: false };

const load = (scene: ReturnType<typeof createScene>, cards: ReadonlyArray<CardFact>): void => {
  scene.apply({ kind: "load", canvas: asCanvasName("factory"), cards, wires: [] });
};

/** A seat card painter with one quad per card, so a gathered seat's absence is countable. */
const oneQuad = (_fact: CardFact, _live: SeatLive | undefined, cardView: CardView): { quads: ReadonlyArray<Quad>; dim: { opacity: number; saturate: number }; lift: number } => ({
  quads: [
    {
      key: "body",
      kind: "shape",
      band: "cards",
      z: 1,
      rect: { x: 0, y: 0, width: 216, height: 56 },
      tiers: ALL_TIERS,
      scale: { kind: "board" },
      style: {},
    },
  ],
  dim: { opacity: 1, saturate: 1 },
  lift: 0,
});

const work = (): SeatLive => ({
  ring: ringState({ glyph: "work", tone: "cyan" }),
  line: "running",
  mark: { tone: "cyan", label: "working" },
  urgency: 0,
  running: true,
  overseer: false,
  ringSince: 1_000,
});

const seats = (): CardFact[] => [
  { ...agentFact(), id: "a", row: { ...agentFact().row, id: "a", x: 0, y: 0 } } as CardFact,
  { ...agentFact(), id: "b", row: { ...agentFact().row, id: "b", x: 40, y: 0 } } as CardFact,
  { ...agentFact(), id: "c", row: { ...agentFact().row, id: "c", x: 80, y: 0 } } as CardFact,
];

describe("region watermarks at a distance", () => {
  it("bakes the glance opacities into the region's name, and steps them only at rest", () => {
    let glance = { region: 0, sub: 0 };
    let settled = true;
    let zoom = 1.35;
    const scene = createScene({
      painter: (fact, live, cardView, env) => paintCard(fact, live, cardView, env),
      glance: () => glance,
      settled: () => settled,
      zoom: () => zoom,
      measure: fakeEnv.measure,
    });
    load(scene, [regionFact({ label: "Alpha", nameSlot: SLOT })]);

    const near = scene.prepare(VIEW, "overview").visible;
    // No watermark while the zoom is close.
    expect(near).toBeGreaterThan(0);

    // A pull-back to a far zoom with motion still running: the name waits.
    zoom = 0.5;
    settled = false;
    glance = { region: 1, sub: 1 };
    expect(scene.prepare(VIEW, "overview").visible).toBe(near);

    // At rest the watermark's two quads appear: the near name and the far one
    // (the painter drops both at 0; the tier mask picks which draws).
    settled = true;
    expect(scene.prepare(VIEW, "overview").visible).toBe(near + 2);

    // Zooming back in clears it again, at rest.
    zoom = 1.35;
    glance = { region: 0, sub: 0 };
    expect(scene.prepare(VIEW, "overview").visible).toBe(near);
  });
});

describe("seat clusters at far and overview", () => {
  const clustered = (zoom: number, tier: "far" | "overview") => {
    const scene = createScene({ painter: oneQuad, zoom: () => zoom });
    const facts = seats();
    load(scene, facts);
    for (const fact of facts) scene.apply({ kind: "seat", id: fact.id, live: work() });
    return { scene, facts, prepared: scene.prepare(VIEW, tier), zoom, tier };
  };

  it("parts every seat at near, and gathers the close ones into one badge at far", () => {
    const { scene } = clustered(0.3, "far");
    // The badge's own quads: more than the three seat quads it replaced.
    expect(scene.prepare(VIEW, "far").visible).toBeGreaterThan(3);
    // One badge at the seats' centroid stands for all three.
    expect(scene.clusterAt({ x: 148, y: 28 })).toEqual(["a", "b", "c"]);
    // Gathered seats answer no pointer, as the DOM's hidden nodes do.
    expect(scene.index.cardsAt({ x: 108, y: 28 })).toEqual([]);
    // The badge's ring turns even though the seat painter drew no motion.
    expect(scene.hasMotion()).toBe(true);

    // At near the same board draws its three seats and no badge.
    const near = scene.prepare(VIEW, "near").visible;
    expect(near).toBe(3);
    expect(scene.clusterAt({ x: 148, y: 28 })).toBeUndefined();
    expect(scene.index.cardsAt({ x: 108, y: 28 })).toEqual(["a", "b", "c"]);
  });

  it("a selected seat stays apart, so the rest regroup around it", () => {
    const { scene, facts } = clustered(0.3, "far");
    scene.apply({ kind: "selection", fact: { nodeIds: ["a"] } });
    scene.prepare(VIEW, "far");
    // a draws its own card; b and c still gather.
    expect(scene.clusterAt({ x: 108, y: 28 })).toBeUndefined();
    expect(scene.clusterAt({ x: 168, y: 28 })).toEqual(["b", "c"]);
    expect(scene.index.cardsAt({ x: 108, y: 28 })).toEqual(["a"]);
    expect(facts).toHaveLength(3);
  });

  it("a ring that calls never gathers", () => {
    const scene = createScene({ painter: oneQuad, zoom: () => 0.3 });
    const facts = seats();
    load(scene, facts);
    for (const fact of facts) {
      const live = work();
      const calling = fact.id === "a" ? { ...live, ring: ringState({ glyph: "call", tone: "amber" }) } : live;
      scene.apply({ kind: "seat", id: fact.id, live: calling });
    }
    scene.prepare(VIEW, "far");
    expect(scene.clusterAt({ x: 108, y: 28 })).toBeUndefined();
    expect(scene.clusterAt({ x: 168, y: 28 })).toEqual(["b", "c"]);
  });
});

describe("the cluster hit", () => {
  const world = (clusterAt?: (at: { x: number; y: number }) => ReadonlyArray<string> | undefined): PickWorld => ({
    index: { cardsAt: () => [], cardsNear: () => [], wiresAt: () => [] },
    card: () => undefined,
    wire: () => undefined,
    selection: { nodeIds: [] },
    scale: 1,
    tier: "far",
    wireMode: "rest",
    ...(clusterAt === undefined ? {} : { clusterAt }),
  });

  it("answers before the cards, with the badge's members and no card id", () => {
    const hit = pickAt(world(() => ["a", "b"]), { x: 10, y: 10 });
    expect(hit).toEqual({ part: { kind: "cluster", memberIds: ["a", "b"] }, at: { x: 10, y: 10 } });
  });

  it("falls through to the pane where no badge is", () => {
    expect(pickAt(world(() => undefined), { x: 10, y: 10 }).part).toEqual({ kind: "pane" });
    expect(pickAt(world(), { x: 10, y: 10 }).part).toEqual({ kind: "pane" });
  });

  it("never lets a gathered card answer under the badge", () => {
    // The scene's index drops gathered cards; this is the same world with one
    // card that is not gathered, to show picking still works beside the badge.
    const hit = pickAt(
      {
        ...world(() => undefined),
        index: { cardsAt: () => ["a"], cardsNear: () => ["a"], wiresAt: () => [] },
        card: () => agentFact(),
      },
      { x: 110, y: 210 },
    );
    expect(hit.part.kind).toBe("body");
  });
});
