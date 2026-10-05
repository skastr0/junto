/**
 * PERF — the React Flow viewport is never composited, and nothing about the
 * board's rendering changes with the camera.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(resolve(__dirname, "..", path), "utf8");
const css = read("src/renderer/styles.css");
const sheets = [
  css,
  read("src/renderer/styles/factory-grammar.css"),
  read("src/renderer/components/edges/wire-pulse.css"),
  read("src/renderer/components/rts/RtsBottomBar.css"),
];

describe("viewport compositor promotion (CSS)", () => {
  it("never promotes .react-flow__viewport (a composited camera starves tile memory)", () => {
    // 6cbf5074c and df7eec87e: will-change pinned raster scale at native and
    // the transform animation split the board into ~800 overlap layers; both
    // left tiles unpainted. The viewport stays uncomposited.
    expect(css).not.toMatch(
      /\.react-flow__viewport\s*\{[^}]*will-change\s*:/,
    );
  });

  it("carries no camera-gesture rule: a pan changes nothing about how the board is drawn", () => {
    // The pan freeze (paused animations, cut transitions, stripped wire glow,
    // hidden pulses) read as the board dying under the camera, and was built
    // for a composited viewport that no longer exists.
    for (const sheet of sheets) expect(sheet).not.toMatch(/data-viewport-busy/);
  });
});
