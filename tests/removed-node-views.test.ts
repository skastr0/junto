import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asCanvasName, asNodeId } from "../src/shared/model";
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
import { modelStore } from "../src/renderer/lib/use-model";
import { note } from "./support/model-nodes";

const openIds = (): string[] => dock$.registry.peek().surfaces.map((surface) => surface.id);

describe("a view never outlives its node", () => {
  const previous = {
    canvasName: state$.canvasName.peek(),
    registry: dock$.registry.peek(),
  };
  let stop = (): void => {};
  let release: Array<() => void> = [];

  const hold = (canvas: string, ids: ReadonlyArray<string>): void => {
    release.push(
      modelStore.adopt({ canvas: asCanvasName(canvas), seq: 0, nodes: ids.map((id) => note(id)), wires: [] }),
    );
  };

  beforeEach(() => {
    hold("one", ["alpha", "bravo", "memo"]);
    state$.canvasName.set("one");
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
    for (const let_go of release) let_go();
    release = [];
  });

  it("names the nodes that left", () => {
    expect([...removedNodeIds(new Set(["a", "b", "c"]), ["b", "d"])]).toEqual(["a", "c"]);
  });

  it("closes the surface of a removed node, whatever its kind, and leaves the rest", () => {
    modelStore.applyChanged({
      canvas: asCanvasName("one"),
      seq: 1,
      nodes: [],
      wires: [],
      removedNodes: [asNodeId("alpha"), asNodeId("memo")],
      removedWires: [],
    });
    expect(openIds()).toEqual([terminalSurfaceId("bravo")]);
  });

  it("closes nothing when a node only changes", () => {
    modelStore.applyChanged({
      canvas: asCanvasName("one"),
      seq: 1,
      nodes: [note("alpha", "alpha", { x: 40 })],
      wires: [],
      removedNodes: [],
      removedWires: [],
    });
    expect(openIds()).toHaveLength(3);
  });

  it("closes nothing when another canvas is opened", () => {
    hold("two", ["elsewhere"]);
    state$.canvasName.set("two");
    expect(openIds()).toHaveLength(3);
  });

  it("closes nothing while the canvas is not held, and closes what left once it is read again", () => {
    for (const let_go of release) let_go();
    release = [];
    expect(openIds()).toHaveLength(3);
    hold("one", ["bravo"]);
    expect(openIds()).toEqual([terminalSurfaceId("bravo")]);
  });

  it("takes the node's cell out of the grid, and its grid-owned terminal view with it", () => {
    terminalGrid$.nodeIds.set(["alpha", "bravo", "gridded"]);
    terminal$.gridOwnedByNodeId.gridded.set(true);
    terminal$.openByNodeId.gridded.set({ id: "gridded", type: "text", text: "gridded", x: 0, y: 0, width: 200, height: 80 });

    closeViewsOfNodes(new Set(["gridded"]));
    expect(terminalGrid$.nodeIds.peek()).toEqual(["alpha", "bravo"]);
    expect(terminal$.openByNodeId.gridded.peek()).toBeUndefined();

    // The last cells go: the grid closes.
    closeViewsOfNodes(new Set(["alpha", "bravo"]));
    expect(terminalGrid$.nodeIds.peek()).toEqual([]);
    expect(openIds()).toEqual([noteSurfaceId("memo")]);
  });
});
