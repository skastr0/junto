/**
 * The terminal hides xterm's own scrollbar, and the rule names the class
 * xterm really emits. When xterm 6.1 prefixed its scrollbar classes the old
 * `.scrollbar` selector matched nothing, the bar came back, and every scroll
 * frame paid a layout and a page-wide compositor update for its slider.
 * display:none (not opacity) is what makes the slider's writes free.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const styles = readFileSync(join(root, "src/renderer/styles.css"), "utf8");
const xtermScrollbar = readFileSync(
  join(root, "node_modules/@xterm/xterm/src/browser/scrollable/abstractScrollbar.ts"),
  "utf8",
);

it("xterm still names its scrollbar xterm-scrollbar", () => {
  expect(xtermScrollbar).toMatch(/'xterm-visible xterm-scrollbar /);
  expect(xtermScrollbar).toMatch(/'xterm-invisible xterm-scrollbar /);
});

it("the terminal surface takes xterm's scrollbar out of layout", () => {
  const rule = /\.native-terminal-surface__xterm \.xterm-scrollable-element > \.xterm-scrollbar \{([^}]*)\}/.exec(styles);
  expect(rule, "a rule for .xterm-scrollbar under the terminal surface").not.toBeNull();
  expect(rule![1]).toMatch(/display:\s*none\s*!important/);
});
