/**
 * The seed at the planner's seam: a planner that starts from a stored seed
 * hands every fact over once, owes nothing, and plans nothing; a board that
 * changed while the app was closed routes only what the move touched.
 */
import { describe, expect, it } from "vitest";
import { createLoomPlanner, type LoomCard, type LoomWireRow } from "../src/window/canvas/feed/loom-planner";

const cards: LoomCard[] = [
  { id: "a", x: 0, y: 0, width: 216, height: 96, region: false },
  { id: "b", x: 520, y: 0, width: 216, height: 96, region: false },
  { id: "c", x: 1040, y: 0, width: 216, height: 96, region: false },
];
const wires: LoomWireRow[] = [
  { id: "ab", from: "a", to: "b" },
  { id: "bc", from: "b", to: "c" },
];

describe("the planner's seed", () => {
  it("hands a launch the stored facts, owes nothing, and plans nothing", () => {
    const first = createLoomPlanner();
    const planned = first.plan(cards, wires);
    expect(planned.set.length).toBe(2);
    const seed = first.snapshot();
    expect(seed.geometry.length).toBe(3);
    expect(seed.facts.length).toBe(2);

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
    const seed = first.snapshot();

    const second = createLoomPlanner();
    second.seed(seed);
    const moved = cards.map((card) => (card.id === "c" ? { ...card, x: card.x + 400 } : card));
    second.begin(moved, wires);
    while (second.owed() > 0) second.step(Number.POSITIVE_INFINITY, () => 0);
    expect(second.stats().begins).toBe(1);
    expect(second.stats().routed).toBe(1);
  });
});
