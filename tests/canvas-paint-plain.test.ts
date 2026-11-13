import { describe, expect, it } from "vitest";
import { TIER_BIT, type CardFact, type Quad } from "../src/window/canvas/contract";
import { paintDefaultCard } from "../src/window/canvas/paint/card";
import { paintLabel } from "../src/window/canvas/paint/label";
import { layoutNote } from "../src/window/canvas/paint/note-layout";
import { paintNote } from "../src/window/canvas/paint/note";
import { fakeEnv, view } from "./canvas-paint-fixtures";

const fact = (row: Record<string, unknown>, over: Partial<CardFact["derived"]> = {}): CardFact => ({
  id: "n1",
  row: { id: "n1", x: 0, y: 0, z: 0, width: 220, height: 84, ...row } as unknown as CardFact["row"],
  derived: { regionDepth: 0, blocked: false, z: 0, ...over },
});
const at = (quads: ReadonlyArray<Quad>, tier: keyof typeof TIER_BIT): ReadonlyArray<Quad> => quads.filter((q) => (q.tiers & TIER_BIT[tier]) !== 0);
const keys = (quads: ReadonlyArray<Quad>): string[] => quads.map((q) => q.key);

describe("note", () => {
  const note = fact({ kind: "note", text: "# Plan\n\nfirst paragraph here\n\n- one\n- two" });
  it("near typesets every block, mid only the first, far an amber tick, overview nothing", () => {
    const p = paintNote(note, view(), fakeEnv);
    const near = keys(at(p.quads, "near"));
    const mid = keys(at(p.quads, "mid"));
    expect(near.some((k) => k.startsWith("b1"))).toBe(true);
    expect(near.some((k) => k.startsWith("b2"))).toBe(true);
    expect(mid.some((k) => k.startsWith("b0"))).toBe(true);
    expect(mid.some((k) => k.startsWith("b1"))).toBe(false);
    const far = at(p.quads, "far");
    expect(keys(far)).toEqual(["tick"]);
    expect(far[0]!.scale.kind).toBe("node");
    expect(at(p.quads, "overview")).toEqual([]);
  });

  it("the first heading is ink 600 in the title size; later headings are display caps", () => {
    const l = layoutNote("# Plan\n\n## Later\n", 150, { x: 0, y: 0 }, fakeEnv);
    const first = l.quads.find((q) => q.key === "b0.0.0")!;
    expect(first.text).toMatchObject({ weight: 600, size: 14, font: "mono" });
    const second = l.quads.find((q) => q.key === "b1.0.0")!;
    expect(second.text).toMatchObject({ font: "display", size: 12.5 });
  });

  it("wraps at the width and never past it, with strong and links keeping their style and part", () => {
    const l = layoutNote("alpha **beta** [gamma](https://x.test) delta epsilon zeta eta theta", 80, { x: 0, y: 0 }, fakeEnv);
    const runs = l.quads.filter((q) => q.kind === "text");
    expect(new Set(runs.map((q) => q.rect.y)).size).toBeGreaterThan(1);
    for (const q of runs) expect(q.rect.x + q.rect.width).toBeLessThanOrEqual(80.001);
    expect(runs.find((q) => q.text?.text.includes("beta"))?.text?.weight).toBe(600);
    expect(runs.find((q) => q.part?.kind === "noteLink")?.part).toEqual({ kind: "noteLink", href: "https://x.test" });
  });

  it("an empty note says so, and a long note fades its last line", () => {
    expect(layoutNote("", 100, { x: 0, y: 0 }, fakeEnv).empty).toBe(true);
    const long = fact({ kind: "note", text: Array.from({ length: 20 }, (_, i) => `line number ${String(i)} of the note`).join("\n\n") });
    expect(keys(paintNote(long, view(), fakeEnv).quads)).toContain("fade");
    expect(keys(paintNote(fact({ kind: "note", text: "short" }), view(), fakeEnv).quads)).not.toContain("fade");
  });

  it("editing hides the typeset text for the overlay editor", () => {
    expect(keys(paintNote(note, view({ editing: true }), fakeEnv).quads).some((k) => k.startsWith("b0"))).toBe(false);
  });
});

describe("label", () => {
  const label = fact({ kind: "label", text: "North", width: 200, height: 40 });
  it("is bare display type at near and mid and floors at 13 held at far, nothing at overview", () => {
    const p = paintLabel(label, view(), fakeEnv);
    expect(at(p.quads, "near").find((q) => q.key === "text")?.text).toMatchObject({ size: 24, weight: 700, font: "display", text: "North" });
    expect(at(p.quads, "far").find((q) => q.key === "text.far")?.scale.kind).toBe("node");
    expect(at(p.quads, "overview").filter((q) => q.kind === "text")).toEqual([]);
    expect(keys(at(p.quads, "near"))).not.toContain("shell");
  });
  it("an empty label reads Label and a colour tints it", () => {
    expect(paintLabel(fact({ kind: "label", text: "", width: 200, height: 40 }), view(), fakeEnv).quads.find((q) => q.key === "text")?.text?.text).toBe("Label");
    const coloured = paintLabel(fact({ kind: "label", text: "x", color: "1", width: 200, height: 40 }), view(), fakeEnv);
    expect(coloured.quads.find((q) => q.key === "text")?.style.ink).toEqual({ token: "crimson" });
  });
});

describe("default card (image file)", () => {
  const image = fact({ kind: "file", path: "junto-content://x/y.png", width: 240, height: 160 });
  it("draws the gradient shell and the image near, a tinted glyph box far", () => {
    const p = paintDefaultCard(image, view(), fakeEnv);
    expect(at(p.quads, "near").find((q) => q.key === "shell")?.style.fill?.kind).toBe("gradient");
    expect(at(p.quads, "near").find((q) => q.key === "image")?.sprite).toMatchObject({ atlas: "media" });
    expect(keys(at(p.quads, "far"))).toEqual(expect.arrayContaining(["far.box", "far.glyph"]));
    expect(at(p.quads, "overview")).toEqual([]);
  });
  it("selection uses the accent at 75%, blocked is crimson with its gradient and ring", () => {
    const sel = paintDefaultCard(image, view({ selected: true }), fakeEnv).quads.find((q) => q.key === "shell")!;
    expect(sel.style.stroke?.color).toEqual({ token: "accent", alpha: 0.75 });
    const blocked = paintDefaultCard(fact({ kind: "file", path: "p.png", width: 240, height: 160 }, { blocked: true }), view(), fakeEnv);
    expect(blocked.quads.find((q) => q.key === "shell")?.style.stroke?.color).toEqual({ token: "crimson" });
    expect(keys(blocked.quads)).toContain("blocker");
  });
  it("a focus mode dims outsiders to 22% and desaturates, and roots take their shadow", () => {
    expect(paintDefaultCard(image, view({ focus: { kind: "impact", role: "outsider" } }), fakeEnv).dim).toEqual({ opacity: 0.22, saturate: 0.35 });
    const root = paintDefaultCard(image, view({ focus: { kind: "connection", role: "root" } }), fakeEnv);
    expect(root.quads.find((q) => q.key === "focus.shadow")?.style.shadow?.name).toBe("focus-connection-root");
  });
});
