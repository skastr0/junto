import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Layout contract for the mode deck agents column: leftover height must live
 * in the scrollable agent list, not as empty well under host/path controls.
 */
describe("node palette launch spacing", () => {
  const css = readFileSync(
    resolve(import.meta.dirname, "../src/renderer/components/node-palette/node-palette-mode-deck.css"),
    "utf8",
  );

  it("lets the agent list absorb free column height", () => {
    // Grouped selector: `.node-deck__agent-list, .node-deck__harness-pick …`
    const block = css.match(
      /\.node-deck__agent-list(?:\s*,\s*[^{]+)?\s*\{[^}]+\}/,
    );
    expect(block?.[0]).toMatch(/flex:\s*1\s+1\s+0/);
    expect(block?.[0]).toMatch(/min-height:\s*0/);
    expect(block?.[0]).toMatch(/overflow:\s*auto/);
  });

  it("keeps launch controls out of the flex growth race", () => {
    const block = css.match(/\.node-deck__launch-slot\s*\{[^}]+\}/);
    expect(block?.[0]).toMatch(/flex:\s*none/);
  });
});
