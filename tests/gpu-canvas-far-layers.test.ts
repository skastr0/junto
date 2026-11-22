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
import { farSeatScale, SEAT_SCALE_MAX, seatFloorScale } from "@shared/canvas-tier";
import { CLUSTER } from "../src/window/canvas/paint/cluster";
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
    // (the painter drops both at 0). The draw list keeps only the tier's own,
    // so one more quad draws at overview.
    settled = true;
    expect(scene.prepare(VIEW, "overview").visible).toBe(near + 1);

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

  /**
   * What the scene draws, in paint order: each ordered record's own words
   * with its owner's placement in place of the owner slot, and slot ids
   * (atlas cell, style ids, wall instants) left out, since two scenes number
   * those differently.
   */
  const picture = (scene: ReturnType<typeof createScene>): number[][] => {
    const rows: number[][] = [];
    const { f32 } = scene.quadBuffer;
    const words = new Uint32Array(f32.buffer);
    const skip = new Set([15, 21, 23, 27, 28, 29]);
    for (let index = 0; index < scene.orderCount; index += 1) {
      const at = scene.orderBuffer[index]! * 32;
      const row: number[] = [];
      for (let word = 0; word < 32; word += 1) if (!skip.has(word)) row.push(f32[at + word]!);
      const owner = words[at + 15]!;
      row.push(...scene.ownerBuffer.subarray(owner * 8, owner * 8 + 8));
      rows.push(row);
    }
    return rows;
  };

  it("draws a camera after a zoom sweep exactly as a fresh boot draws it", () => {
    const swept = clustered(0.3, "far").scene;
    for (const tier of ["overview", "mid", "near", "mid", "overview", "far"] as const) swept.prepare(VIEW, tier);
    const fresh = clustered(0.3, "far").scene;
    fresh.prepare(VIEW, "far");
    expect(picture(swept)).toEqual(picture(fresh));
    expect(swept.clusterAt({ x: 148, y: 28 })).toEqual(fresh.clusterAt({ x: 148, y: 28 }));
  });

  it("paints the badge again on the way back to far, after near released it", () => {
    const { scene } = clustered(0.3, "far");
    const far = scene.prepare(VIEW, "far").visible;
    expect(far).toBeGreaterThan(3);
    expect(scene.prepare(VIEW, "near").visible).toBe(3);
    // Same plan, same signature: the released badge must still draw its quads.
    expect(scene.prepare(VIEW, "far").visible).toBe(far);
    expect(scene.clusterAt({ x: 148, y: 28 })).toEqual(["a", "b", "c"]);
  });

  it("regroups a dragged seat once, on drop, not on every drag frame (issue 915)", () => {
    const { scene, facts } = clustered(0.3, "far");
    // The pointer carries c far off: the plan keeps it where its row is.
    for (const x of [300, 900, 2000]) {
      scene.moveCard("c", { x, y: 0 });
      scene.prepare(VIEW, "far");
      expect(scene.clusterAt({ x: 148, y: 28 })).toEqual(["a", "b", "c"]);
    }
    // The writer's fact lands at the drop: now c parts and a and b stay.
    const c = facts[2]!;
    scene.apply({ kind: "card", fact: { ...c, row: { ...c.row, x: 2000 } } as CardFact });
    scene.prepare(VIEW, "far");
    expect(scene.clusterAt({ x: 128, y: 28 })).toEqual(["a", "b"]);
  });

  it("picks a badge across the disc it draws, at the seat scale, at far and overview (issue 912)", () => {
    for (const [zoom, tier] of [[0.3, "far"], [0.08, "overview"]] as const) {
      const { scene } = clustered(zoom, tier);
      const [badge] = scene.clusters();
      expect(badge).toBeDefined();
      const scale = tier === "far" ? Math.max(1, Math.min(farSeatScale(zoom), SEAT_SCALE_MAX)) : Math.max(seatFloorScale(zoom), Math.min(farSeatScale(zoom), SEAT_SCALE_MAX));
      expect(scale).toBeGreaterThan(1);
      // The radius the hook maps to the page is the drawn disc's.
      expect(badge!.radius).toBeCloseTo((CLUSTER.disc / 2) * scale, 6);
      // Just inside the drawn disc, well outside the board disc: the badge answers.
      for (const angle of [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2]) {
        const at = { x: badge!.x + Math.cos(angle) * badge!.radius * 0.9, y: badge!.y + Math.sin(angle) * badge!.radius * 0.9 };
        expect(scene.clusterAt(at), `${tier} at ${angle.toFixed(2)}`).toEqual(["a", "b", "c"]);
      }
      // Past the drawn disc: the pane.
      expect(scene.clusterAt({ x: badge!.x + badge!.radius * 1.1, y: badge!.y })).toBeUndefined();
    }
  });

  it("counts in-view seats nothing draws, and leaves none after a run of selections (issue 912)", () => {
    const { scene } = clustered(0.3, "far");
    // All three gathered into one drawn badge: every seat reachable.
    expect(scene.seatStats()).toMatchObject({ inView: 3, unshown: 0, badgesInView: 1 });
    // The proof's pass: select each seat in turn, clear, and come back from near.
    for (const id of ["a", "b", "c", "a"]) {
      scene.apply({ kind: "selection", fact: { nodeIds: [id] } });
      scene.prepare(VIEW, "far");
      expect(scene.seatStats().unshown).toBe(0);
    }
    scene.apply({ kind: "selection", fact: { nodeIds: [] } });
    scene.prepare(VIEW, "near");
    scene.prepare(VIEW, "overview");
    scene.prepare(VIEW, "far");
    expect(scene.seatStats()).toMatchObject({ unshown: 0, badgesInView: 1 });
    expect(scene.clusterAt({ x: 148, y: 28 })).toEqual(["a", "b", "c"]);
  });

  it("sees a seat whose own quads this tier does not draw", () => {
    const scene = createScene({
      painter: (fact, live, cardView) => {
        const painted = oneQuad(fact, live, cardView);
        // c paints only at near: at far nothing stands for it.
        return fact.id === "c" ? { ...painted, quads: painted.quads.map((quad) => ({ ...quad, tiers: 1 })) } : painted;
      },
      zoom: () => 2,
    });
    const facts = [seats()[0]!, { ...seats()[2]!, row: { ...seats()[2]!.row, x: 600 } } as CardFact];
    load(scene, facts);
    for (const fact of facts) scene.apply({ kind: "seat", id: fact.id, live: work() });
    scene.prepare(VIEW, "far");
    // Neither gathered (too far apart at zoom 2): a draws, c draws nothing, and
    // neither paints a portrait.
    expect(scene.seatStats()).toMatchObject({ inView: 2, unshown: 1, unshownIds: ["c"], portraitsMissing: 1 });
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

describe("the far pick follows what is drawn (issue 912)", () => {
  /** A seat painter with one ring quad at the seat scale, as paintCard draws a ring. */
  const ring = (_fact: CardFact, _live: SeatLive | undefined, _view: CardView): ReturnType<typeof oneQuad> => ({
    quads: [
      {
        key: "ring",
        kind: "shape",
        band: "cards",
        z: 1,
        rect: { x: 2, y: 2, width: 52, height: 52 },
        tiers: ALL_TIERS,
        scale: { kind: "seat", cap: SEAT_SCALE_MAX, anchor: { x: 28, y: 28 } },
        style: {},
      },
    ],
    dim: { opacity: 1, saturate: 1 },
    lift: 0,
  });

  // At zoom 0.3 a ring is drawn 2.6 times its size about its box: b's ring
  // reaches over the right end of a's stored rectangle, where a's own ring
  // does not reach. The two are too far apart to gather.
  const ZOOM = 0.3;
  const facts = (): CardFact[] => [
    { ...agentFact(), id: "b", row: { ...agentFact().row, id: "b", x: 150, y: 60 } } as CardFact,
    { ...agentFact(), id: "a", row: { ...agentFact().row, id: "a", x: 0, y: 0 } } as CardFact,
  ];
  const drawnWorld = (scene: ReturnType<typeof createScene>): PickWorld => ({
    index: scene.index,
    card: scene.cardOf,
    wire: () => undefined,
    selection: { nodeIds: [] },
    scale: ZOOM,
    tier: "far",
    wireMode: "rest",
    clusterAt: scene.clusterAt,
    drawn: { reach: scene.drawnReach(), at: scene.drawnAt },
  });
  const board = () => {
    const scene = createScene({ painter: ring, zoom: () => ZOOM });
    load(scene, facts());
    for (const fact of facts()) scene.apply({ kind: "seat", id: fact.id, live: work() });
    scene.prepare({ x: -400, y: -400, width: 1200, height: 900 }, "far");
    return scene;
  };

  it("answers the seat whose ring is drawn under the press, not the card whose stored rectangle is", () => {
    const scene = board();
    expect(scene.clusters()).toEqual([]);
    const at = { x: 205, y: 40 };
    expect(scene.drawnAt("a", at)).toBe(false);
    expect(scene.drawnAt("b", at)).toBe(true);
    expect(pickAt(drawnWorld(scene), at)).toMatchObject({ nodeId: "b", part: { kind: "body" } });
  });

  it("answers a seat across its whole drawn ring, past its stored rectangle", () => {
    const scene = board();
    // Below b's stored rectangle (which ends at y 116) but inside its ring.
    expect(pickAt(drawnWorld(scene), { x: 253, y: 140 })).toMatchObject({ nodeId: "b" });
    // Past every ring: the pane.
    expect(pickAt(drawnWorld(scene), { x: 600, y: 600 }).part).toEqual({ kind: "pane" });
  });
});

describe("badges are built near the view (issue 912)", () => {
  /** Two gathered groups of three, one at the origin and one 50,000 out. */
  const board = () => {
    const scene = createScene({ painter: oneQuad, zoom: () => 0.3 });
    const out = seats().map((fact) => ({ ...fact, id: `far-${fact.id}`, row: { ...fact.row, id: `far-${fact.id}`, x: fact.row.x + 50_000 } }) as CardFact);
    const facts = [...seats(), ...out];
    load(scene, facts);
    for (const fact of facts) scene.apply({ kind: "seat", id: fact.id, live: work() });
    return scene;
  };
  const members = (scene: ReturnType<typeof createScene>): string[][] => scene.clusters().map((badge) => [...badge.memberIds].sort());

  it("builds only the badge whose disc meets the view, and the other once the view comes to it", () => {
    const scene = board();
    scene.prepare(VIEW, "far");
    expect(members(scene)).toEqual([["a", "b", "c"]]);
    scene.prepare({ ...VIEW, x: VIEW.x + 50_000 }, "far");
    // The one built at the origin stays built; the one the view reached is built now.
    expect(members(scene).sort()).toEqual([["a", "b", "c"], ["far-a", "far-b", "far-c"]]);
    expect(scene.clusterAt({ x: 50_148, y: 28 })).toEqual(["far-a", "far-b", "far-c"]);
  });

  it("builds the reached badge on a return from near too", () => {
    const scene = board();
    scene.prepare(VIEW, "far");
    scene.prepare(VIEW, "near");
    scene.prepare({ ...VIEW, x: VIEW.x + 50_000 }, "far");
    expect(members(scene)).toEqual([["far-a", "far-b", "far-c"]]);
  });
});
