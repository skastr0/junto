import { describe, expect, it } from "vitest";
import { clearSelection, replaceSelection, state$ } from "../src/renderer/lib/state";

describe("the same cards selected is not a new selection", () => {
  it("keeps the list it holds when the same ids come back in a new array or a new order", () => {
    clearSelection();
    replaceSelection({ nodeIds: ["a", "b", "c"] });
    const held = state$.selectedNodeIds.peek();
    let woken = 0;
    const stop = state$.selectedNodeIds.onChange(() => {
      woken += 1;
    });
    replaceSelection({ nodeIds: ["a", "b", "c"] });
    replaceSelection({ nodeIds: ["c", "a", "b"] });
    stop();
    expect(woken).toBe(0);
    expect(state$.selectedNodeIds.peek()).toBe(held);
    expect(state$.selectedNodeIds.peek()).toEqual(["a", "b", "c"]);
  });

  it("writes when a card joins, leaves or is swapped for another", () => {
    clearSelection();
    replaceSelection({ nodeIds: ["a", "b", "c"] });
    replaceSelection({ nodeIds: ["a", "b"] });
    expect(state$.selectedNodeIds.peek()).toEqual(["a", "b"]);
    replaceSelection({ nodeIds: ["a", "b", "d"] });
    expect(state$.selectedNodeIds.peek()).toEqual(["a", "b", "d"]);
    replaceSelection({ nodeIds: ["a", "b", "e"] });
    expect(state$.selectedNodeIds.peek()).toEqual(["a", "b", "e"]);
  });

  it("still follows the single subject and the edge", () => {
    clearSelection();
    replaceSelection({ nodeIds: ["a", "b"] });
    expect(state$.selectedNodeId.peek()).toBe("");
    replaceSelection({ nodeId: "a", nodeIds: ["a", "b"] });
    expect(state$.selectedNodeId.peek()).toBe("a");
    replaceSelection({ nodeId: "a" });
    expect(state$.selectedNodeIds.peek()).toEqual(["a"]);
    replaceSelection({ edgeId: "w" });
    expect(state$.selectedNodeIds.peek()).toEqual([]);
    expect(state$.selectedEdgeId.peek()).toBe("w");
  });
});
