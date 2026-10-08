/**
 * Save-to-group picker in the multi-select menu: nine slots, each marked by
 * what it holds so the operator sees what a save replaces, and a new group.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { Schema } from "effect";
import { Node } from "@shared/model";
import { SaveToGroupPicker } from "../src/renderer/components/rts/SaveToGroupPicker";
import { emptyHotbarSlots, type HotbarSlot } from "../src/renderer/lib/hotbar-slots";
import { state$ } from "../src/renderer/lib/state";
import { modelStore } from "../src/renderer/lib/use-model";

const node = (id: string, text: string) => ({
  id,
  kind: "note" as const,
  text,
  x: 0,
  y: 0,
  width: 100,
  height: 60,
  z: 0,
});

const previousSlots = state$.hotbarSlots.peek();
const previousCanvas = state$.canvasName.peek();
const canvas = "group-picker-native";

afterEach(() => {
  state$.hotbarSlots.set(previousSlots);
  state$.canvasName.set(previousCanvas);
  modelStore.canvas$(canvas).nodes.set({});
});

describe("SaveToGroupPicker", () => {
  it("offers slots 1 to 9 and a new group, and says what each save replaces", () => {
    state$.canvasName.set(canvas);
    for (const input of [node("a", "Scout"), node("b", "Builder"), node("c", "Critic")]) {
      const native = Schema.decodeUnknownSync(Node)(input);
      modelStore.node$(canvas, native.id).set(native);
    }
    const slots: HotbarSlot[] = emptyHotbarSlots();
    slots[0] = { kind: "group", nodeIds: ["a", "b"] };
    slots[3] = { kind: "leased", nodeId: "c" };
    state$.hotbarSlots.set(slots);

    const html = renderToStaticMarkup(<SaveToGroupPicker count={3} onPick={() => undefined} />);
    const buttons = html.match(/<button/g) ?? [];
    expect(buttons).toHaveLength(10);
    expect(html).toContain("Save 3 nodes as a new group");
    expect(html).toContain('aria-label="Save 3 nodes to a command group"');
    expect(html).toContain('data-taken="held"');
    expect(html).toContain("Save 3 nodes to group 1, replaces Scout, Builder");
    expect(html).toContain('data-taken="lease"');
    expect(html).toContain("Save 3 nodes to group 4, replaces Critic");
    expect(html).toContain("Save 3 nodes to group 2, empty");
    expect(html).not.toContain("·");
  });
});
