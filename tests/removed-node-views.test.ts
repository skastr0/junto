import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TextNode } from "../src/shared/canvas";
import { dock$, noteSurfaceId, terminalSurfaceId } from "../src/renderer/lib/dock-state";
import {
  closeViewsOfNodes,
  installRemovedNodeViews,
  removedNodeIds,
} from "../src/renderer/lib/removed-node-views";
import { state$ } from "../src/renderer/lib/state";
import { initialWorkbenchState, openSurface } from "../src/renderer/lib/surface-registry";
import { terminalGrid$ } from "../src/renderer/lib/terminal-grid-state";
import { terminal$ } from "../src/renderer/lib/terminal-state";

const node = (id: string): TextNode => ({ id, type: "text", text: id, x: 0, y: 0, width: 200, height: 80 });

const openIds = (): string[] => dock$.registry.peek().surfaces.map((surface) => surface.id);

describe("a view never outlives its node", () => {
  const previous = {
    doc: state$.doc.peek(),
    canvasName: state$.canvasName.peek(),
    registry: dock$.registry.peek(),
  };
  let stop = (): void => {};

  beforeEach(() => {
    state$.canvasName.set("one");
    state$.doc.set({ nodes: [node("alpha"), node("bravo"), node("memo")], edges: [] });
    let registry = initialWorkbenchState();
    for (const surface of [
      { id: terminalSurfaceId("alpha"), kind: "terminal" as const },
      { id: terminalSurfaceId("bravo"), kind: "terminal" as const },
      { id: noteSurfaceId("memo"), kind: "note" as const },
    ]) {
      registry = openSurface(registry, surface).state;
    }
    dock$.registry.set(registry);
    stop = installRemovedNodeViews();
  });

  afterEach(() => {
    stop();
    terminalGrid$.set({ nodeIds: [], choice: "auto", page: 0 });
    terminal$.openByNodeId.set({});
    terminal$.gridOwnedByNodeId.set({});
    dock$.registry.set(previous.registry);
    state$.canvasName.set(previous.canvasName);
    state$.doc.set(previous.doc);
  });

  it("names the nodes that left", () => {
    expect([...removedNodeIds(new Set(["a", "b", "c"]), [{ id: "b" }, { id: "d" }])]).toEqual(["a", "c"]);
  });

  it("closes the surface of a removed node, whatever its kind, and leaves the rest", () => {
    state$.doc.set({ nodes: [node("bravo")], edges: [] });
    expect(openIds()).toEqual([terminalSurfaceId("bravo")]);
  });

  it("closes nothing when a node only changes", () => {
    state$.doc.set({ nodes: [{ ...node("alpha"), x: 40 }, node("bravo"), node("memo")], edges: [] });
    expect(openIds()).toHaveLength(3);
  });

  it("closes nothing when another canvas is opened", () => {
    state$.canvasName.set("two");
    state$.doc.set({ nodes: [node("elsewhere")], edges: [] });
    expect(openIds()).toHaveLength(3);
  });

  it("takes the node's cell out of the grid, and its grid-owned terminal view with it", () => {
    terminalGrid$.nodeIds.set(["alpha", "bravo", "gridded"]);
    terminal$.gridOwnedByNodeId.gridded.set(true);
    terminal$.openByNodeId.gridded.set(node("gridded"));

    closeViewsOfNodes(new Set(["gridded"]));
    expect(terminalGrid$.nodeIds.peek()).toEqual(["alpha", "bravo"]);
    expect(terminal$.openByNodeId.gridded.peek()).toBeUndefined();

    // The last cells go: the grid closes.
    closeViewsOfNodes(new Set(["alpha", "bravo"]));
    expect(terminalGrid$.nodeIds.peek()).toEqual([]);
    expect(openIds()).toEqual([noteSurfaceId("memo")]);
  });
});
