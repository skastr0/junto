/**
 * PERF-P1 — continuous canvas attention must not use interpolating CSS.
 *
 * Factory motion is a 90 ms discrete clock (html[data-mark-frame]) plus
 * static rings. Interpolating infinite keyframes keep Chromium presenting
 * every vsync and are forbidden on the canvas attention path.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { markAtlasCss } from "../src/renderer/lib/activity-atlas";

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
    expect(css).not.toMatch(/@keyframes\s+juntoActivityClock\b/);
    expect(css).not.toMatch(/@keyframes\s+juntoActivityPulse\b/);
    expect(css).not.toMatch(/@keyframes\s+juntoBlockerHalo\b/);
    expect(css).not.toMatch(/@keyframes\s+juntoSeatAttentionHalo\b/);
    expect(css).not.toMatch(/@keyframes\s+juntoEdgeRippleOpacity\b/);
    expect(css).not.toMatch(/@keyframes\s+juntoBlockerFlagPulse\b/);
    expect(css).not.toMatch(/@keyframes\s+juntoStatusDotPulse\b/);
    expect(css).not.toMatch(/@keyframes\s+junto-dot-pulse\b/);
    expect(css).not.toMatch(/@keyframes\s+juntoPulse\b/);
    expect(css).not.toMatch(/@keyframes\s+juntoDash\b/);
    expect(css).not.toMatch(/@keyframes\s+juntoSeatAttentionPulse\b/);
  });

  it("ActivityMark loops key off the clock; the only animation is the finite done landing", () => {
    const sheet = markAtlasCss();
    expect(sheet).toMatch(/html\[data-mark-frame="0"\] \.junto-mark\[data-mark-motion="loop"\]/);
    const animations = [...sheet.matchAll(/animation:([^;}]*)/g)].map((m) => m[1] ?? "");
    for (const animation of animations) {
      if (animation.trim() === "none") continue;
      expect(animation).toMatch(/juntoMarkLand/);
      expect(animation).toMatch(/steps\(/);
      expect(animation).not.toMatch(/infinite/);
    }
    expect(css).not.toMatch(/junto-activity-clock-cell|junto-activity-pulse-cell/);
  });

  it("blocker halo is a static ::after ring, not an animation", () => {
    expect(css).toMatch(/\.junto-blocker\s*\{[^}]*box-shadow:[^}]*\}/s);
    const halo = ruleBody(".junto-blocker::after");
    expect(halo).not.toMatch(/animation\s*:/);
    expect(halo).not.toMatch(/will-change\s*:/);
    const blockerBlock = css.match(/\.junto-blocker\s*\{([^}]*)\}/)?.[1];
    expect(blockerBlock).toBeDefined();
    expect(blockerBlock).not.toMatch(/animation\s*:/);
  });

  it("seat-attention uses static box-shadow + static ::after ring", () => {
    const halo = ruleBody(
      '.junto-node[data-seat-attention="true"]::after',
    );
    expect(halo).not.toMatch(/animation\s*:/);
    expect(halo).not.toMatch(/will-change\s*:/);
    const parent = css.match(
      /\.junto-node\[data-attention="fire"\],\s*\n\.junto-node\[data-seat-attention="true"\]\s*\{([^}]*)\}/,
    )?.[1];
    expect(parent).toBeDefined();
    expect(parent).not.toMatch(/animation\s*:/);
    expect(parent).toMatch(/box-shadow\s*:/);
  });

  it("blocked-edge ripple keeps a static dash and does not animate", () => {
    expect(css).toMatch(
      /\.junto-edge-ripple[\s\S]*?stroke-dasharray:\s*5 6/,
    );
    const ripple = css.match(
      /\.junto-edge-ripple \.react-flow__edge-path,\s*\npath\.junto-edge-ripple\s*\{([^}]*)\}/,
    )?.[1];
    expect(ripple).toBeDefined();
    expect(ripple).not.toMatch(/animation\s*:/);
    expect(ripple).not.toMatch(/stroke-dashoffset/);
  });
});
