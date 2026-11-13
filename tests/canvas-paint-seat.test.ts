import { describe, expect, it } from "vitest";
import { TIER_BIT, type Quad } from "../src/window/canvas/contract";
import { paintSeat } from "../src/window/canvas/paint/seat";
import { SEAT, SEAT_RING_CENTRE } from "../src/window/canvas/paint/card-spec";
import { agentFact, fakeEnv, seatLive, view } from "./canvas-paint-fixtures";

const at = (quads: ReadonlyArray<Quad>, tier: keyof typeof TIER_BIT): ReadonlyArray<Quad> =>
  quads.filter((q) => (q.tiers & TIER_BIT[tier]) !== 0);
const keys = (quads: ReadonlyArray<Quad>): string[] => quads.map((q) => q.key);

describe("agent seat paint", () => {
  const working = seatLive({ glyph: "work", tone: "cyan" });

  it("near draws the shell, ring, portrait, name and line; mid only the shell and name", () => {
    const paint = paintSeat(agentFact(), working, view(), fakeEnv);
    const near = keys(at(paint.quads, "near"));
    expect(near).toEqual(expect.arrayContaining(["shell", "ring.base", "portrait", "name", "line.text"]));
    const mid = keys(at(paint.quads, "mid"));
    expect(mid).toEqual(expect.arrayContaining(["shell", "name", "ring.base", "portrait"]));
    expect(mid).not.toContain("line.text");
    expect(mid).not.toContain("badge");
  });

  it("far has no shell and no text; the ring and portrait are held by the seat scale", () => {
    const paint = paintSeat(agentFact({ ringCap: 3 }), working, view(), fakeEnv);
    const far = at(paint.quads, "far");
    expect(keys(far)).not.toContain("shell");
    expect(keys(far)).not.toContain("name");
    const ring = far.find((q) => q.key === "ring.base");
    expect(ring?.scale).toEqual({ kind: "seat", cap: 3, anchor: SEAT_RING_CENTRE });
    expect(far.find((q) => q.key === "portrait")?.scale).toEqual({ kind: "seat", cap: 3, anchor: SEAT_RING_CENTRE });
  });

  it("a moving ring is a base plus a turning part on the shared period, with its rest pose gated to paused", () => {
    const quads = paintSeat(agentFact(), working, view(), fakeEnv).quads;
    const spin = quads.find((q) => q.key === "ring.spin");
    expect(spin?.motion).toEqual({ kind: "turn", periodMs: 1440 });
    expect(spin?.gate).toBe("live");
    expect(quads.find((q) => q.key === "ring.rest")?.gate).toBe("paused");
    expect(quads.find((q) => q.key === "ring.base")?.gate).toBe("live");
  });

  it("a resting seat has one still ring and no motion", () => {
    const quads = paintSeat(agentFact(), seatLive({ glyph: "rest", tone: "steel" }), view(), fakeEnv).quads;
    expect(quads.filter((q) => q.motion !== undefined)).toEqual([]);
    expect(keys(quads)).toContain("ring.core");
  });

  it("done lands once and then glints", () => {
    const quads = paintSeat(agentFact(), seatLive({ glyph: "done", tone: "green" }, { ringSince: 5_000 }), view(), fakeEnv).quads;
    expect(quads.find((q) => q.key === "ring.land")?.motion).toEqual({ kind: "land", since: 5_000 });
    expect(quads.find((q) => q.key === "ring.base")?.motion).toEqual({ kind: "landed", since: 5_000 });
    expect(quads.find((q) => q.key === "ring.spin")?.motion).toEqual({ kind: "turn", periodMs: 2880, fade: true });
  });

  it("every ring form paints with periods only from RING_MOTION", () => {
    const cases = [
      { glyph: "work", tone: "cyan" },
      { glyph: "call", tone: "amber" },
      { glyph: "halt", tone: "crimson" },
      { glyph: "live", tone: "green" },
      { glyph: "work", tone: "amber", health: "trouble", healthValue: "stuck" },
      { glyph: "work", tone: "amber", health: "trouble" },
      { glyph: "rest", tone: "steel", health: "trouble" },
      { glyph: "rest", tone: "steel", signal: "escalate" },
    ] as const;
    for (const input of cases) {
      const quads = paintSeat(agentFact(), seatLive({ ...input }), view(), fakeEnv).quads;
      for (const q of quads) {
        if (q.motion && "periodMs" in q.motion) expect(80640 % q.motion.periodMs).toBe(0);
      }
    }
  });

  it("selection and hover change the shell style and lift only on hover", () => {
    const rest = paintSeat(agentFact(), working, view(), fakeEnv);
    const hover = paintSeat(agentFact(), working, view({ hovered: true }), fakeEnv);
    const selected = paintSeat(agentFact(), working, view({ selected: true }), fakeEnv);
    const shellOf = (p: typeof rest) => p.quads.find((q) => q.key === "shell")!.style;
    expect(shellOf(hover)).not.toEqual(shellOf(rest));
    expect(shellOf(selected).stroke?.color).toEqual({ token: "main", alpha: 0.55 });
    expect(hover.lift).toBe(1);
    expect(selected.lift).toBe(0);
    expect(keys(selected.quads)).toContain("shell.shadow");
    expect(keys(rest.quads)).not.toContain("shell.shadow");
  });

  it("far halo says call, wait and halt in their hues; far hover shows the name tag", () => {
    const call = paintSeat(agentFact(), seatLive({ glyph: "call", tone: "amber" }), view(), fakeEnv).quads;
    expect(call.find((q) => q.key === "halo.inner")?.style.stroke?.color).toEqual({ token: "amber", alpha: 0.92 });
    const halt = paintSeat(agentFact(), seatLive({ glyph: "halt", tone: "crimson" }), view(), fakeEnv).quads;
    expect(halt.find((q) => q.key === "halo.outer")?.style.stroke?.color).toEqual({ token: "crimson", alpha: 0.3 });
    const idle = paintSeat(agentFact(), working, view(), fakeEnv).quads;
    expect(keys(idle)).not.toContain("halo.inner");
    expect(keys(idle)).not.toContain("tag");
    const hovered = paintSeat(agentFact(), working, view({ hovered: true }), fakeEnv).quads;
    expect(hovered.find((q) => q.key === "tag")?.scale.kind).toBe("seatTag");
    expect(hovered.find((q) => q.key === "tag.name")?.text?.text).toBe("canvas-cards");
  });

  it("an editing seat hides its own name for the overlay editor", () => {
    expect(keys(paintSeat(agentFact(), working, view({ editing: true }), fakeEnv).quads)).not.toContain("name");
  });

  it("puts the text column where the DOM does: 62 from the left, 143 wide", () => {
    const name = paintSeat(agentFact(), working, view(), fakeEnv).quads.find((q) => q.key === "name")!;
    expect(name.rect.x).toBe(SEAT.rowLeft + SEAT.ring + SEAT.gap);
    expect(name.rect.width).toBe(143);
  });

  it("the preamble bubble sits 9 above the seat in the lifted band, near only", () => {
    const quads = paintSeat(
      agentFact(),
      seatLive({ glyph: "work", tone: "cyan" }, { preamble: { now: "reading the plan", hue: "second", dx: 0, since: 0 } }),
      view(),
      fakeEnv,
    ).quads;
    const bubble = quads.find((q) => q.key === "bubble")!;
    expect(bubble.band).toBe("lifted");
    expect(bubble.tiers).toBe(TIER_BIT.near);
    expect(bubble.rect.y + bubble.rect.height).toBeCloseTo(-9);
  });

  it("an overseer wears the crest and a blocked seat flags with a hit part", () => {
    const quads = paintSeat(agentFact(), seatLive({ glyph: "halt", tone: "crimson", signal: "blocked" }, { overseer: true }), view(), fakeEnv).quads;
    expect(keys(quads)).toContain("crest");
    expect(quads.find((q) => q.key === "flag.hit")?.part).toEqual({ kind: "ringFlag" });
  });
});
