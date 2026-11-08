/**
 * A full-window dim carries no backdrop blur.
 *
 * A backdrop filter is re-captured on every presented frame whose backdrop
 * changed, so a blurred dim over the turning canvas costs one full render
 * surface per frame. Measured on the factory board (M1 mini, 1920x1080 1x
 * 60 Hz, display attached): one blurred dim sat the GPU thread on its
 * ceiling, 832 ms/s of 1000; a second, stacked, took presented frames from
 * 55 to 36 a second and drove CoreAnimation backpressure to p95 27 ms,
 * which WindowServer presents as a torn layer stack, the canvas and the
 * lower modal showing through the active one. Dims without the blur run
 * 60 fps at 415 ms/s with no backpressure. The operator chose the look
 * without the blur (2026-11-08).
 *
 * The lock is structural: any rule that makes a box cover its container
 * (`position: fixed` or `absolute` with `inset: 0`) and paints a background
 * is a dim, and a dim never blurs. Chrome that floats at its own size (a
 * popover, a pill) is not touched by it.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const WINDOW = join(__dirname, "..", "src/window");

const cssFiles = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...cssFiles(path));
    else if (entry.endsWith(".css")) out.push(path);
  }
  return out;
};

type Rule = { readonly selector: string; readonly body: string };

/** Every `selector { … }` block in a stylesheet, comments removed. */
const rules = (css: string): Rule[] => {
  const bare = css.replace(/\/\*[\s\S]*?\*\//gu, "");
  const out: Rule[] = [];
  for (const block of bare.split("}")) {
    const at = block.lastIndexOf("{");
    if (at < 0) continue;
    const selector = (block.slice(0, at).split("\n").at(-1) ?? "").trim();
    out.push({ selector, body: block.slice(at + 1) });
  }
  return out;
};

/** A box that covers its container and paints something over it. */
const isDim = (body: string): boolean =>
  /(?:^|[\s;])position:\s*(?:fixed|absolute)\s*;/u.test(body) &&
  /(?:^|[\s;])inset:\s*0(?:px)?\s*;/u.test(body) &&
  /(?:^|[\s;])background(?:-color)?:\s*[^;]+/u.test(body);

describe("full-window dims", () => {
  it.each([
    ["src/window/styles/layers.css", "[data-layer-backdrop]"],
    ["src/window/components/quick-open/quick-open.css", ".quick-open__scrim"],
    ["src/window/styles.css", ".machines-opening"],
    ["src/window/styles.css", ".native-terminal-surface__dead"],
  ])("%s %s has no backdrop blur", (path, selector) => {
    const css = readFileSync(join(__dirname, "..", path), "utf8");
    const found = rules(css).filter((rule) => rule.selector === selector);
    expect(found.length, `${selector} is styled`).toBeGreaterThan(0);
    for (const rule of found) expect(rule.body, selector).not.toMatch(/backdrop-filter/u);
  });

  it("no dim in the window's stylesheets has one", () => {
    const blurred: string[] = [];
    for (const path of cssFiles(WINDOW)) {
      for (const rule of rules(readFileSync(path, "utf8"))) {
        if (!isDim(rule.body)) continue;
        if (!/backdrop-filter/u.test(rule.body)) continue;
        blurred.push(`${relative(join(__dirname, ".."), path)} ${rule.selector}`);
      }
    }
    expect(blurred).toEqual([]);
  });
});
