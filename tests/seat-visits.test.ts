import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { activateNodeSurface } from "../src/window/lib/activate-node-surface";
import { openActorMirror } from "../src/window/lib/actor-mirrors";
import { focusCanvasNode } from "../src/window/lib/command-bar";
import { dock$ } from "../src/window/lib/dock-state";
import { buildFocusSwitcherCatalog } from "../src/window/lib/focus-switcher";
import { emptyHotbarSlots } from "../src/window/lib/hotbar-slots";
import { recordSeatVisit } from "../src/window/lib/seat-visits";
import { state$ } from "../src/window/lib/state";
import { initialWorkbenchState } from "../src/window/lib/surface-registry";
import { modelStore } from "../src/window/lib/use-model";
import { asCanvasName, type Seat } from "../src/shared/model";
import { note, seat } from "./support/model-nodes";

// Cmd+backtick cycles the seats the operator visited. Every way of bringing a
// seat up counts, and none of it touches the hotbar MRU that leases slots.
describe("seat visits", () => {
  const alpha = seat("alpha", { label: "Alpha" });
  const bravo = seat("bravo", { label: "Bravo" });
  const cy = seat("cy", { label: "Cy" });
  const memo = note("memo", "Field notes");
  const nodes = [alpha, bravo, cy, memo];

  let release = (): void => undefined;
  let previous = { canvas: "", registry: dock$.registry.peek(), mru: state$.hotbarActiveMru.peek() };

  beforeEach(() => {
    previous = { canvas: state$.canvasName.peek(), registry: dock$.registry.peek(), mru: state$.hotbarActiveMru.peek() };
    release = modelStore.adopt({ canvas: asCanvasName("visits"), seq: 0, nodes, wires: [] });
    state$.canvasName.set("visits");
    dock$.registry.set(initialWorkbenchState());
    state$.seatVisitOrder.set([]);
    state$.hotbarActiveMru.set([]);
  });

  afterEach(() => {
    state$.canvasName.set(previous.canvas);
    release();
    dock$.registry.set(previous.registry);
    state$.hotbarActiveMru.set(previous.mru);
    state$.seatVisitOrder.set([]);
  });

  const switcherOrder = (): string[] =>
    buildFocusSwitcherCatalog({
      nodes,
      focusNodeIds: [],
      hotbarSlots: emptyHotbarSlots(),
      recentIds: state$.seatVisitOrder.peek(),
    }).map((entry) => entry.nodeId);

  it("a card double-click opens the seat and moves it to the front of cmd+`", () => {
    expect(switcherOrder()).toEqual(["alpha", "bravo", "cy"]);
    activateNodeSurface("cy");
    expect(switcherOrder()).toEqual(["cy", "alpha", "bravo"]);
    activateNodeSurface("bravo");
    expect(switcherOrder()).toEqual(["bravo", "cy", "alpha"]);
  });

  it("a rail open moves the seat to the front", () => {
    openActorMirror(cy as Seat, "alpha");
    expect(switcherOrder()).toEqual(["cy", "alpha", "bravo"]);
  });

  it("cmd+K going to a seat moves it to the front", () => {
    focusCanvasNode("bravo");
    expect(switcherOrder()).toEqual(["bravo", "alpha", "cy"]);
  });

  it("a visit never touches the hotbar MRU, and a note is no visit", () => {
    activateNodeSurface("cy");
    recordSeatVisit("visits", "memo");
    expect(state$.hotbarActiveMru.peek()).toEqual([]);
    expect(state$.seatVisitOrder.peek()).toEqual(["cy"]);
  });
});
