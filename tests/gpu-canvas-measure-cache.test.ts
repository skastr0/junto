// Text measurement is cached (issue 915): a width is measured once per font,
// tracking and text, and a note is typeset once per source and width.

import { describe, expect, it } from "vitest";
import type { PaintEnv, TextRun } from "../src/window/canvas/contract";
import { MEASURE_WIDTH } from "../src/window/canvas/contract";
import { createRunMeasure } from "../src/window/canvas/engine/text";
import { layoutNote } from "../src/window/canvas/paint/note-layout";

const run = (text: string, extra: Partial<TextRun> = {}): TextRun =>
  ({ text, font: "mono", size: 12, weight: 400, leading: 1.2, truncate: "end", width: MEASURE_WIDTH, ...extra }) as TextRun;

const countingContext = () => {
  const calls: string[] = [];
  const fonts: string[] = [];
  const ctx = {
    font: "",
    letterSpacing: "",
    measureText: (text: string) => {
      calls.push(text);
      fonts.push(ctx.font);
      return { width: text.length * 10 };
    },
  };
  return { ctx, calls, fonts };
};

describe("the run measure cache", () => {
  it("measures one font, tracking and text once, and again after a clear", () => {
    const { ctx, calls } = countingContext();
    const cache = createRunMeasure(ctx);
    expect(cache.measure(run("hello"), 2)).toBe(25);
    expect(cache.measure(run("hello"), 2)).toBe(25);
    expect(calls).toEqual(["hello"]);
    // A new tracking, size, scale or text is a new width.
    cache.measure(run("hello", { tracking: 0.05 }), 2);
    cache.measure(run("hello", { size: 13 }), 2);
    cache.measure(run("hello"), 1);
    cache.measure(run("hullo"), 2);
    expect(calls).toHaveLength(5);
    cache.clear();
    cache.measure(run("hello"), 2);
    expect(calls).toHaveLength(6);
  });
});

describe("the note layout cache", () => {
  it("typesets a source once per width, and again when the measurer answers differently", () => {
    let unit = 6;
    let measured = 0;
    const env: PaintEnv = {
      measure: (r) => {
        measured += 1;
        return r.text.length * unit;
      },
    };
    const source = "# Title\n\nSome words that wrap across a narrow note body.";
    const first = layoutNote(source, 120, { x: 4, y: 4 }, env);
    const afterFirst = measured;
    // The same source and width: the layout in hand, one probe measure.
    expect(layoutNote(source, 120, { x: 4, y: 4 }, env)).toBe(first);
    expect(measured - afterFirst).toBe(1);
    // A new width lays out again.
    const wide = layoutNote(source, 300, { x: 4, y: 4 }, env);
    expect(wide).not.toBe(first);
    // A font swapping in changes the probe: the kept layout is not used.
    unit = 7;
    expect(layoutNote(source, 300, { x: 4, y: 4 }, env)).not.toBe(wide);
  });
});
