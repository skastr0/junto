/**
 * The ring language in src/shared/rings.ts is the one source the desktop
 * paints and the phone draws from: it imports no renderer or theme, and the
 * desktop's painters cover exactly the parts its timing names.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ringCells } from "../src/renderer/lib/activity-atlas";
import { RING_PAINT } from "../src/renderer/lib/activity-rings";
import { RING_MOTION, ringState, type LoopRing } from "../src/shared/rings";

const root = resolve(__dirname, "..");
const importsOf = (rel: string): string[] =>
  [...readFileSync(join(root, rel), "utf8").matchAll(/^import[^;]*?from "([^"]+)";/gms)].map((m) => m[1]!);

describe("shared rings", () => {
  it("import only effect and other shared modules", () => {
    for (const rel of ["src/shared/rings.ts", "src/shared/wire-route.ts"]) {
      for (const from of importsOf(rel)) expect(from === "effect" || from.startsWith("./"), `${rel}: ${from}`).toBe(true);
    }
  });

  it("the desktop paints every part the timing names, and no other", () => {
    for (const ring of Object.keys(RING_MOTION) as LoopRing[]) {
      const motion = RING_MOTION[ring];
      const paint = RING_PAINT[ring];
      expect(paint.base !== undefined, `${ring} base`).toBe(motion.base);
      expect(paint.spin !== undefined, `${ring} spin`).toBe(motion.spin !== undefined);
      expect(paint.pulse !== undefined, `${ring} pulse`).toBe(motion.pulse !== undefined);
    }
  });

  it("the atlas draws the ring and tone ringState names", () => {
    const glyphs = ["work", "call", "halt", "done", "live", "dot", "rest", "off"] as const;
    const tones = ["amber", "cyan", "green", "crimson", "steel"] as const;
    const healths = [undefined, "good", "waiting", "trouble"] as const;
    const signals = [undefined, "blocked", "escalate", "feedback"] as const;
    for (const glyph of glyphs)
      for (const tone of tones)
        for (const health of healths)
          for (const signal of signals)
            for (const healthStale of [false, true]) {
              const input = { glyph, tone, health, signal, healthStale, healthValue: health === "trouble" ? ("stuck" as const) : undefined };
              const state = ringState(input);
              const cells = ringCells({ ...input, animate: true });
              expect(cells.ring).toBe(state.ring);
              expect(cells.hue).toBe(state.hue);
              expect(cells.band !== undefined).toBe(state.glow !== undefined || state.halo !== undefined || state.flag !== undefined);
            }
  });
});
