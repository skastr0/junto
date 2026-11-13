import { describe, expect, it } from "vitest";
import { TIER_BIT, type Quad, type SpineLive } from "../src/window/canvas/contract";
import { paintSpine, spineLook } from "../src/window/canvas/paint/spine";
import { fakeEnv, spineFact, view } from "./canvas-paint-fixtures";

const at = (quads: ReadonlyArray<Quad>, tier: keyof typeof TIER_BIT): ReadonlyArray<Quad> => quads.filter((q) => (q.tiers & TIER_BIT[tier]) !== 0);
const keys = (quads: ReadonlyArray<Quad>): string[] => quads.map((q) => q.key);
const paint = (kind: "peer" | "stub", live: Partial<SpineLive> = {}, v = view()) => paintSpine(spineFact(kind, live), v, fakeEnv);

describe("spine card paint", () => {
  it("near and mid draw the chip, glyph and name; far a disc; overview nothing", () => {
    const quads = paint("stub", { count: "3" }).quads;
    for (const tier of ["near", "mid"] as const) {
      expect(keys(at(quads, tier))).toEqual(expect.arrayContaining(["chip", "glyph", "name", "count"]));
      expect(keys(at(quads, tier))).not.toContain("far.disc");
    }
    const far = at(quads, "far");
    expect(keys(far)).toEqual(expect.arrayContaining(["far.disc", "far.glyph"]));
    expect(keys(far)).not.toContain("chip");
    expect(at(quads, "overview")).toEqual([]);
  });

  it("each status is its own shape and tone, in the tag at near and the pip at far", () => {
    expect(spineLook("blocked")).toEqual({ shape: "triangle", tone: "crimson" });
    expect(spineLook("failed")).toEqual({ shape: "triangle", tone: "crimson" });
    expect(spineLook("needs-you")).toEqual({ shape: "dot", tone: "amber" });
    expect(spineLook("working")).toEqual({ shape: "arc", tone: "cyan" });
    expect(spineLook("off")).toEqual({ shape: "ring", tone: "faint" });
    expect(spineLook("retired")).toEqual({ shape: "ring", tone: "faint" });
    expect(spineLook("none")).toBeUndefined();

    const cases = [
      ["blocked", "triangle", "crimson"],
      ["needs-you", "disc", "amber"],
      ["working", "disc", "cyan"],
      ["off", "disc", "faint"],
    ] as const;
    for (const [status, shape, tone] of cases) {
      const quads = paint("stub", { status, tag: status }).quads;
      const tagShape = quads.find((q) => q.key === "tag.shape")!;
      expect(tagShape.shape).toBe(shape);
      expect(quads.find((q) => q.key === "tag")?.style.stroke?.color).toEqual({ token: tone });
      expect(quads.find((q) => q.key === "tag.word")?.text?.upper).toBe(true);
      expect(quads.find((q) => q.key === "tag.word")?.text?.halo).toBe(true);
      expect(quads.find((q) => q.key === "far.pip")?.tiers).toBe(TIER_BIT.far);
    }
    expect(paint("stub", { status: "blocked", tag: "blocked" }).quads.find((q) => q.key === "far.pip")?.shape).toBe("triangle");
    expect(keys(paint("stub").quads)).not.toContain("tag");
    expect(keys(paint("stub").quads)).not.toContain("far.pip");
  });

  it("a flagged far disc takes a heavy ring in the tone's hue", () => {
    const crimson = paint("stub", { status: "blocked", tag: "blocked" }).quads.find((q) => q.key === "far.disc")!;
    expect(crimson.style.stroke).toEqual({ color: { token: "crimson" }, width: 2 });
    const plain = paint("stub").quads.find((q) => q.key === "far.disc")!;
    expect(plain.style.stroke).toEqual({ color: { token: "ink", alpha: 0.55 }, width: 1.5 });
    expect(plain.scale).toEqual({ kind: "node", anchor: { x: 0, y: 0 } });
  });

  it("peer and stub are dashed chips; a stub sits at 0.72, a peer wears a letter disc", () => {
    const stub = paint("stub").quads;
    expect(stub.find((q) => q.key === "chip")?.style.stroke?.dash).toBeDefined();
    expect(stub.find((q) => q.key === "chip")?.style.fill).toBeUndefined();
    for (const q of stub.filter((q) => q.kind !== "shadow")) expect(q.style.opacity).toBeCloseTo(0.72);
    const peer = paint("peer", { name: "kit" }).quads;
    expect(peer.find((q) => q.key === "portrait.letter")?.text?.text).toBe("k");
    expect(keys(peer)).not.toContain("glyph");
    expect(peer.find((q) => q.key === "chip")?.style.opacity).toBeUndefined();
  });

  it("a solid (non-dashed) chip fills overlay-3 and states change its stroke", () => {
    const solid = (v = view()) => paint("stub", { dashed: false }, v).quads.find((q) => q.key === "chip")!;
    expect(solid().style.fill).toEqual({ kind: "flat", color: { token: "overlay-3" } });
    expect(solid().style.stroke?.color).toEqual({ token: "stroke" });
    expect(solid(view({ hovered: true })).style.stroke?.color).toEqual({ token: "stroke-hi" });
    expect(solid(view({ selected: true })).style.stroke?.color).toEqual({ token: "main" });
    expect(keys(paint("stub", {}, view({ selected: true })).quads)).toEqual(expect.arrayContaining(["chip.ring", "far.selected"]));
    expect(keys(paint("stub", {}, view({ keyboardFocus: true })).quads)).toEqual(expect.arrayContaining(["focus", "far.focus"]));
  });

  it("the chip is 28 high and grows with its words, capped at the larger of the node width and 320", () => {
    const short = paint("stub", { name: "a" }).quads.find((q) => q.key === "chip")!;
    expect(short.rect.height).toBe(28);
    const long = paint("stub", { name: "x".repeat(200) }).quads.find((q) => q.key === "chip")!;
    expect(long.rect.width).toBe(320);
    expect(long.rect.width).toBeGreaterThan(short.rect.width);
  });

  it("a leaf hangs 5 under the chip; a path truncates at its head", () => {
    const plain = paint("stub", { leaf: "file copy" }).quads.find((q) => q.key === "leaf")!;
    expect(plain.rect).toMatchObject({ x: 15, y: 33 });
    expect(plain.text?.truncate).toBe("end");
    expect(plain.text?.halo).toBe(true);
    expect(paint("stub", { leaf: "/a/b/c", leafTail: true }).quads.find((q) => q.key === "leaf")?.text?.truncate).toBe("head");
  });

  it("a spine shows meta, at most four rows and the rest as +N more", () => {
    const rows = ["a", "b", "c", "d", "e", "f"];
    const quads = paint("stub", { meta: "6 items", rows, more: 1 }).quads;
    expect(keys(quads)).toEqual(expect.arrayContaining(["meta", "row.0", "row.3", "more", "spine"]));
    expect(keys(quads)).not.toContain("row.4");
    expect(quads.find((q) => q.key === "more")?.text?.text).toBe("+3 more");
    const ys = ["meta", "row.0", "row.1", "row.2", "row.3", "more"].map((k) => quads.find((q) => q.key === k)!.rect.y);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
    const spine = quads.find((q) => q.key === "spine")!;
    expect(spine.rect.x).toBe(15);
    expect(spine.rect.width).toBe(1.5);
    expect(quads.find((q) => q.key === "row.0")?.text?.size).toBe(11);
    expect(quads.find((q) => q.key === "meta")?.style.ink).toEqual({ token: "dim" });
    expect(quads.find((q) => q.key === "row.0")?.style.ink).toEqual({ token: "ink-2" });
    expect(keys(paint("stub", { meta: "x", rows: ["a"] }).quads)).not.toContain("more");
    expect(keys(paint("stub").quads)).not.toContain("spine");
  });

  it("dims by focus role and mid draws no shadow", () => {
    expect(paint("stub", {}, view({ focus: { kind: "connection", role: "lead" } })).dim).toEqual({ opacity: 0.72, saturate: 0.85 });
    expect(paint("stub").quads.some((q) => q.kind === "shadow")).toBe(false);
    expect(paint("stub").lift).toBe(0);
  });
});
