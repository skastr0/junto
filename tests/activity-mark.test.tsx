/**
 * PERF-P1 — ActivityMark one continuous animation layer + a11y/size/tone.
 *
 * Counts continuously animated descendants (class hooks that own infinite
 * keyframes). Static track cells may exist; at most one animated layer.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityMark } from "../src/renderer/components/ActivityMark";
import { surfaceMotionLive$ } from "../src/renderer/lib/surface-motion";

const ANIMATED_CLASS = /class="[^"]*\b(vellum-activity-wave-head|vellum-activity-pulse-layer)\b[^"]*"/g;
const WAVE_HEAD = /vellum-activity-wave-head/g;
const PULSE_LAYER = /vellum-activity-pulse-layer/g;
const WAVE_CELL = /vellum-activity-wave-cell/g;
const CLOCK_CELL_LEGACY = /vellum-activity-clock-cell/g;
const PULSE_CELL_LEGACY = /vellum-activity-pulse-cell/g;

const count = (html: string, re: RegExp): number => {
  const matches = html.match(re);
  return matches?.length ?? 0;
};

const animatedLayerCount = (html: string): number => count(html, ANIMATED_CLASS);

afterEach(() => {
  surfaceMotionLive$.set(true);
});

describe("ActivityMark continuous animation budget", () => {
  it("wave: exactly one animated head; track cells are static", () => {
    const html = renderToStaticMarkup(
      <ActivityMark mode="wave" tone="cyan" label="working" size="node" />,
    );
    expect(animatedLayerCount(html)).toBe(1);
    expect(count(html, WAVE_HEAD)).toBe(1);
    expect(count(html, PULSE_LAYER)).toBe(0);
    expect(count(html, WAVE_CELL)).toBe(8);
    expect(count(html, CLOCK_CELL_LEGACY)).toBe(0);
    expect(count(html, PULSE_CELL_LEGACY)).toBe(0);
    expect(html).toContain('data-activity-mode="wave"');
    expect(html).toContain('data-activity-tone="cyan"');
    expect(html).toContain('data-activity-size="node"');
  });

  it("pulse: exactly one animated layer; no wave head / multi-cell pulse", () => {
    const html = renderToStaticMarkup(
      <ActivityMark
        mode="pulse"
        tone="green"
        label="Done — waiting for review"
        size="node"
      />,
    );
    expect(animatedLayerCount(html)).toBe(1);
    expect(count(html, PULSE_LAYER)).toBe(1);
    expect(count(html, WAVE_HEAD)).toBe(0);
    expect(count(html, WAVE_CELL)).toBe(0);
    expect(count(html, PULSE_CELL_LEGACY)).toBe(0);
    expect(html).toContain('data-activity-mode="pulse"');
  });

  it("static: zero continuous animation classes", () => {
    const html = renderToStaticMarkup(
      <ActivityMark mode="static" tone="steel" label="idle" size="node" />,
    );
    expect(animatedLayerCount(html)).toBe(0);
    expect(count(html, WAVE_HEAD)).toBe(0);
    expect(count(html, PULSE_LAYER)).toBe(0);
    expect(html).toContain('data-activity-mode="static"');
    expect(html).toContain("vellum-activity-static-dot");
  });

  it("active=false: static mark even when mode is wave", () => {
    const html = renderToStaticMarkup(
      <ActivityMark
        mode="wave"
        tone="crimson"
        label="blocked"
        active={false}
      />,
    );
    expect(animatedLayerCount(html)).toBe(0);
    expect(html).toContain('data-activity-mode="static"');
    expect(html).not.toContain("vellum-activity-wave-head");
  });

  it("surface motion paused: animated layers unmounted (static semantic mark)", () => {
    surfaceMotionLive$.set(false);
    const wave = renderToStaticMarkup(
      <ActivityMark mode="wave" tone="amber" label="needs input" />,
    );
    const pulse = renderToStaticMarkup(
      <ActivityMark mode="pulse" tone="green" label="complete" />,
    );
    expect(animatedLayerCount(wave)).toBe(0);
    expect(animatedLayerCount(pulse)).toBe(0);
    expect(wave).toContain('data-activity-mode="static"');
    expect(pulse).toContain('data-activity-mode="static"');
    expect(wave).not.toContain("vellum-activity-wave-head");
    expect(pulse).not.toContain("vellum-activity-pulse-layer");
  });
});

describe("ActivityMark a11y and sizing", () => {
  it("preserves role, aria-label, title for all modes", () => {
    for (const mode of ["wave", "pulse", "static"] as const) {
      const html = renderToStaticMarkup(
        <ActivityMark mode={mode} tone="cyan" label={`state-${mode}`} />,
      );
      expect(html).toContain('role="status"');
      expect(html).toContain('aria-label="state-' + mode + '"');
      expect(html).toContain('title="state-' + mode + '"');
    }
  });

  it("node footprint matches 3×3 grid (4px cell + 2px gap → 16px)", () => {
    const html = renderToStaticMarkup(
      <ActivityMark mode="wave" tone="cyan" label="working" size="node" />,
    );
    expect(html).toMatch(/width:\s*16px/);
    expect(html).toMatch(/height:\s*16px/);
  });

  it("inline footprint matches 3×3 grid (3px cell + 2px gap → 13px)", () => {
    const html = renderToStaticMarkup(
      <ActivityMark mode="wave" tone="cyan" label="working" size="inline" />,
    );
    expect(html).toMatch(/width:\s*13px/);
    expect(html).toMatch(/height:\s*13px/);
    expect(html).toContain('data-activity-size="inline"');
  });

  it("maps tones via ACTIVITY_TONE_HEX (token or hex) without dropping fill", () => {
    const tones = ["cyan", "crimson", "green", "amber", "steel"] as const;
    for (const tone of tones) {
      const html = renderToStaticMarkup(
        <ActivityMark mode="static" tone={tone} label={tone} />,
      );
      expect(html).toContain(`data-activity-tone="${tone}"`);
      // Theme tokens (`var(--color-*)`) or raw hex — either is a real fill.
      expect(html).toMatch(
        /background:\s*(#|var\(--color-)|background-color:\s*(#|var\(--color-)/,
      );
    }
  });
});

describe("ActivityMark visual structure snapshots", () => {
  it.each([
    ["wave", "cyan", "working"] as const,
    ["wave", "crimson", "blocked"] as const,
    ["pulse", "green", "complete"] as const,
    ["wave", "amber", "attention"] as const,
    ["static", "steel", "idle"] as const,
  ])("%s/%s structure", (mode, tone, label) => {
    surfaceMotionLive$.set(true);
    const html = renderToStaticMarkup(
      <ActivityMark mode={mode} tone={tone} label={label} size="node" />,
    );
    expect(html).toMatchSnapshot();
  });
});
