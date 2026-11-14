import { describe, expect, it } from "vitest";
import { SeatUrgency } from "@shared/wire/urgency";
import { BAND_BOX, bandBackground, bandSvg, kindBandLayers } from "../src/window/lib/kind-band";
import { bandSprites } from "../src/window/canvas/paint/images";

/**
 * The band is generated once and shown twice: the DOM puts it in a CSS
 * background, the GPU rasterizes it as an image. Both need a document, not a
 * fragment. Handed the bare paths, an image decoder finds no root and no
 * viewBox and draws nothing, which is what every kind seat did: a ring with no
 * band round it and, on a terminal, no flag.
 */
describe("kind band: one generated art, two projections", () => {
  it("wraps a layer in the document both projections read", () => {
    const [track] = kindBandLayers("task", SeatUrgency.group.resting, "dark", undefined);
    const document = bandSvg(track!.svg);
    expect(document.startsWith("<svg")).toBe(true);
    expect(document).toContain(`viewBox='0 0 ${String(BAND_BOX)} ${String(BAND_BOX)}'`);
    expect(document).toContain("xmlns='http://www.w3.org/2000/svg'");
    expect(document.endsWith("</svg>")).toBe(true);
    expect(document).toContain(track!.svg);
  });

  it("the DOM background is that same document, encoded", () => {
    const [track] = kindBandLayers("terminal", SeatUrgency.group.resting, "bright", undefined);
    expect(bandBackground(track!.svg)).toBe(`url("data:image/svg+xml,${encodeURIComponent(bandSvg(track!.svg))}")`);
  });

  it("every band sprite the GPU draws is a document, sized in the band's box", () => {
    for (const kind of ["terminal", "task", "artifacts", "automations", "page", "git", "files", "link", "file"] as const) {
      for (const state of SeatUrgency.groups) {
        const sprites = bandSprites(kind, state, "dark", undefined);
        expect(sprites.length, `${kind} ${state}`).toBeGreaterThan(0);
        for (const { sprite } of sprites) {
          if (sprite.atlas !== "image") throw new Error(`${kind} ${state} is not an image sprite`);
          expect(sprite.size).toEqual({ width: BAND_BOX, height: BAND_BOX });
          expect(sprite.svg.startsWith("<svg"), `${kind} ${state}`).toBe(true);
          expect(sprite.svg).toContain(`viewBox='0 0 ${String(BAND_BOX)} ${String(BAND_BOX)}'`);
        }
      }
    }
  });
});
