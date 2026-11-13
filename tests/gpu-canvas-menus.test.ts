/**
 * The canvas menus' state (track F): the pointer machine's menu intents become
 * the menu the shell draws. The pointer point is the right-click; a marquee's
 * menu opens beside the screen box the selection made.
 */

import { afterEach, describe, expect, it } from "vitest";
import { canvasMenu$, closeCanvasMenu, openCanvasMenu } from "../src/window/canvas/shell/canvas-menu";
import { state$ } from "../src/window/lib/state";

const at = { x: 120, y: 80 };
const screen = { x: 420, y: 260 };

afterEach(() => {
  closeCanvasMenu();
  state$.selectedNodeIds.set([]);
  state$.selectedNodeId.set("");
});

describe("a context-menu intent opens one menu", () => {
  it("opens the add deck at the pane point, keeping a region it came from", () => {
    openCanvasMenu({ kind: "menu", target: "pane", at, screen });
    expect(canvasMenu$.peek()).toEqual({ kind: "pane", at, screen });
    openCanvasMenu({ kind: "menu", target: "pane", nodeId: "r", at, screen });
    expect(canvasMenu$.peek()).toMatchObject({ kind: "pane", nodeId: "r" });
  });

  it("opens the seat menu for a card", () => {
    openCanvasMenu({ kind: "menu", target: "card", nodeId: "a", at, screen });
    expect(canvasMenu$.peek()).toEqual({ kind: "seat", nodeId: "a", screen });
  });

  it("opens the multi-select menu for a selection", () => {
    state$.selectedNodeIds.set(["a", "b"]);
    openCanvasMenu({ kind: "menu", target: "selection", at, screen });
    expect(canvasMenu$.peek()).toEqual({ kind: "selection", nodeIds: ["a", "b"], screen });
  });

  it("opens the connect menu with its sources", () => {
    openCanvasMenu({ kind: "connectMenu", targetId: "b", sourceIds: ["a", "c"], at, screen });
    expect(canvasMenu$.peek()).toEqual({ kind: "target", targetId: "b", sourceIds: ["a", "c"], screen });
  });

  it("has no menu for a wire, as today", () => {
    openCanvasMenu({ kind: "menu", target: "wire", wireId: "w", at, screen });
    expect(canvasMenu$.peek()).toBeNull();
  });

  it("places a marquee's menu beside the box it selected", () => {
    openCanvasMenu({ kind: "marqueeMenu", nodeIds: ["a", "b"], bounds: { x: 40, y: 60, width: 200, height: 100 } });
    expect(canvasMenu$.peek()).toMatchObject({
      kind: "selection",
      nodeIds: ["a", "b"],
      screen: { x: 40, y: 60 },
      anchor: { left: 40, top: 60, right: 240, bottom: 160 },
    });
  });

  it("closes to nothing", () => {
    openCanvasMenu({ kind: "menu", target: "pane", at, screen });
    closeCanvasMenu();
    expect(canvasMenu$.peek()).toBeNull();
  });
});
