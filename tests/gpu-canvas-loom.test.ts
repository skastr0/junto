/**
 * The GPU canvas's loom (track D): the planners `CanvasLoom` runs, fed from
 * card rectangles and wires with no React Flow. A first plan answers every
 * wire; a repeat answers nothing; a change answers only the wires it can have
 * altered; a cable's members and a detour carry points.
 */
import { describe, expect, it } from "vitest";
import { createLoomPlanner, type LoomCard, type LoomWireRow } from "../src/window/canvas/feed/loom";
import { polylineHitsObstacles } from "../src/shared/wire-route";

const card = (id: string, x: number, y: number, width = 260, height = 96, region = false): LoomCard => ({
  id,
  x,
  y,
  width,
  height,
  region,
});

const wire = (id: string, from: string, to: string): LoomWireRow => ({ id, from, to });

const byId = <T extends { readonly id: string }>(items: ReadonlyArray<T>): Map<string, T> =>
  new Map(items.map((item) => [item.id, item] as const));

describe("the loom planner", () => {
  it("gives an open run its anchors and no points, so the engine draws the elbow", () => {
    const planner = createLoomPlanner();
    const update = planner.plan([card("a", 0, 0), card("b", 600, 0)], [wire("w", "a", "b")]);
    expect(update.remove).toEqual([]);
    expect(update.set).toHaveLength(1);
    const fact = update.set[0]!;
    expect(fact).toMatchObject({
      id: "w",
      sourceSide: "right",
      targetSide: "left",
      source: { x: 260, y: 48 },
      target: { x: 600, y: 48 },
      cable: false,
    });
    expect(fact.points).toBeUndefined();
  });

  it("routes a wire around a card in its way, as points that miss every obstacle", () => {
    const planner = createLoomPlanner();
    const wall = card("wall", 300, -40, 120, 176);
    const update = planner.plan([card("a", 0, 0), card("b", 700, 0), wall], [wire("w", "a", "b")]);
    const fact = update.set.find((f) => f.id === "w")!;
    expect(fact.points).toBeDefined();
    expect(fact.points!.length).toBeGreaterThan(2);
    expect(fact.points![0]).toEqual(fact.source);
    expect(fact.points![fact.points!.length - 1]).toEqual(fact.target);
    expect(polylineHitsObstacles(fact.points!, [wall])).toBe(false);
  });

  it("sends nothing for a board that has not changed", () => {
    const planner = createLoomPlanner();
    const cards = [card("a", 0, 0), card("b", 700, 0), card("wall", 300, -40, 120, 176)];
    const wires = [wire("w", "a", "b")];
    planner.plan(cards, wires);
    const again = planner.plan(cards.map((c) => ({ ...c })), wires.map((w) => ({ ...w })));
    expect(again).toEqual({ set: [], remove: [] });
  });

  it("answers only the wires a moved card can have changed", () => {
    const planner = createLoomPlanner();
    const cards = [
      card("a", 0, 0),
      card("b", 700, 0),
      card("c", 0, 2000),
      card("d", 700, 2000),
      card("far", 3000, 3000),
    ];
    const wires = [wire("near", "a", "b"), wire("distant", "c", "d")];
    planner.plan(cards, wires);
    // Dropping a card far from both wires touches neither.
    const moved = cards.map((c) => (c.id === "far" ? { ...c, x: 3100 } : c));
    expect(planner.plan(moved, wires)).toEqual({ set: [], remove: [] });
    // Moving one end of one wire answers that wire and not the other.
    const dropped = moved.map((c) => (c.id === "b" ? { ...c, y: 120 } : c));
    const update = planner.plan(dropped, wires);
    expect(update.set.map((f) => f.id)).toEqual(["near"]);
    // Sides follow where the cards sit now: the wire meets the card where it faces.
    expect(update.set[0]!.target).not.toEqual({ x: 700, y: 48 });
  });

  it("sends a removed wire, and a first plan after a reset answers every wire", () => {
    const planner = createLoomPlanner();
    const cards = [card("a", 0, 0), card("b", 600, 0), card("c", 0, 400)];
    const first = planner.plan(cards, [wire("one", "a", "b"), wire("two", "a", "c")]);
    expect(first.set.map((f) => f.id).sort()).toEqual(["one", "two"]);
    const after = planner.plan(cards, [wire("one", "a", "b")]);
    expect(after.remove).toEqual(["two"]);
    expect(after.set).toEqual([]);
    planner.reset();
    expect(planner.plan(cards, [wire("one", "a", "b")]).set.map((f) => f.id)).toEqual(["one"]);
  });

  it("makes a cable of three wires on one handle, each with points and the cable flag", () => {
    const planner = createLoomPlanner();
    const hub = card("hub", 0, 200, 260, 96);
    // Close enough that every pair leaves by the right side and enters by the left.
    const spokes = [card("s1", 700, 150), card("s2", 700, 200), card("s3", 700, 250)];
    const update = planner.plan(
      [hub, ...spokes],
      [wire("c1", "hub", "s1"), wire("c2", "hub", "s2"), wire("c3", "hub", "s3")],
    );
    const facts = byId(update.set);
    for (const id of ["c1", "c2", "c3"]) {
      const fact = facts.get(id)!;
      expect(fact.cable).toBe(true);
      expect(fact.points!.length).toBeGreaterThanOrEqual(2);
      // A cable member ends on the handle: the hub's right edge plus the handle's 6.5 out, the spoke's left edge less 1.5.
      expect(fact.points![0]).toEqual({ x: 266.5, y: 248 });
      expect(fact.points![fact.points!.length - 1]!.x).toBe(698.5);
    }
  });

  it("lanes a pair on one handle apart so the second does not paint over the first", () => {
    const planner = createLoomPlanner();
    const update = planner.plan(
      [card("a", 0, 0), card("b", 700, -200), card("c", 700, 200)],
      [wire("up", "a", "b"), wire("down", "a", "c")],
    );
    const facts = byId(update.set);
    expect(facts.get("up")!.source.y).not.toBe(facts.get("down")!.source.y);
    // The lane is carried, so the engine can tell a stale plan from a live one.
    expect(facts.get("up")!.lane.source).toEqual({ x: 0, y: -7 });
    expect(facts.get("down")!.lane.source).toEqual({ x: 0, y: 7 });
  });

  it("does not treat a region as furniture to route around", () => {
    const planner = createLoomPlanner();
    const region = card("zone", -100, -100, 1200, 400, true);
    const update = planner.plan([region, card("a", 0, 0), card("b", 700, 0)], [wire("w", "a", "b")]);
    expect(update.set.find((f) => f.id === "w")!.points).toBeUndefined();
  });
});
