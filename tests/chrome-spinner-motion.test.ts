/**
 * Loading spinners spin, and pause with the rest of the surface when the
 * window is hidden or motion is reduced.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const readCss = (rel: string): string =>
  readFileSync(resolve(__dirname, rel), "utf8");

const media = readCss("../src/renderer/components/work/content-media.css");

describe("chrome loading spinners", () => {
  it("spin, and pause under data-surface-motion", () => {
    expect(media).toMatch(
      /animation:\s*content-media-spin\s+[\d.]+s\s+linear\s+infinite/,
    );
    expect(media).toMatch(
      /html\[data-surface-motion="paused"\][^{]*\{[^}]*animation:\s*none\s*!important/s,
    );
  });
});
