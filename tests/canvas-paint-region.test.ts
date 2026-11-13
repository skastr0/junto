import { describe, expect, it } from "vitest";
import { TIER_BIT, type CardFact, type Quad } from "../src/window/canvas/contract";
import { paintRegion } from "../src/window/canvas/paint/region";
import { fakeEnv, regionFact, view } from "./canvas-paint-fixtures";

const GLANCE = { region: 1, sub: 1 };
const NONE = { region: 0, sub: 0 };
const paint = (fact: CardFact, v = view(), glance = GLANCE) => paintRegion(fact, v, fakeEnv, glance);
const at = (quads: ReadonlyArray<Quad>, tier: keyof typeof TIER_BIT): ReadonlyArray<Quad> =>
  quads.filter((q) => (q.tiers & TIER_BIT[tier]) !== 0);
const keys = (quads: ReadonlyArray<Quad>): string[] => quads.map((q) => q.key);
const get = (quads: ReadonlyArray<Quad>, key: string): Quad => quads.find((q) => q.key === key)!;
const SLOT = { rect: { x: 100, y: 100, width: 200, height: 80 }, fontSize: 48, nested: false };

describe("region paint", () => {
  it("draws every quad in the regions band", () => {
    const { quads } = paint(regionFact({ label: "web", color: "5" }));
    expect(quads.every((q) => q.band === "regions" || q.band === "lifted")).toBe(true);
    expect(quads.filter((q) => q.band === "regions").length).toBeGreaterThan(5);
  });

  it("fills by tier: gradient near, flat mid, hue wash far; outlines 3, 6 and 10 units", () => {
    const { quads } = paint(regionFact({ color: "5" }));
    expect(keys(at(quads, "near"))).toContain("fill.near");
    expect(get(quads, "fill.near").style.fill).toMatchObject({ kind: "gradient", angle: 135 });
    expect(get(quads, "fill.mid").style.fill).toEqual({ kind: "flat", color: { token: "cyan", alpha: 0.07 } });
    expect(get(quads, "outline.mid").style.stroke).toMatchObject({ width: 3, color: { token: "cyan", alpha: 0.4 } });
    expect(get(quads, "outline.far").style.stroke).toMatchObject({ width: 6, color: { token: "cyan", alpha: 0.62 } });
    expect(get(quads, "outline.overview").style.stroke?.width).toBe(10);
    expect(keys(at(quads, "near"))).not.toContain("outline.mid");
    expect(keys(at(quads, "mid"))).not.toContain("fill.near");
  });

  it("an uncoloured region wears the ink: raise over ground near, 16% mid, 4% wash and 34% outline far", () => {
    const { quads } = paint(regionFact());
    expect(get(quads, "fill.near").style.fill).toEqual({ kind: "gradient", angle: 135, from: { token: "raise", alpha: 0.22 }, to: { token: "ground", alpha: 0.12 } });
    expect(get(quads, "fill.mid").style.fill).toEqual({ kind: "flat", color: { token: "raise", alpha: 0.16 } });
    expect(get(quads, "fill.far").style.fill).toEqual({ kind: "flat", color: { token: "ink", alpha: 0.04 } });
    expect(get(quads, "outline.far").style.stroke?.color).toEqual({ token: "ink", alpha: 0.34 });
  });

  it("a nested coloured region washes at 5%, an outermost one at 8%", () => {
    const wash = (depth: number) => (get(paint(regionFact({ color: "5", depth })).quads, "fill.far").style.fill as { color: { alpha: number } }).color.alpha;
    expect(wash(0)).toBe(0.08);
    expect(wash(1)).toBe(0.05);
  });

  it("hides depth 3 and below at the overview only", () => {
    for (const depth of [0, 1, 2]) {
      expect(at(paint(regionFact({ depth, label: "x", nameSlot: SLOT })).quads, "overview").length).toBeGreaterThan(0);
    }
    for (const depth of [3, 5]) {
      const { quads } = paint(regionFact({ depth, label: "x", nameSlot: SLOT }));
      expect(at(quads, "overview")).toEqual([]);
      expect(at(quads, "far").length).toBeGreaterThan(0);
    }
  });

  it("selection: amber 60% border and a 1px ring near, an amber 80% outline below, no frame strips", () => {
    const { quads } = paint(regionFact({ color: "5" }), view({ selected: true }));
    expect(get(quads, "border").style.stroke?.color).toEqual({ token: "amber", alpha: 0.6 });
    expect(get(quads, "border.ring").style.stroke).toMatchObject({ outside: true, color: { token: "amber", alpha: 0.18 } });
    for (const key of ["outline.mid", "outline.far", "outline.overview"]) {
      expect(get(quads, key).style.stroke?.color).toEqual({ token: "amber", alpha: 0.8 });
    }
    expect(keys(quads).filter((k) => k.startsWith("strip."))).toEqual([]);
  });

  it("the border is stroke when uncoloured, the accent at 32% coloured, a custom hex as stored", () => {
    expect(get(paint(regionFact()).quads, "border").style.stroke?.color).toEqual({ token: "stroke" });
    expect(get(paint(regionFact({ color: "5" })).quads, "border").style.stroke?.color).toEqual({ token: "cyan", alpha: 0.32 });
    expect(get(paint(regionFact({ color: "#123456" })).quads, "border").style.stroke?.color).toEqual({ custom: "#123456" });
    expect(get(paint(regionFact(), view({ hoveredPart: "regionFrame" })).quads, "border").style.stroke?.color).toEqual({ token: "amber", alpha: 0.42 });
  });

  it("title bar is 24 high and takes the pointer; strips are 12 wide; hover washes them amber", () => {
    const { quads } = paint(regionFact({ width: 400, height: 300 }));
    expect(get(quads, "title").rect).toEqual({ x: 0, y: 0, width: 400, height: 24 });
    expect(get(quads, "title").part).toEqual({ kind: "regionTitle" });
    expect(get(quads, "strip.left").rect).toEqual({ x: 0, y: 24, width: 12, height: 276 });
    expect(get(quads, "strip.right").rect.x).toBe(388);
    expect(get(quads, "strip.bottom").rect).toEqual({ x: 0, y: 288, width: 400, height: 12 });
    expect(get(quads, "strip.left").part).toEqual({ kind: "regionFrame" });
    expect(get(quads, "title").style).toEqual({});
    expect(get(paint(regionFact(), view({ hoveredPart: "regionTitle" })).quads, "title").style.fill).toEqual({ kind: "flat", color: { token: "amber", alpha: 0.06 } });
    expect(get(paint(regionFact(), view({ hoveredPart: "regionFrame" })).quads, "strip.left").style.fill).toEqual({ kind: "flat", color: { token: "amber", alpha: 0.07 } });
    // The title's label and bar fill are near and mid only; its hit area stays at far.
    expect(keys(at(quads, "far"))).toContain("title.far");
    expect(keys(at(quads, "far"))).not.toContain("title.label");
  });

  it("names an unnamed region 'unnamed region' in the bar and prints no name at a distance", () => {
    const { quads } = paint(regionFact({ nameSlot: SLOT }));
    expect(get(quads, "title.label").text?.text).toBe("unnamed region");
    expect(keys(quads)).not.toContain("name");
    expect(get(paint(regionFact({ label: "web" })).quads, "title.label").text).toMatchObject({ text: "web", font: "mono", size: 12, weight: 600 });
  });

  it("the lock shows for a held region and the warning past the depth limit", () => {
    expect(keys(paint(regionFact({ hold: true })).quads)).toContain("title.lock");
    expect(keys(paint(regionFact()).quads)).not.toContain("title.lock");
    expect(keys(paint(regionFact({ depth: 9 })).quads)).toContain("title.warn");
    expect(keys(paint(regionFact({ depth: 8 })).quads)).not.toContain("title.warn");
  });

  it("the name fades by glance: 0 prints nothing, 1 prints at full, nested rides the sub band", () => {
    const f = regionFact({ label: "web", nameSlot: SLOT });
    expect(keys(paint(f, view(), NONE).quads)).not.toContain("name");
    const full = paint(f, view(), GLANCE).quads;
    expect(get(full, "name").style.opacity).toBe(1);
    expect(get(full, "name").text).toMatchObject({ font: "display", size: 48, upper: true, tracking: 0.1 });
    const nested = paint(regionFact({ label: "web", nameSlot: SLOT, depth: 1 }), view(), { region: 0.2, sub: 0.6 }).quads;
    expect(get(nested, "name").style.opacity).toBe(0.6);
    expect(get(nested, "name").text?.tracking).toBe(0.14);
  });

  it("the name's ink: tint at 22% coloured, ink 20% or 22% uncoloured; far mixes toward ink at 30%", () => {
    const col = paint(regionFact({ label: "x", color: "5", nameSlot: SLOT })).quads;
    expect(get(col, "name").style.ink).toEqual({ token: "cyan", alpha: 0.22 });
    expect(get(col, "name.far").style.ink).toMatchObject({ share: 0.3 });
    const plain = paint(regionFact({ label: "x", nameSlot: SLOT })).quads;
    expect(get(plain, "name").style.ink).toEqual({ token: "ink", alpha: 0.2 });
    expect(get(plain, "name.far").style.ink).toEqual({ token: "ink", alpha: 0.22 });
    expect(get(paint(regionFact({ label: "x", nameSlot: SLOT, depth: 1 })).quads, "name").style.ink).toEqual({ token: "ink", alpha: 0.22 });
  });

  describe("urgency", () => {
    const kinds = [["blocked", "crimson"], ["needs-you", "amber"], ["review", "cyan"]] as const;
    for (const [kind, hue] of kinds) {
      it(`${kind} direct: fill, inset frame and glow at every tier, hue ${hue}`, () => {
        const { quads } = paint(regionFact({ urgency: { kind, reach: "direct" } }));
        expect(get(quads, "urgency.near").style.shadow).toEqual({ name: "region-urgency", tint: { token: hue } });
        expect(get(quads, "urgency.far").style.shadow).toEqual({ name: "region-urgency-far", tint: { token: hue } });
        expect(get(quads, "urgency.fill.near").style.fill).toEqual({ kind: "flat", color: { token: hue, alpha: 0.03 } });
        expect(get(quads, "urgency.fill.far").style.fill).toEqual({ kind: "flat", color: { token: hue, alpha: 0.04 } });
        expect(at(quads, "near").map((q) => q.key)).toContain("urgency.near");
        expect(at(quads, "mid").map((q) => q.key)).toContain("urgency.near");
        expect(at(quads, "far").map((q) => q.key)).toContain("urgency.far");
        expect(at(quads, "overview").map((q) => q.key)).toContain("urgency.far");
      });
      it(`${kind} held: a hairline frame only, no fill`, () => {
        const { quads } = paint(regionFact({ urgency: { kind, reach: "held" } }));
        expect(get(quads, "urgency.near").style.shadow?.name).toBe("region-urgency-held");
        expect(get(quads, "urgency.far").style.shadow?.name).toBe("region-urgency-held-far");
        expect(keys(quads)).not.toContain("urgency.fill.near");
      });
    }
    it("leans the region hue 72% toward the urgency, 90% when held", () => {
      const direct = paint(regionFact({ color: "5", urgency: { kind: "blocked", reach: "direct" } })).quads;
      expect(JSON.stringify(get(direct, "outline.far").style.stroke?.color)).toContain('"token":"crimson"');
      expect(JSON.stringify(get(direct, "outline.far").style.stroke?.color)).toContain("0.72");
      const held = paint(regionFact({ color: "5", urgency: { kind: "blocked", reach: "held" } })).quads;
      expect(JSON.stringify(get(held, "outline.far").style.stroke?.color)).toContain("0.9");
    });
    it("no urgency, no glow", () => {
      expect(keys(paint(regionFact()).quads).filter((k) => k.startsWith("urgency"))).toEqual([]);
    });
  });

  it("focus dimming and reach marks come from the view", () => {
    expect(paint(regionFact(), view({ focus: { kind: "impact", role: "outsider" } })).dim).toEqual({ opacity: 0.22, saturate: 0.35 });
    expect(paint(regionFact()).dim).toEqual({ opacity: 1, saturate: 1 });
    expect(keys(paint(regionFact(), view({ reach: { id: "region-1", effect: "gains" } })).quads)).toContain("reach");
  });

  it("a non-region row paints nothing", () => {
    const seat = { ...regionFact(), row: { kind: "agent" } } as unknown as CardFact;
    expect(paint(seat).quads).toEqual([]);
  });
});
