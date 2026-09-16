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

  it("ActivityMark cells have no CSS animation and key off the clock", () => {
    expect(ruleBody(".junto-activity-clock-cell")).not.toMatch(/animation\s*:/);
    expect(ruleBody(".junto-activity-pulse-cell")).not.toMatch(/animation\s*:/);
    expect(css).toMatch(
      /html\[data-attention-phase="0"\]\s+\.junto-activity-clock-cell:nth-child\(1\)/,
    );
    expect(css).toMatch(
      /html\[data-attention-phase="7"\]\s+\.junto-activity-clock-cell:nth-child\(8\)/,
    );
    expect(css).toMatch(
      /html\[data-attention-beat="1"\]\s+\.junto-activity-pulse-cell/,
    );
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
