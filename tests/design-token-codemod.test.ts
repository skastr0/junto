import { describe, expect, it } from "vitest";
import { convert, convertRules, leadingToken, radiusToken, textToken, trackingToken } from "../scripts/design-token-codemod";
import { scan } from "../scripts/lint-design-tokens";

describe("design token codemod", () => {
  it("maps every legacy text size to its nearest step", () => {
    const sizes = [7, 8, 9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13, 14, 15, 16, 17, 18, 19, 21, 22, 24, 26];
    expect(sizes.map(textToken)).toEqual([
      "micro", "micro", "caption", "label", "label", "body", "body", "body-lg", "body-lg", "body-lg", "body-lg",
      "title", "title", "title", "display", "display", "display", "hero", "hero", "hero", "hero",
    ]);
    expect(textToken(38)).toBeUndefined();
  });

  it("maps tracking, leading and radius to their steps", () => {
    expect([0, 0.01, 0.02, 0.04, 0.06, 0.08, 0.1, 0.12, 0.14, 0.16, 0.18].map(trackingToken)).toEqual([
      "flat", "flat", "soft", "soft", "label", "label", "label", "eyebrow", "eyebrow", "eyebrow", "eyebrow",
    ]);
    expect(trackingToken(0.28)).toBeUndefined();
    expect([1.05, 1.2, 1.25, 1.3, 1.35, 1.4, 1.45, 1.5, 1.55, 1.6, 1.7].map(leadingToken)).toEqual([
      "compact", "compact", "compact", "dense", "dense", "body", "body", "body", "open", "open", "open",
    ]);
    expect(leadingToken(1)).toBeUndefined();
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 14, 999, 9999].map(radiusToken)).toEqual([
      "sm", "sm", "sm", "sm", "md", "md", "lg", "lg", "lg", "xl", "xl", "xl", "pill", "pill",
    ]);
    expect(radiusToken(28)).toBeUndefined();
    expect(radiusToken(0)).toBeUndefined();
  });

  it("rewrites css declarations and reports how many changed value", () => {
    const css = ".a { font-size: 10px; letter-spacing: .12em; line-height: 1.55; border-radius: 7px 7px 0 0; }";
    const result = convert(css, ".css");
    expect(result.text).toBe(
      ".a { font-size: var(--text-label); letter-spacing: var(--tracking-eyebrow); line-height: var(--leading-open); border-radius: var(--radius-lg) var(--radius-lg) 0 0; }",
    );
    expect(result.converted).toBe(5);
    expect(result.moved).toBe(4);
    expect(scan(result.text, ".css")).toEqual([]);
  });

  it("leaves resets, relative sizes, tokens and out of reach values in css", () => {
    const css = [
      ".a { line-height: 1; letter-spacing: 0; font-size: 0.9em; border-radius: 50%; }",
      ".b { font-size: var(--text-body); border-radius: 0; line-height: 20px; }",
      ".c { font-size: clamp(26px, 4vw, 42px); border-radius: 28px 14px 14px 28px; }",
    ].join("\n");
    const result = convert(css, ".css");
    expect(result.text).toBe(css);
    expect(result.left).toEqual(["border-radius: 28px 14px 14px 28px"]);
  });

  it("rewrites arbitrary classes in a component and lists inline styles", () => {
    const tsx = '<p className="rounded-[5px] rounded-t-[10px] text-[13px] tracking-[0.1em] leading-[1.5]" style={{ fontSize: 12 }} />';
    const result = convert(tsx, ".tsx");
    expect(result.text).toBe(
      '<p className="rounded-md rounded-t-xl text-body-lg tracking-label leading-body" style={{ fontSize: 12 }} />',
    );
    expect(result.left).toEqual(["fontSize: 12"]);
  });

  it("converts only the rules whose selector is named, in a shared stylesheet", () => {
    const css = [
      ".station-bar { font-size: 13px; }",
      ".canvas-node { font-size: 13px; border-radius: 7px; }",
      "@media (max-width: 600px) { .command-bar__row { border-radius: 7px; } .canvas-node { border-radius: 7px; } }",
    ].join("\n");
    const result = convertRules(css, [".station-", ".command-bar"]);
    expect(result.text).toBe(
      [
        ".station-bar { font-size: var(--text-body-lg); }",
        ".canvas-node { font-size: 13px; border-radius: 7px; }",
        "@media (max-width: 600px) { .command-bar__row { border-radius: var(--radius-lg); } .canvas-node { border-radius: 7px; } }",
      ].join("\n"),
    );
    expect(result.converted).toBe(2);
  });

  it("is stable: a converted file converts to itself", () => {
    const once = convert(".a { font-size: 13px; border-radius: 999px; }", ".css").text;
    expect(convert(once, ".css").text).toBe(once);
    expect(convert(once, ".css").converted).toBe(0);
  });
});
