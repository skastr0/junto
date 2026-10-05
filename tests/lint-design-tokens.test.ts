import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { scan } from "../scripts/lint-design-tokens";

const ROOT = path.resolve(import.meta.dirname, "..");
const LINT = path.join(ROOT, "scripts/lint-design-tokens.ts");

const rules = (source: string, ext: string): string[] => scan(source, ext).map((hit) => hit.rule);

describe("lint:design-tokens", () => {
  it("passes on the current tree: no file holds more literals than its baseline", () => {
    const result = spawnSync("bun", [LINT], { cwd: ROOT, encoding: "utf8" });
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });

  it("counts a css literal for each rule", () => {
    expect(rules(".a { font-size: 11px; }", ".css")).toEqual(["font-size"]);
    expect(rules(".a { font-family: ui-monospace, monospace; }", ".css")).toEqual(["font-family"]);
    expect(rules(".a { letter-spacing: .14em; }", ".css")).toEqual(["tracking"]);
    expect(rules(".a { line-height: 1.55; }", ".css")).toEqual(["leading"]);
    expect(rules(".a { border-radius: 7px 7px 0 0; }", ".css")).toEqual(["radius"]);
    expect(rules(".a { color: #e8a33d; }", ".css")).toEqual(["color"]);
    expect(rules(".a { background: rgba(0, 0, 0, 0.4); }", ".css")).toEqual(["color"]);
  });

  it("lets tokens, keywords and unitless resets through in css", () => {
    const clean = `
      .a { font-size: var(--text-body); font-family: var(--font-mono); }
      .b { letter-spacing: var(--tracking-label); line-height: var(--leading-body); }
      .c { letter-spacing: 0; line-height: 1; font-size: inherit; font-size: 0.9em; }
      .d { border-radius: inherit; border-radius: 50%; border-radius: 0; color: var(--color-ink); }
      /* font-size: 11px; a comment is not a declaration */
      #root { color: var(--color-ink); }
    `;
    expect(scan(clean, ".css")).toEqual([]);
  });

  it("counts an arbitrary class and an inline style in a component", () => {
    expect(rules('<p className="text-[11px]" />', ".tsx")).toEqual(["font-size"]);
    expect(rules('<p className="tracking-[0.14em] leading-[1.5]" />', ".tsx")).toEqual(["tracking", "leading"]);
    expect(rules('<p className="rounded-[5px] rounded-t-[7px]" />', ".tsx")).toEqual(["radius", "radius"]);
    expect(rules('<p style={{ fontSize: "11px" }} />', ".tsx")).toEqual(["font-size"]);
    expect(rules('<p style={{ fontFamily: "ui-monospace" }} />', ".tsx")).toEqual(["font-family"]);
    expect(rules('const ink = "#d8d2c4";', ".ts")).toEqual(["color"]);
  });

  it("lets token classes through in a component", () => {
    const clean = '<p className="text-label text-ink tracking-eyebrow leading-body rounded-md font-mono bg-ink/[0.04]" />';
    expect(scan(clean, ".tsx")).toEqual([]);
  });

  it("reports the line of each literal", () => {
    expect(scan(".a {\n  color: red;\n  font-size: 13px;\n}", ".css")).toEqual([
      { rule: "font-size", line: 3, text: "font-size: 13px" },
    ]);
  });
});
