/**
 * Chrome that floats over the canvas carries no backdrop blur. A ring turning
 * anywhere on the canvas damages the frame under the chrome, so a blur there
 * was redrawn on every display frame. With the three of them the GPU worked
 * 114 ms/s on the operator's board at the overview, 30 without (idle probe).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (path: string): string => readFileSync(join(__dirname, "..", path), "utf8");

/** The declarations of the first rule whose selector is exactly `selector`. */
const rule = (css: string, selector: string): string => {
  const at = css.indexOf(`${selector} {`);
  expect(at, `${selector} is styled`).toBeGreaterThanOrEqual(0);
  return css.slice(at, css.indexOf("}", at));
};

describe("canvas chrome", () => {
  it.each([
    ["src/window/styles.css", ".react-flow__controls"],
    ["src/window/styles.css", ".node-deck-trigger"],
    ["src/window/components/rts/RtsBottomBar.css", ".rts-field-tools__fit"],
  ])("%s %s has no backdrop blur", (path, selector) => {
    expect(rule(read(path), selector)).not.toMatch(/backdrop-filter/);
  });
});
