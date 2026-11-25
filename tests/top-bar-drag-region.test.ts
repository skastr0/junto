/**
 * The top bar is a window drag region on darwin, and a drag region ignores
 * z-index. One rule keeps every overlay that crosses the bar from handing its
 * clicks to the window drag: while an overlay is open, the bar is no drag
 * region. The overlays say so with one counted attribute on <html>
 * (lib/overlay-open.ts); the rule keys on it alone, because a :has() on the
 * root invalidates the whole document at every DOM change. This locks the
 * rule's shape; the real app proves the cascade (e2e/scenarios/top-bar-drag.spec.ts).
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(__dirname, "..", "src", "window", "styles.css"), "utf8");

/** Every rule of the sheet as [selector, body], comments out, nesting ignored (the sheet has none at this level). */
const rules = (): ReadonlyArray<readonly [string, string]> =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => [match[1]!.trim(), match[2]!.trim()] as const);

/** A `:has()` on the document, the body or the root element itself, whatever else the same compound says. */
const ON_THE_ROOT = /(^|[\s,>+~])(html|body|:root)(\[[^\]]*\]|\.[\w-]+|#[\w-]+|:(?!has\b)[\w-]+(\([^)]*\))?)*:has\(/;

/** Every stylesheet the window ships: the shared sheet and each component's. */
const stylesheets = (dir: string): ReadonlyArray<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((item) =>
    item.isDirectory() ? stylesheets(join(dir, item.name)) : item.name.endsWith(".css") ? [join(dir, item.name)] : [],
  );

describe("the :has() on the root that this must never come back to", () => {
  it("is recognised on the document, the body and the root, with other parts on the same compound", () => {
    for (const bad of [
      'html:has([role="dialog"]) .x',
      'html[data-junto-platform="darwin"]:has(.a) .station-bar',
      "body:has(.a)",
      ":root:has(.a) .x",
      "a, html.dark:has(.a)",
    ]) expect(ON_THE_ROOT.test(bad), bad).toBe(true);
    for (const fine of [".card:has(.a)", "html .card:has(.a)", 'html[data-junto-overlay="open"] .station-bar', ".menu:has(button)"]) {
      expect(ON_THE_ROOT.test(fine), fine).toBe(false);
    }
  });
});

describe("the top bar drag region", () => {
  const whileOpen = rules().find(
    ([selector, body]) => selector.endsWith(".station-bar") && selector.includes('[data-junto-overlay="open"]') && /-webkit-app-region:\s*no-drag/.test(body),
  );

  it("stops being a drag region while an overlay is open, keyed on the one attribute the overlays set", () => {
    expect(whileOpen, "a rule that takes the bar out of the drag while an overlay is open").toBeDefined();
    expect(whileOpen![0]).toBe('html[data-junto-platform="darwin"][data-junto-overlay="open"] .station-bar');
  });

  it("uses no :has() on the document or the body anywhere: it invalidates the whole document at every DOM change (about 20x the dialog open on a large canvas)", () => {
    const offenders = stylesheets(join(__dirname, "..", "src"))
      .map((path) => [path, readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "")] as const)
      .flatMap(([path, text]) => [...text.matchAll(/([^{}]*)\{/g)].map((match) => [path, match[1]!.trim()] as const))
      .filter(([, selector]) => ON_THE_ROOT.test(selector));
    expect(offenders.map(([path, selector]) => `${path.replace(__dirname, "")}: ${selector}`)).toEqual([]);
  });

  it("comes after the rule that makes the bar a drag region, so it wins at equal weight", () => {
    const all = rules();
    const drag = all.findIndex(([selector, body]) => selector === 'html[data-junto-platform="darwin"] .station-bar' && /-webkit-app-region:\s*drag/.test(body));
    const open = all.findIndex(([selector]) => selector === whileOpen?.[0]);
    expect(drag).toBeGreaterThanOrEqual(0);
    expect(open).toBeGreaterThan(drag);
  });

  it("is told by the modal stack and by a floating menu or panel, and a panel under the bar says nothing", () => {
    const src = (path: string) => readFileSync(join(__dirname, "..", "src", "window", path), "utf8");
    // The stack holds it for every modal; the shell opts a panel under the bar out.
    expect(src("lib/modal-stack.ts")).toContain("holdOverlay()");
    expect(src("components/operator-modal/OperatorModalShell.tsx")).toContain("coversBar: !belowBar");
    for (const file of ["components/ui/Popover.tsx", "components/ui/Dropdown.tsx", "components/node-palette/AgentCascadeMenu.tsx"]) {
      expect(src(file), file).toContain("useOverlayHold(");
    }
  });
});
