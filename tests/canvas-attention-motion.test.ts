/**
 * PERF-P1 — continuous canvas attention must not use interpolating CSS.
 *
 * Factory motion is a 90 ms discrete clock (html[data-attention-phase]) plus
 * static rings. Interpolating infinite keyframes keep Chromium presenting
 * every vsync and are forbidden on the canvas attention path.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  resolve(__dirname, "../src/renderer/styles.css"),
  "utf8",
);

const ruleBody = (selector: string): string => {
  const re = new RegExp(
    `${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`,
  );
  const m = css.match(re);
  if (!m) throw new Error(`missing rule ${selector}`);
  return m[1] ?? "";
};

describe("canvas continuous motion (discrete clock, no interpolating CSS)", () => {
  it("retired interpolating factory keyframes are gone", () => {
    expect(css).not.toMatch(/@keyframes\s+vellumActivityClock\b/);
    expect(css).not.toMatch(/@keyframes\s+vellumActivityPulse\b/);
    expect(css).not.toMatch(/@keyframes\s+vellumBlockerHalo\b/);
    expect(css).not.toMatch(/@keyframes\s+vellumSeatAttentionHalo\b/);
    expect(css).not.toMatch(/@keyframes\s+vellumEdgeRippleOpacity\b/);
    expect(css).not.toMatch(/@keyframes\s+vellumBlockerFlagPulse\b/);
    expect(css).not.toMatch(/@keyframes\s+vellumStatusDotPulse\b/);
    expect(css).not.toMatch(/@keyframes\s+vellum-dot-pulse\b/);
    expect(css).not.toMatch(/@keyframes\s+vellumPulse\b/);
    expect(css).not.toMatch(/@keyframes\s+vellumDash\b/);
    expect(css).not.toMatch(/@keyframes\s+vellumSeatAttentionPulse\b/);
  });

  it("ActivityMark cells have no CSS animation and key off the clock", () => {
    expect(ruleBody(".vellum-activity-clock-cell")).not.toMatch(/animation\s*:/);
    expect(ruleBody(".vellum-activity-pulse-cell")).not.toMatch(/animation\s*:/);
    expect(css).toMatch(
      /html\[data-attention-phase="0"\]\s+\.vellum-activity-clock-cell:nth-child\(1\)/,
    );
    expect(css).toMatch(
      /html\[data-attention-phase="7"\]\s+\.vellum-activity-clock-cell:nth-child\(8\)/,
    );
    expect(css).toMatch(
      /html\[data-attention-beat="1"\]\s+\.vellum-activity-pulse-cell/,
    );
  });

  it("blocker halo is a static ::after ring, not an animation", () => {
    expect(css).toMatch(/\.vellum-blocker\s*\{[^}]*box-shadow:[^}]*\}/s);
    const halo = ruleBody(".vellum-blocker::after");
    expect(halo).not.toMatch(/animation\s*:/);
    expect(halo).not.toMatch(/will-change\s*:/);
    const blockerBlock = css.match(/\.vellum-blocker\s*\{([^}]*)\}/)?.[1];
    expect(blockerBlock).toBeDefined();
    expect(blockerBlock).not.toMatch(/animation\s*:/);
  });

  it("seat-attention uses static box-shadow + static ::after ring", () => {
    const halo = ruleBody(
      '.vellum-node[data-seat-attention="true"]::after',
    );
    expect(halo).not.toMatch(/animation\s*:/);
    expect(halo).not.toMatch(/will-change\s*:/);
    const parent = css.match(
      /\.vellum-node\[data-attention="fire"\],\s*\n\.vellum-node\[data-seat-attention="true"\]\s*\{([^}]*)\}/,
    )?.[1];
    expect(parent).toBeDefined();
    expect(parent).not.toMatch(/animation\s*:/);
    expect(parent).toMatch(/box-shadow\s*:/);
  });

  it("blocked-edge ripple keeps a static dash and does not animate", () => {
    expect(css).toMatch(
      /\.vellum-edge-ripple[\s\S]*?stroke-dasharray:\s*5 6/,
    );
    const ripple = css.match(
      /\.vellum-edge-ripple \.react-flow__edge-path,\s*\npath\.vellum-edge-ripple\s*\{([^}]*)\}/,
    )?.[1];
    expect(ripple).toBeDefined();
    expect(ripple).not.toMatch(/animation\s*:/);
    expect(ripple).not.toMatch(/stroke-dashoffset/);
  });
});
