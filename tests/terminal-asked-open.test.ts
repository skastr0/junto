/**
 * Asking for one seat on its own (Open seat, cmd+k, the bar) when the grid
 * shows it: the grid closes, since it sits over a seat modal and would stay on
 * top of the one asked for. An open the product makes for itself leaves the
 * grid alone.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Node } from "../src/shared/model";
import { seat } from "./support/model-nodes";

const world = vi.hoisted(() => ({ nodes: new Map<string, unknown>() }));
vi.mock("../src/window/lib/use-model", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/window/lib/use-model")>()),
  nodeAt: (canvas: string, id: string) => (canvas === "factory" ? world.nodes.get(id) : undefined),
}));
// The real surface open takes the seat out of the grid's hands as it joins the workbench.
vi.mock("../src/window/lib/dock-state", async () => {
  const { terminal$ } = await import("../src/window/lib/terminal-state");
  return {
    openTerminalSurface: (node: Node) => {
      terminal$.gridOwnedByNodeId[node.id].delete();
      terminal$.openByNodeId[node.id].set(node as never);
    },
  };
});

import { openTerminal, openTerminalAsked } from "../src/window/lib/terminal-actions";
import { openTerminalGrid, terminalGrid$ } from "../src/window/lib/terminal-grid-state";
import { state$ } from "../src/window/lib/state";
import { terminal$ } from "../src/window/lib/terminal-state";

const one = seat("seat-1");
const two = seat("seat-2");
const three = seat("seat-3");
const oldCanvas = state$.canvasName.peek();

const reset = (): void => {
  terminalGrid$.nodeIds.set([]);
  terminal$.openByNodeId.set({});
  terminal$.gridOwnedByNodeId.set({});
  terminal$.gridCellByNodeId.set({});
};

beforeEach(() => {
  world.nodes.clear();
  for (const node of [one, two, three]) world.nodes.set(node.id, node);
  state$.canvasName.set("factory");
  reset();
  openTerminalGrid([one.id, two.id]);
});
afterEach(() => {
  reset();
  state$.canvasName.set(oldCanvas);
});

describe("opening a seat the grid shows, as the operator asked", () => {
  it("closes the grid, keeps the seat open, and lets go of the other cells", () => {
    expect(terminalGrid$.nodeIds.peek()).toEqual(["seat-1", "seat-2"]);
    void openTerminalAsked("factory", "seat-1");
    expect(terminalGrid$.nodeIds.peek()).toEqual([]);
    expect(terminal$.openByNodeId.peek()["seat-1"]).toBe(one);
    expect(terminal$.gridOwnedByNodeId.peek()["seat-1"]).toBeUndefined();
    expect(terminal$.openByNodeId.peek()["seat-2"]).toBeUndefined();
  });

  it("leaves the grid alone for a seat it does not show", () => {
    void openTerminalAsked("factory", "seat-3");
    expect(terminalGrid$.nodeIds.peek()).toEqual(["seat-1", "seat-2"]);
    expect(terminal$.openByNodeId.peek()["seat-3"]).toBe(three);
  });

  it("is not what the product does for itself: a plain open keeps the grid", () => {
    void openTerminal("factory", "seat-1");
    expect(terminalGrid$.nodeIds.peek()).toEqual(["seat-1", "seat-2"]);
  });
});
