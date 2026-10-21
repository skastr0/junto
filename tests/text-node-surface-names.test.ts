/**
 * A note or a label takes keyboard focus twice: the card, named by React
 * Flow, then the surface inside it that opens the editor. The surface is a
 * button, so it has to say what it does and to what, or a screen reader
 * lands on a nameless control.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const source = readFileSync(join(root, "src/renderer/components/nodes/TextNode.tsx"), "utf8");

describe("text node surfaces", () => {
  it("names every focusable surface", () => {
    const buttons = source.match(/role="button"[\s\S]*?className="[^"]*"/g) ?? [];
    expect(buttons.length).toBeGreaterThanOrEqual(2);
    for (const button of buttons) expect(button).toContain("aria-label={surfaceName}");
  });

  it("names the surface by its verb, its kind and the node's own name", () => {
    expect(source).toContain("`Edit ${node.kind}, ${titleOf(node)}`");
  });
});
