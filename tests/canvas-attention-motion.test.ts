/**
 * PERF-P1 — continuous canvas attention CSS must stay compositor-safe.
 *
 * Reads styles.css selector blocks and asserts paint-heavy properties are not
 * keyframed for blocker / seat-attention / edge ripple / ActivityMark motion.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  resolve(__dirname, "../src/renderer/styles.css"),
  "utf8",
);

/** Extract @keyframes body by name. */
const keyframesBody = (name: string): string => {
  const re = new RegExp(
    `@keyframes\\s+${name}\\s*\\{([\\s\\S]*?)\\n\\}`,
    "m",
  );
  const m = css.match(re);
  if (!m) throw new Error(`missing @keyframes ${name}`);
  return m[1] ?? "";
};

const FORBIDDEN_IN_KEYFRAMES =
  /\b(box-shadow|filter|mask|mask-image|-webkit-mask|background|background-color|background-image|stroke-dashoffset)\s*:/i;

describe("canvas continuous motion keyframes (compositor-safe)", () => {
  it.each([
    "vellumActivityClock",
    "vellumActivityPulse",
    "vellumBlockerHalo",
    "vellumSeatAttentionHalo",
    "vellumEdgeRippleOpacity",
    "vellumBlockerFlagPulse",
    "vellumStatusDotPulse",
  ])("%s only uses transform/opacity (no paint-heavy props)", (name) => {
    const body = keyframesBody(name);
    expect(body).not.toMatch(FORBIDDEN_IN_KEYFRAMES);
    // Must still animate something.
    expect(body).toMatch(/\b(opacity|transform)\s*:/);
  });

  it("ActivityMark cells carry the staggered clock and shared breath", () => {
    // Wave cells stagger the clock cycle per step (bright head, fading trail).
    expect(css).toMatch(
      /\.vellum-activity-clock-cell\s*\{[^}]*animation-delay:\s*calc\(var\(--activity-clock-step\)\s*\*\s*90ms\)/s,
    );
    // Pulse cells breathe together on the shared keyframes.
    expect(css).toMatch(
      /\.vellum-activity-pulse-cell\s*\{[^}]*animation:\s*vellumActivityPulse/s,
    );
  });

  it("blocker base card does not animate; halo lives on ::after", () => {
    // Static shadow on .vellum-blocker, animation only on ::after
    expect(css).toMatch(
      /\.vellum-blocker\s*\{[^}]*box-shadow:[^}]*\}/s,
    );
    expect(css).toMatch(
      /\.vellum-blocker::after\s*\{[^}]*animation:\s*vellumBlockerHalo/s,
    );
    // No animation property on .vellum-blocker itself (between selector and next rule)
    const blockerBlock = css.match(
      /\.vellum-blocker\s*\{([^}]*)\}/,
    )?.[1];
    expect(blockerBlock).toBeDefined();
    expect(blockerBlock).not.toMatch(/animation\s*:/);
  });

  it("seat-attention uses static box-shadow + ::after halo animation", () => {
    expect(css).toMatch(
      /\.vellum-node\[data-seat-attention="true"\]::after\s*\{[^}]*animation:\s*vellumSeatAttentionHalo/s,
    );
    // Parent attention rule must not animate box-shadow via keyframes assignment
    const parent = css.match(
      /\.vellum-node\[data-attention="fire"\],\s*\n\.vellum-node\[data-seat-attention="true"\]\s*\{([^}]*)\}/,
    )?.[1];
    expect(parent).toBeDefined();
    expect(parent).not.toMatch(/animation\s*:/);
    expect(parent).toMatch(/box-shadow\s*:/);
  });

  it("blocked-edge ripple does not animate stroke-dashoffset", () => {
    const body = keyframesBody("vellumEdgeRippleOpacity");
    expect(body).not.toMatch(/stroke-dashoffset/);
    expect(body).toMatch(/opacity\s*:/);
    // Dash pattern may remain static for interrupted-flow direction.
    expect(css).toMatch(
      /\.vellum-edge-ripple[\s\S]*?stroke-dasharray:\s*5 6/,
    );
  });

  it("legacy paint-heavy keyframe names are gone", () => {
    expect(css).not.toMatch(/@keyframes\s+vellumPulse\b/);
    expect(css).not.toMatch(/@keyframes\s+vellumDash\b/);
    expect(css).not.toMatch(/@keyframes\s+vellumSeatAttentionPulse\b/);
  });
});
