/**
 * PERF — React Flow viewport will-change must be STABLE for the canvas-mount
 * lifetime. Toggling the promotion hint on busy-gate boundaries promoted and
 * de-promoted the viewport layer — every flip re-rastered the visible canvas
 * and read as content popping out. The busy attribute remains the
 * work-deferral gate only; it must not change rendering policy.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  resolve(__dirname, "../src/renderer/styles.css"),
  "utf8",
);

describe("viewport compositor promotion (CSS)", () => {
  it("never promotes .react-flow__viewport (a composited camera starves tile memory)", () => {
    // 6cbf5074c and df7eec87e: will-change pinned raster scale at native and
    // the transform animation split the board into ~800 overlap layers; both
    // left tiles unpainted. The viewport stays uncomposited.
    expect(css).not.toMatch(
      /\.react-flow__viewport\s*\{[^}]*will-change\s*:/,
    );
  });

  it("never scopes the viewport promotion to the busy gate", () => {
    // The busy-scoped promotion rule is the flicker mechanism; its absence is
    // the invariant.
    expect(css).not.toMatch(
      /html\[data-viewport-busy\][^{]*\.react-flow__viewport\s*\{[^}]*will-change\s*:/s,
    );
  });

  it("keeps viewport-busy freeze selectors (transitions off during interaction)", () => {
    expect(css).toMatch(
      /html\[data-viewport-busy\]\s+\.react-flow\s+\.react-flow__node[^{]*\{[^}]*transition\s*:\s*none/s,
    );
  });

  it("pauses (never cancels) node/edge animations during interaction", () => {
    // Cancelling restarts animations from their keyframe origin at release —
    // a second visible flip at every busy boundary.
    expect(css).toMatch(
      /html\[data-viewport-busy\]\s+\.react-flow\s+\.react-flow__edge[^{]*\{[^}]*animation-play-state\s*:\s*paused/s,
    );
    expect(css).not.toMatch(
      /html\[data-viewport-busy\]\s+\.react-flow\s+\.react-flow__edge[^{]*\{[^}]*animation\s*:\s*none/s,
    );
  });

  it("never flips node filters or the hover lift on the busy gate", () => {
    // Whole-board appearance must not change with the camera.
    expect(css).not.toMatch(
      /html\[data-viewport-busy\][^{]*\.react-flow__node[^{]*\{[^}]*filter\s*:/s,
    );
    expect(css).not.toMatch(
      /html\[data-viewport-busy\][^{]*:hover[^{]*\{[^}]*transform\s*:/s,
    );
  });
});
