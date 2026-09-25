/**
 * Save-to-group picker in the multi-select menu: nine slots, each marked by
 * what it holds so the operator sees what a save replaces.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import type { CanvasDoc } from "@shared/canvas";
import { SaveToGroupPicker } from "../src/renderer/components/rts/SaveToGroupPicker";
import { emptyHotbarSlots, type HotbarSlot } from "../src/renderer/lib/hotbar-slots";
import { state$ } from "../src/renderer/lib/state";

const node = (id: string, text: string) => ({
  id,
  type: "text" as const,
  text,
  x: 0,
  y: 0,
  width: 100,
  height: 60,
});

const previousDoc = state$.doc.peek();
const previousSlots = state$.hotbarSlots.peek();

afterEach(() => {
  state$.doc.set(previousDoc);
  state$.hotbarSlots.set(previousSlots);
});

describe("SaveToGroupPicker", () => {
  it("offers slots 1 to 9 and says what each save replaces", () => {
    state$.doc.set({
      ...previousDoc,
      nodes: [node("a", "Scout"), node("b", "Builder"), node("c", "Critic")],
      edges: [],
    } as CanvasDoc);
    const slots: HotbarSlot[] = emptyHotbarSlots();
    slots[0] = { kind: "group", nodeIds: ["a", "b"] };
    slots[3] = { kind: "leased", nodeId: "c" };
    state$.hotbarSlots.set(slots);

    const html = renderToStaticMarkup(<SaveToGroupPicker count={3} onPick={() => undefined} />);
    const buttons = html.match(/<button/g) ?? [];
    expect(buttons).toHaveLength(9);
    expect(html).toContain('aria-label="Save 3 nodes to a command group"');
    expect(html).toContain('data-taken="held"');
    expect(html).toContain("Save 3 nodes to group 1, replaces Scout, Builder");
    expect(html).toContain('data-taken="lease"');
    expect(html).toContain("Save 3 nodes to group 4, replaces Critic");
    expect(html).toContain("Save 3 nodes to group 2, empty");
    expect(html).not.toContain("·");
  });
});
