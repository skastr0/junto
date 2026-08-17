/**
 * PERF-P3 — React Flow viewport will-change must be interaction-scoped.
 *
 * Permanent will-change on .react-flow__viewport keeps the full node/edge
 * subtree promoted while idle. Promotion is gated on is-viewport-busy.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  resolve(__dirname, "../src/renderer/styles.css"),
  "utf8",
);

describe("viewport compositor promotion (CSS)", () => {
  it("does not permanently mark .react-flow__viewport with will-change", () => {
    // Settled rule is line-start `.react-flow__viewport { … will-change … }`.
    // Busy-scoped promotion is `.react-flow.is-viewport-busy .react-flow__viewport`.
    const permanent = /^\.react-flow__viewport\s*\{[^}]*will-change\s*:/m;
    expect(css).not.toMatch(permanent);
  });

  it("promotes .react-flow__viewport only under is-viewport-busy", () => {
    expect(css).toMatch(
      /\.react-flow\.is-viewport-busy\s+\.react-flow__viewport\s*\{[^}]*will-change\s*:\s*transform/s,
    );
  });

  it("keeps viewport-busy freeze selectors (transitions off during interaction)", () => {
    expect(css).toMatch(
      /\.react-flow\.is-viewport-busy\s+\.react-flow__node[\s\S]*?transition\s*:\s*none/s,
    );
    expect(css).toMatch(
      /\.react-flow\.is-viewport-busy\s+\.react-flow__edge[\s\S]*?animation\s*:\s*none/s,
    );
  });
});
