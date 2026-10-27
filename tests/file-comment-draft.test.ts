/**
 * A press on the gutter's plus, as the anchor it writes (0.11 F7): the lines
 * a thread names are exactly the lines it quotes, even when the press covers
 * more than a comment may carry.
 */
import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { LINES_QUOTE_MAX, LinesAnchor } from "../src/shared/thread-subject";
import { lineAnchorOf, lineDraftOf, LINES_COMMENT_MAX } from "../src/renderer/lib/file-comments";

const block = (lines: number): string => Array.from({ length: lines }, (_, index) => `line ${String(index + 1)}`).join("\n");

describe("a line press", () => {
  it("writes the lines it names as the lines it quotes", () => {
    const draft = lineDraftOf({ start: 10, end: 12, quote: block(3) });
    expect(draft).toEqual({ start: 10, end: 12, quote: block(3) });
    expect(lineAnchorOf("src/big.ts", draft!)).toEqual({ kind: "lines", file: "src/big.ts", from: 10, to: 12, quote: block(3) });
    expect(Schema.is(LinesAnchor)(lineAnchorOf("src/big.ts", draft!))).toBe(true);
  });

  it("cuts a long press to what a comment carries, the quote and the range together", () => {
    const endless = lineDraftOf({ start: 5, end: 5 + LINES_COMMENT_MAX + 40 - 1, quote: block(LINES_COMMENT_MAX + 40) });
    expect(endless?.start).toBe(5);
    // The quote is bounded first, and the range is exactly the lines it still holds.
    expect(endless!.quote.length).toBeLessThanOrEqual(LINES_QUOTE_MAX);
    expect(endless!.end - endless!.start + 1).toBe(endless!.quote.split("\n").length);
    expect(endless!.quote.split("\n").length).toBeLessThan(LINES_COMMENT_MAX);
    // A press of exactly what a comment carries keeps every line of it.
    const fits = lineDraftOf({ start: 1, end: 20, quote: block(20) });
    expect(fits).toEqual({ start: 1, end: 20, quote: block(20) });
  });

  it("refuses a press on nothing but spaces, and reads a backwards drag the right way up", () => {
    expect(lineDraftOf({ start: 4, end: 6, quote: "   \n\t\n" })).toBeUndefined();
    expect(lineDraftOf({ start: 9, end: 7, quote: "a\nb\nc" })?.start).toBe(7);
  });
});
