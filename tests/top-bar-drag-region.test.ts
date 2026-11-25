/**
 * The top bar is a window drag region on darwin, and a drag region ignores
 * z-index. One rule keeps every overlay that crosses the bar from handing its
 * clicks to the window drag: while a dialog, a menu or a listbox of the page
 * is open, the bar is no drag region. This locks that rule's shape; the real
 * app proves the cascade (e2e/scenarios/top-bar-drag.spec.ts).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(__dirname, "..", "src", "window", "styles.css"), "utf8");

/** Every rule of the sheet as [selector, body], comments out, nesting ignored (the sheet has none at this level). */
const rules = (): ReadonlyArray<readonly [string, string]> =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => [match[1]!.trim(), match[2]!.trim()] as const);

describe("the top bar drag region", () => {
  const whileOpen = rules().find(
    ([selector, body]) => selector.startsWith('html[data-junto-platform="darwin"]:has(') && selector.endsWith(".station-bar") && /-webkit-app-region:\s*no-drag/.test(body),
  );

  it("stops being a drag region while any dialog, menu or page listbox is open", () => {
    expect(whileOpen, "a rule that takes the bar out of the drag while an overlay is open").toBeDefined();
    const selector = whileOpen![0];
    for (const part of ['[role="dialog"]', '[role="menu"]', '[role="listbox"]:not(.station-bar *)']) expect(selector).toContain(part);
  });

  it("comes after the rule that makes the bar a drag region, so it wins at equal weight", () => {
    const all = rules();
    const drag = all.findIndex(([selector, body]) => selector === 'html[data-junto-platform="darwin"] .station-bar' && /-webkit-app-region:\s*drag/.test(body));
    const open = all.findIndex(([selector]) => selector === whileOpen?.[0]);
    expect(drag).toBeGreaterThanOrEqual(0);
    expect(open).toBeGreaterThan(drag);
  });
});
