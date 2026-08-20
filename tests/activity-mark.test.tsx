/**
 * ActivityMark structure + a11y/size/tone.
 *
 * Original staggered-cell grammar: wave = 8 perimeter clock cells (bright
 * head, fading clockwise trail); pulse = 9 cells; static = single dot.
 * Discrete 90 ms clock lives in attention-clock.ts; CSS selects cells via
 * html[data-attention-phase] (see canvas-attention-motion.test.ts).
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { ActivityMark } from "../src/renderer/components/ActivityMark";
import { surfaceMotionLive$ } from "../src/renderer/lib/surface-motion";

const CLOCK_CELL = /vellum-activity-clock-cell/g;
const PULSE_CELL = /vellum-activity-pulse-cell/g;
const CLOCK_STEP = /--activity-clock-step/g;

const count = (html: string, re: RegExp): number => {
  const matches = html.match(re);
  return matches?.length ?? 0;
};

afterEach(() => {
  surfaceMotionLive$.set(true);
});

describe("ActivityMark cell structure", () => {
  it("wave: eight staggered clock cells, each carrying its step", () => {
    const html = renderToStaticMarkup(
      <ActivityMark mode="wave" tone="cyan" label="working" size="node" />,
    );
    expect(count(html, CLOCK_CELL)).toBe(8);
    expect(count(html, CLOCK_STEP)).toBe(8);
    expect(count(html, PULSE_CELL)).toBe(0);
    expect(html).toContain('data-activity-mode="wave"');
    expect(html).toContain('data-activity-tone="cyan"');
    expect(html).toContain('data-activity-size="node"');
  });

  it("pulse: full 3×3 grid of breathing cells — never the clockwise trail", () => {
    const html = renderToStaticMarkup(
      <ActivityMark
        mode="pulse"
        tone="green"
        label="Done — waiting for review"
        size="node"
      />,
    );
    expect(count(html, PULSE_CELL)).toBe(9);
    expect(count(html, CLOCK_CELL)).toBe(0);
    expect(html).toContain('data-activity-mode="pulse"');
  });

  it("static: no animated cell classes — single dot", () => {
    const html = renderToStaticMarkup(
      <ActivityMark mode="static" tone="steel" label="idle" size="node" />,
    );
    expect(count(html, CLOCK_CELL)).toBe(0);
    expect(count(html, PULSE_CELL)).toBe(0);
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
    expect(count(html, CLOCK_CELL)).toBe(0);
    expect(count(html, PULSE_CELL)).toBe(0);
    expect(html).toContain('data-activity-mode="static"');
  });

  it("surface motion paused: animated cells unmounted (static semantic mark)", () => {
    surfaceMotionLive$.set(false);
    const wave = renderToStaticMarkup(
      <ActivityMark mode="wave" tone="amber" label="needs input" />,
    );
    const pulse = renderToStaticMarkup(
      <ActivityMark mode="pulse" tone="green" label="complete" />,
    );
    expect(count(wave, CLOCK_CELL)).toBe(0);
    expect(count(wave, PULSE_CELL)).toBe(0);
    expect(count(pulse, CLOCK_CELL)).toBe(0);
    expect(count(pulse, PULSE_CELL)).toBe(0);
    expect(wave).toContain('data-activity-mode="static"');
    expect(pulse).toContain('data-activity-mode="static"');
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
