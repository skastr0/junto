/**
 * The seed at the planner's seam: a planner that starts from a stored seed
 * hands every fact over once, owes nothing, and plans nothing; a board that
 * changed while the app was closed routes only what the move touched.
 */
import { describe, expect, it } from "vitest";
import { createLoomPlanner, type LoomCard, type LoomWireRow } from "../src/window/canvas/feed/loom-planner";
import { LOOM_ROUTER_VERSION, type LoomSeed } from "../src/window/canvas/feed/loom-seed";

const cards: LoomCard[] = [
  { id: "a", x: 0, y: 0, width: 216, height: 96, region: false },
  { id: "b", x: 520, y: 0, width: 216, height: 96, region: false },
  { id: "c", x: 1040, y: 0, width: 216, height: 96, region: false },
];
const wires: LoomWireRow[] = [
  { id: "ab", from: "a", to: "b" },
  { id: "bc", from: "b", to: "c" },
];

/** A seed as the store would hand it back: the first plan's whole rows. */
const seedOf = (planner: ReturnType<typeof createLoomPlanner>): LoomSeed => {
  const change = planner.snapshot();
  return { version: LOOM_ROUTER_VERSION, meta: change.meta, cards: change.cards, wires: change.wires };
};

describe("the planner's seed", () => {
  it("hands a launch the stored facts, owes nothing, and plans nothing", () => {
    const first = createLoomPlanner();
    const planned = first.plan(cards, wires);
    expect(planned.set.length).toBe(2);
    const seed = seedOf(first);
    expect(seed.cards.length).toBe(3);
    expect(seed.wires.length).toBe(2);

    const second = createLoomPlanner();
    second.seed(seed);
    const replay = second.begin(cards, wires);
    expect(replay.set.map((fact) => fact.id).sort()).toEqual(["ab", "bc"]);
    expect(replay.remove).toEqual([]);
    expect(second.owed()).toBe(0);
    expect(second.stats().begins).toBe(0);
    // A second begin on the same board sends nothing: the engine has them.
    expect(second.begin(cards, wires).set).toEqual([]);
  });

  it("routes only the wires a move touched, from a stale seed", () => {
    const first = createLoomPlanner();
    first.plan(cards, wires);
    const seed = seedOf(first);

    const second = createLoomPlanner();
    second.seed(seed);
    const moved = cards.map((card) => (card.id === "c" ? { ...card, x: card.x + 400 } : card));
    second.begin(moved, wires);
    while (second.owed() > 0) second.step(Number.POSITIVE_INFINITY, () => 0);
    expect(second.stats().begins).toBe(1);
    expect(second.stats().routed).toBe(1);
    // A one-card move writes one card row and the wire it re-routed.
    const change = second.snapshot();
    expect(change.cards.map((card) => card.nodeId)).toEqual(["c"]);
    expect(change.wires.map((wire) => wire.wireId)).toEqual(["bc"]);
    expect(change.removedCards).toEqual([]);
    expect(change.removedWires).toEqual([]);
  });
});
