import { describe, expect, it } from "vitest";
import { TIER_BIT, type Quad } from "../src/window/canvas/contract";
import { ringState, type RingStateInput } from "../src/shared/wire/rings";
import { gatheredIds, keepsApart, paintClusters, planClusters, type ClusterInput, type ClusterSeatFact } from "../src/window/canvas/paint/cluster";
import { fakeEnv } from "./canvas-paint-fixtures";

const VIEW = { width: 1920, height: 1080 };
const seat = (id: string, x: number, y: number, ring: RingStateInput = { glyph: "rest", tone: "steel" }, over: Partial<ClusterSeatFact> = {}): ClusterSeatFact => ({
  id,
  x,
  y,
  region: "r1",
  ring: ringState(ring),
  ringSince: 1000,
  selected: false,
  ...over,
});
const input = (seats: ClusterSeatFact[], zoom = 0.25, over: Partial<ClusterInput> = {}): ClusterInput => ({ seats, zoom, view: VIEW, mode: "dark", ...over });
const get = (quads: ReadonlyArray<Quad>, key: string): Quad => quads.find((q) => q.key === key)!;

describe("seat cluster grouping", () => {
  it("gathers seats closer than the floor ring plus a gap (26 screen px) and leaves distant ones", () => {
    // At zoom 0.25 the span is 104 board units.
    const plan = planClusters(input([seat("a", 0, 0), seat("b", 60, 0), seat("c", 2000, 0)]));
    expect(plan.clusters.map((c) => c.members)).toEqual([["a", "b"]]);
    expect(plan.clusters[0]).toMatchObject({ x: 30, y: 0, key: "a" });
    expect([...plan.gathered].sort()).toEqual(["a", "b"]);
  });

  it("chains by single linkage inside one region only", () => {
    const seats = [seat("a", 0, 0), seat("b", 90, 0), seat("c", 180, 0), seat("d", 90, 40, undefined, { region: "r2" })];
    const plan = planClusters(input(seats));
    expect(plan.clusters.map((c) => c.members)).toEqual([["a", "b", "c"]]);
    expect(plan.gathered.has("d")).toBe(false);
  });

  it("nothing gathers at the zoom where the floor ring fits between seats", () => {
    expect(planClusters(input([seat("a", 0, 0), seat("b", 60, 0)], 1)).clusters).toEqual([]);
  });

  it("selected seats and seats whose ring is call, wait or halt are never gathered", () => {
    const seats = [
      seat("a", 0, 0),
      seat("b", 30, 0),
      seat("call", 15, 0, { glyph: "call", tone: "amber" }),
      seat("halt", 10, 10, { glyph: "halt", tone: "crimson" }),
      seat("wait", 20, 10, { glyph: "rest", tone: "steel", signal: "escalate" }),
      seat("sel", 5, 5, undefined, { selected: true }),
    ];
    expect(seats.filter(keepsApart).map((s) => s.id).sort()).toEqual(["call", "halt", "sel", "wait"]);
    const gathered = gatheredIds(input(seats));
    expect([...gathered].sort()).toEqual(["a", "b"]);
  });

  it("past the ring budget the closest seats gather even when no pair is close", () => {
    // 40 seats 120 units apart (over the 104 span) on a board about one screen wide at 0.25.
    const seats = Array.from({ length: 40 }, (_, i) => seat(`s${String(i).padStart(2, "0")}`, i * 120, 0));
    const gathered = gatheredIds(input(seats));
    expect(gathered.size).toBeGreaterThan(0);
    const clusters = planClusters(input(seats)).clusters;
    // The board then draws at most 12 rings a screen, clusters and seats alike.
    const rings = seats.length - gathered.size + clusters.length;
    expect(rings).toBeLessThanOrEqual(Math.max(12, 12 * ((39 * 120 * 0.25) / 1920)));
  });
});

describe("seat cluster badges", () => {
  const two = (a: RingStateInput, b: RingStateInput) => [seat("a", 0, 0, a), seat("b", 60, 0, b)];
  const badge = (seats: ClusterSeatFact[], over: Partial<ClusterInput> = {}) => paintClusters(input(seats, 0.25, over), fakeEnv);

  it("paints a lifted badge at far and overview, held by the far seat scale about the centroid", () => {
    const quads = badge(two({ glyph: "rest", tone: "steel" }, { glyph: "rest", tone: "steel" }));
    expect(quads.length).toBeGreaterThan(5);
    for (const q of quads) {
      expect(q.band).toBe("lifted");
      expect(q.tiers).toBe(TIER_BIT.far | TIER_BIT.overview);
      expect(q.scale).toEqual({ kind: "seat", cap: 5.2, anchor: { x: 30, y: 0 } });
      expect(q.key.startsWith("cluster:a.")).toBe(true);
    }
  });

  it("is a 40 unit disc with the member list as its hit part, and a 34 portrait in a 52 ring", () => {
    const quads = badge(two({ glyph: "rest", tone: "steel" }, { glyph: "rest", tone: "steel" }));
    const disc = get(quads, "cluster:a.disc");
    expect(disc.rect).toEqual({ x: 10, y: -20, width: 40, height: 40 });
    expect(disc.shape).toBe("disc");
    expect(disc.part).toEqual({ kind: "cluster", memberIds: ["a", "b"] });
    expect(get(quads, "cluster:a.portrait").rect).toMatchObject({ width: 34, height: 34 });
    expect(get(quads, "cluster:a.ring.core").rect).toMatchObject({ width: 52, height: 52 });
  });

  it("rim hue: steel 70% at rest, cyan 85% working, green 85% done", () => {
    const rim = (a: RingStateInput, b: RingStateInput) => get(badge(two(a, b)), "cluster:a.stack").style.shadow;
    const rest = { glyph: "rest", tone: "steel" } as const;
    expect(rim(rest, rest)).toEqual({ name: "cluster", tint: { token: "steel", alpha: 0.7 } });
    expect(rim(rest, { glyph: "work", tone: "cyan" })).toEqual({ name: "cluster", tint: { token: "cyan", alpha: 0.85 } });
    expect(rim({ glyph: "done", tone: "green" }, { glyph: "work", tone: "cyan" })).toEqual({ name: "cluster", tint: { token: "green", alpha: 0.85 } });
  });

  it("its ring is the member's busiest state, moving on the shared period when working", () => {
    const working = badge(two({ glyph: "rest", tone: "steel" }, { glyph: "work", tone: "cyan" }));
    expect(get(working, "cluster:a.ring.spin").motion).toEqual({ kind: "turn", periodMs: 1440 });
    const resting = badge(two({ glyph: "rest", tone: "steel" }, { glyph: "rest", tone: "steel" }));
    expect(resting.some((q) => q.motion !== undefined && q.key.includes(".ring."))).toBe(false);
    const done = badge(two({ glyph: "done", tone: "green" }, { glyph: "rest", tone: "steel" }));
    expect(get(done, "cluster:a.ring.land").motion).toEqual({ kind: "land", since: 1000 });
  });

  it("counts the members in a 20 high mono badge at the disc's lower right", () => {
    const quads = badge(two({ glyph: "rest", tone: "steel" }, { glyph: "rest", tone: "steel" }));
    expect(get(quads, "cluster:a.count.text").text).toMatchObject({ text: "2", font: "mono", size: 12, weight: 700, tabular: true });
    const count = get(quads, "cluster:a.count");
    expect(count.rect.height).toBe(20);
    expect(count.rect.width).toBeGreaterThanOrEqual(20);
    expect(count.radii).toBe(10);
    expect(count.rect.x + count.rect.width).toBe(10 + 40 + 9);
    expect(count.rect.y + count.rect.height).toBe(-20 + 40 + 7);
  });

  it("the portrait is the first member's; the hovered cluster rides above the others", () => {
    const seats = [seat("a", 0, 0, undefined, { portrait: { seed: "seed-a" } }), seat("b", 60, 0), seat("m", 5000, 0), seat("n", 5060, 0)];
    const all = paintClusters(input(seats), fakeEnv);
    const sprite = get(all, "cluster:a.portrait").sprite;
    expect(sprite).toMatchObject({ atlas: "image" });
    expect((sprite as { key: string }).key).toContain("seed-a");
    const z = (key: string) => get(paintClusters(input(seats, 0.25, { hoveredKey: key }), fakeEnv), `cluster:${key}.disc`).z;
    expect(z("m")).toBeGreaterThan(get(paintClusters(input(seats), fakeEnv), "cluster:m.disc").z);
  });

  it("paints nothing when nothing gathers", () => {
    expect(paintClusters(input([seat("a", 0, 0), seat("b", 900, 0)]), fakeEnv)).toEqual([]);
  });
});
