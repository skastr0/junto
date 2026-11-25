import { describe, expect, it } from "vitest";
import { TIER_BIT, type Quad } from "../src/window/canvas/contract";
import { ringState, type RingStateInput } from "../src/shared/wire/rings";
import { gatheredIds, leadOf, paintClusters, planClusters, type ClusterInput, type ClusterSeatFact } from "../src/window/canvas/paint/cluster";
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
const KEY = "cluster:region:r1.";

describe("seat cluster grouping", () => {
  it("gathers every seat of an innermost region into one cluster, however far apart they sit", () => {
    const plan = planClusters(input([seat("a", 0, 0), seat("b", 60, 0), seat("c", 2000, 0)]));
    expect(plan.clusters.map((c) => c.members)).toEqual([["a", "b", "c"]]);
    expect(plan.clusters[0]).toMatchObject({ x: 686.6666666666666, y: 0, key: "region:r1" });
    expect([...plan.gathered].sort()).toEqual(["a", "b", "c"]);
  });

  it("is one cluster for each region, and a seat alone in its region is a cluster of one", () => {
    const seats = [seat("a", 0, 0), seat("b", 90, 0), seat("d", 90, 40, undefined, { region: "r2" }), seat("e", 5000, 0, undefined, { region: "r3" })];
    const plan = planClusters(input(seats));
    expect(plan.clusters.map((c) => [c.key, c.members])).toEqual([
      ["region:r1", ["a", "b"]],
      ["region:r2", ["d"]],
      ["region:r3", ["e"]],
    ]);
  });

  it("a region's cluster keeps its key while seats come and go, and does not part with the zoom", () => {
    const key = (seats: ClusterSeatFact[], zoom: number) => planClusters(input(seats, zoom)).clusters.map((c) => c.key);
    expect(key([seat("m", 0, 0), seat("n", 40, 0)], 0.25)).toEqual(["region:r1"]);
    expect(key([seat("a", 0, 0), seat("m", 0, 0), seat("n", 40, 0)], 1)).toEqual(["region:r1"]);
  });

  it("seats in no region gather only where they overlap, by the span at this zoom", () => {
    const free = (id: string, x: number) => seat(id, x, 0, undefined, { region: "" });
    // At zoom 0.25 the span is 104 board units.
    const plan = planClusters(input([free("a", 0), free("b", 60), free("c", 2000)]));
    expect(plan.clusters.map((c) => c.members)).toEqual([["a", "b"]]);
    expect(plan.clusters[0]).toMatchObject({ x: 30, y: 0, key: "a" });
    expect(plan.gathered.has("c")).toBe(false);
    // Where a floor ring fits between them, nothing gathers.
    expect(planClusters(input([free("a", 0), free("b", 60)], 1)).clusters).toEqual([]);
  });

  it("chains free seats by single linkage, and never joins them to a region's cluster", () => {
    const free = (id: string, x: number) => seat(id, x, 0, undefined, { region: "" });
    const plan = planClusters(input([free("a", 0), free("b", 90), free("c", 180), seat("d", 90, 40)]));
    expect(plan.clusters.map((c) => c.members)).toEqual([["a", "b", "c"], ["d"]]);
  });

  it("keeps no seat apart: a selected seat and seats whose ring calls, waits or halts gather with their region", () => {
    const seats = [
      seat("a", 0, 0),
      seat("call", 15, 0, { glyph: "call", tone: "amber" }),
      seat("halt", 10, 10, { glyph: "halt", tone: "crimson" }),
      seat("wait", 20, 10, { glyph: "rest", tone: "steel", signal: "escalate" }),
      seat("sel", 5, 5, undefined, { selected: true }),
    ];
    expect([...gatheredIds(input(seats))].sort()).toEqual(["a", "call", "halt", "sel", "wait"]);
  });

  it("has no ring budget: free seats a little over the span apart stay apart however many there are", () => {
    const seats = Array.from({ length: 40 }, (_, i) => seat(`s${String(i).padStart(2, "0")}`, i * 120, 0, undefined, { region: "" }));
    expect(gatheredIds(input(seats)).size).toBe(0);
  });
});

describe("the lead seat of a badge", () => {
  const lead = (...seats: ClusterSeatFact[]) => leadOf(seats)?.id;

  it("is the most urgent member by the urgency ladder", () => {
    const rest = seat("a", 0, 0);
    const work = seat("b", 0, 0, { glyph: "work", tone: "cyan" });
    const done = seat("c", 0, 0, { glyph: "done", tone: "green" });
    const call = seat("d", 0, 0, { glyph: "call", tone: "amber" });
    expect(lead(rest, work)).toBe("b");
    expect(lead(rest, work, done)).toBe("c");
    expect(lead(rest, work, done, call)).toBe("d");
  });

  it("breaks a tie by the latest ring change, then the smallest id", () => {
    const work = (id: string, ringSince: number) => seat(id, 0, 0, { glyph: "work", tone: "cyan" }, { ringSince });
    expect(lead(work("a", 1000), work("b", 2000))).toBe("b");
    expect(lead(work("b", 1000), work("a", 1000))).toBe("a");
  });

  it("is none for no members", () => {
    expect(leadOf([])).toBeUndefined();
  });
});

describe("seat cluster badges", () => {
  const two = (a: RingStateInput, b: RingStateInput) => [seat("a", 0, 0, a), seat("b", 60, 0, b)];
  const badge = (seats: ClusterSeatFact[], over: Partial<ClusterInput> = {}) => paintClusters(input(seats, 0.25, over), fakeEnv);
  const rest = { glyph: "rest", tone: "steel" } as const;

  it("paints a lifted badge at far and overview, held by the far seat scale about the centroid", () => {
    const quads = badge(two(rest, rest));
    expect(quads.length).toBeGreaterThan(5);
    for (const q of quads) {
      expect(q.band).toBe("lifted");
      expect(q.tiers).toBe(TIER_BIT.far | TIER_BIT.overview);
      expect(q.scale).toEqual({ kind: "seat", cap: 5.2, anchor: { x: 30, y: 0 } });
      expect(q.key.startsWith(KEY)).toBe(true);
    }
  });

  it("is a 40 unit disc with the member list and key as its hit part, and a 34 portrait in a 52 ring", () => {
    const quads = badge(two(rest, rest));
    const disc = get(quads, `${KEY}disc`);
    expect(disc.rect).toEqual({ x: 10, y: -20, width: 40, height: 40 });
    expect(disc.shape).toBe("disc");
    expect(disc.part).toEqual({ kind: "cluster", memberIds: ["a", "b"], key: "region:r1" });
    expect(get(quads, `${KEY}portrait`).rect).toMatchObject({ width: 34, height: 34 });
    expect(get(quads, `${KEY}ring.core`).rect).toMatchObject({ width: 52, height: 52 });
  });

  it("rim is the lead's hue: steel 70% at rest, cyan 85% working, green 85% done, amber 85% when it calls", () => {
    const rim = (a: RingStateInput, b: RingStateInput) => get(badge(two(a, b)), `${KEY}stack`).style.shadow;
    expect(rim(rest, rest)).toEqual({ name: "cluster", tint: { token: "steel", alpha: 0.7 } });
    expect(rim(rest, { glyph: "work", tone: "cyan" })).toEqual({ name: "cluster", tint: { token: "cyan", alpha: 0.85 } });
    expect(rim({ glyph: "done", tone: "green" }, { glyph: "work", tone: "cyan" })).toEqual({ name: "cluster", tint: { token: "green", alpha: 0.85 } });
    expect(rim({ glyph: "call", tone: "amber" }, { glyph: "work", tone: "cyan" })).toEqual({ name: "cluster", tint: { token: "amber", alpha: 0.85 } });
  });

  it("its ring is the lead's, moving on the shared period when it works", () => {
    const working = badge(two(rest, { glyph: "work", tone: "cyan" }));
    expect(get(working, `${KEY}ring.spin`).motion).toEqual({ kind: "turn", periodMs: 1440 });
    const resting = badge(two(rest, rest));
    expect(resting.some((q) => q.motion !== undefined && q.key.includes(".ring."))).toBe(false);
    const done = badge(two({ glyph: "done", tone: "green" }, rest));
    expect(get(done, `${KEY}ring.land`).motion).toEqual({ kind: "land", since: 1000 });
  });

  it("wears the far halo when the lead's ring calls, waits or halts, and not otherwise", () => {
    const halo = (ring: RingStateInput) => badge(two(ring, rest)).filter((q) => q.key.includes(".halo."));
    expect(halo(rest)).toEqual([]);
    expect(halo({ glyph: "work", tone: "cyan" })).toEqual([]);
    const call = halo({ glyph: "call", tone: "amber" });
    expect(call.map((q) => q.key)).toEqual([`${KEY}halo.outer`, `${KEY}halo.inner`]);
    expect(call[1]!.style.stroke).toEqual({ color: { token: "amber", alpha: 0.92 }, width: 2.5, outside: true });
    expect(halo({ glyph: "halt", tone: "crimson" })[1]!.style.stroke).toMatchObject({ color: { token: "crimson" } });
  });

  it("outlines the badge when any member is selected, else when it is hovered; selection wins", () => {
    const outline = (seats: ClusterSeatFact[], over: Partial<ClusterInput> = {}) => badge(seats, over).find((q) => q.key === `${KEY}outline`);
    expect(outline(two(rest, rest))).toBeUndefined();
    expect(outline(two(rest, rest), { hoveredKey: "region:r1" })?.style.stroke).toEqual({ color: { token: "ink", alpha: 0.45 }, width: 2, outside: true });
    const picked = [seat("a", 0, 0, rest, { selected: true }), seat("b", 60, 0, rest)];
    expect(outline(picked)?.style.stroke).toEqual({ color: { token: "main", alpha: 0.85 }, width: 3, outside: true });
    expect(outline(picked, { hoveredKey: "region:r1" })?.style.stroke).toMatchObject({ width: 3 });
  });

  it("counts the members in a 20 high mono badge at the disc's lower right", () => {
    const quads = badge(two(rest, rest));
    expect(get(quads, `${KEY}count.text`).text).toMatchObject({ text: "2", font: "mono", size: 12, weight: 700, tabular: true });
    const count = get(quads, `${KEY}count`);
    expect(count.rect.height).toBe(20);
    expect(count.rect.width).toBeGreaterThanOrEqual(20);
    expect(count.radii).toBe(10);
    expect(count.rect.x + count.rect.width).toBe(10 + 40 + 9);
    expect(count.rect.y + count.rect.height).toBe(-20 + 40 + 7);
  });

  it("draws the stack shadow for two or more members only, and counts one as 1", () => {
    const one = badge([seat("a", 0, 0)]);
    expect(one.some((q) => q.key.endsWith(".stack"))).toBe(false);
    expect(get(one, `${KEY}count.text`).text).toMatchObject({ text: "1" });
    expect(badge(two(rest, rest)).some((q) => q.key.endsWith(".stack"))).toBe(true);
  });

  it("the portrait is the lead's; the hovered cluster rides above the others", () => {
    const seats = [
      seat("a", 0, 0, rest, { portrait: { seed: "seed-a" } }),
      seat("b", 60, 0, { glyph: "work", tone: "cyan" }, { portrait: { seed: "seed-b" } }),
      seat("m", 5000, 0, undefined, { region: "r2" }),
      seat("n", 5060, 0, undefined, { region: "r2" }),
    ];
    const all = paintClusters(input(seats), fakeEnv);
    const sprite = get(all, `${KEY}portrait`).sprite;
    expect(sprite).toMatchObject({ atlas: "image" });
    expect((sprite as { key: string }).key).toContain("seed-b");
    const z = (key: string) => get(paintClusters(input(seats, 0.25, { hoveredKey: key }), fakeEnv), `cluster:${key}.disc`).z;
    expect(z("region:r2")).toBeGreaterThan(get(paintClusters(input(seats), fakeEnv), "cluster:region:r2.disc").z);
  });

  it("paints nothing when nothing gathers", () => {
    const free = (id: string, x: number) => seat(id, x, 0, undefined, { region: "" });
    expect(paintClusters(input([free("a", 0), free("b", 900)]), fakeEnv)).toEqual([]);
  });
});
