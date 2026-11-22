/**
 * The loom off the boot path (issue 912). The planner works in steps, from
 * the operator's view outwards, and its run loop never routes on the
 * caller's turn; the wire scene draws a wire only once its route has landed,
 * then fades it in, so no wire is first seen as an elbow and then changes
 * shape by itself.
 */
import { describe, expect, it } from "vitest";
import { createLoomPlanner, shareOf, type LoomCard, type LoomUpdate, type LoomWireRow } from "../src/window/canvas/feed/loom-planner";
import { loomWorkerCount } from "../src/window/canvas/feed/loom";
import { createLoomRun } from "../src/window/canvas/feed/loom-run";
import { packCards, packWireShares, unpackCards, unpackWires } from "../src/window/canvas/feed/loom-board";
import { createWireScene, RECORD_FLOATS } from "../src/window/canvas/engine/wires/scene";
import type { NodeId, Rect, SceneOp, WireFact, WireRouteFact } from "../src/window/canvas/contract";

const card = (id: string, x: number, y: number): LoomCard => ({ id, x, y, width: 260, height: 96, region: false });
const wire = (id: string, from: string, to: string): LoomWireRow => ({ id, from, to });

/** Three pairs of cards, each with one wire: near the origin, 20,000 out, and 60,000 out. */
const cards = [card("a", 0, 0), card("b", 600, 0), card("c", 20_000, 0), card("d", 20_600, 0), card("e", 60_000, 0), card("f", 60_600, 0)];
const wires = [wire("far", "e", "f"), wire("mid", "c", "d"), wire("near", "a", "b")];
const atOrigin: Rect = { x: -200, y: -200, width: 1400, height: 800 };
const atFar: Rect = { x: 59_800, y: -200, width: 1400, height: 800 };

/** One wire per step: a clock that has always run past the budget. */
const ONE = (): number => Number.POSITIVE_INFINITY;
const ids = (update: LoomUpdate): string[] => update.set.map((fact) => fact.id);

describe("the loom planner, in steps", () => {
  it("sends no fact for a wire it still owes, then routes from the view outwards", () => {
    const planner = createLoomPlanner();
    expect(ids(planner.begin(cards, wires, atOrigin))).toEqual([]);
    expect(planner.owed()).toBe(3);
    expect(ids(planner.step(0, ONE))).toEqual(["near"]);
    expect(ids(planner.step(0, ONE))).toEqual(["mid"]);
    expect(ids(planner.step(0, ONE))).toEqual(["far"]);
    expect(planner.owed()).toBe(0);
  });

  it("takes a moved view before the next step", () => {
    const planner = createLoomPlanner();
    planner.begin(cards, wires, atOrigin);
    planner.focus(atFar);
    expect(ids(planner.step(0, ONE))).toEqual(["far"]);
  });

  it("carries what a plan still owed into the next board", () => {
    const planner = createLoomPlanner();
    planner.begin(cards, wires, atOrigin);
    expect(ids(planner.step(0, ONE))).toEqual(["near"]);
    // A card far from every wire lands: nothing it touches is owed, but the
    // two wires the last plan had not reached still are.
    planner.begin([...cards, card("lone", -90_000, 90_000)], wires, atOrigin);
    expect(planner.owed()).toBe(2);
    const rest = [...ids(planner.step(0, ONE)), ...ids(planner.step(0, ONE))];
    expect(rest).toEqual(["mid", "far"]);
  });

  it("sends exactly what a whole plan sends, in steps", () => {
    const whole = createLoomPlanner().plan(cards, wires);
    const planner = createLoomPlanner();
    const set = [...planner.begin(cards, wires, atOrigin).set];
    while (planner.owed() > 0) set.push(...planner.step(0, ONE).set);
    const sorted = (facts: ReadonlyArray<WireRouteFact>) => [...facts].sort((x, y) => (x.id < y.id ? -1 : 1));
    expect(sorted(set)).toEqual(sorted(whole.set));
  });
});

describe("the loom in shares, one per worker", () => {
  /** A row of 24 pairs along x, each with one wire, the view at the left end. */
  const many = Array.from({ length: 24 }, (_, i) => [card(`s${i}`, i * 4000, 0), card(`t${i}`, i * 4000 + 600, 0)]).flat();
  const manyWires = Array.from({ length: 24 }, (_, i) => wire(`w${i}`, `s${i}`, `t${i}`));
  const drain = (planner: ReturnType<typeof createLoomPlanner>): string[] => {
    const routed = ids(planner.begin(many, manyWires, atOrigin));
    while (planner.owed() > 0) routed.push(...ids(planner.step(0, ONE)));
    return routed;
  };

  it("gives every wire to exactly one share, and the shares together send what one planner sends", () => {
    const whole = createLoomPlanner().plan(many, manyWires).set.map((fact) => fact.id).sort();
    const parts = [0, 1, 2].map((index) => drain(createLoomPlanner({ index, count: 3 })));
    expect(parts.flat().sort()).toEqual(whole);
    for (const [index, part] of parts.entries()) {
      expect(part.length).toBeGreaterThan(0);
      for (const id of part) expect(shareOf(id, 3)).toBe(index);
    }
  });

  it("builds the obstacle grid once per plan, not once per wire, and routes each wire once", () => {
    const planner = createLoomPlanner();
    drain(planner);
    expect(planner.stats()).toMatchObject({ begins: 1, indexes: 1, routed: 24, rerouted: 0 });
    // A card moves: the next plan builds one more grid and routes only what it can have altered.
    planner.begin(many.map((c) => (c.id === "s0" ? { ...c, y: 40 } : c)), manyWires, atOrigin);
    while (planner.owed() > 0) planner.step(0, ONE);
    const after = planner.stats();
    expect(after).toMatchObject({ begins: 2, indexes: 2 });
    expect(after.rerouted).toBe(after.routed - 24);
    expect(after.routed - 24).toBeLessThan(24);
  });

  it("routes each share from the view outwards", () => {
    for (const index of [0, 1, 2]) {
      const part = drain(createLoomPlanner({ index, count: 3 }));
      const xs = part.map((id) => Number(id.slice(1)));
      expect(xs).toEqual([...xs].sort((a, b) => a - b));
    }
  });

  it("uses every core but the page's and the compositor's, and always one", () => {
    expect(loomWorkerCount(8)).toBe(6);
    expect(loomWorkerCount(2)).toBe(1);
    expect(loomWorkerCount(1)).toBe(1);
  });
});

describe("the board, packed once for the workers", () => {
  it("unpacks every card and wire exactly as they were packed", () => {
    const region: LoomCard = { id: "r", x: -10.5, y: 3, width: 900, height: 400, region: true };
    expect(unpackCards(packCards([...cards, region]))).toEqual([...cards, region]);
    expect(unpackCards(packCards([]))).toEqual([]);
    const sided: LoomWireRow = { id: "s", from: "a", to: "c", fromSide: "bottom", toSide: "top" };
    expect(packWireShares([...wires, sided], 1).flatMap(unpackWires)).toEqual([...wires, sided]);
  });

  it("posts each worker only its own share of the wires", () => {
    const many = Array.from({ length: 40 }, (_, i) => wire(`w${i}`, "a", "b"));
    const shares = packWireShares(many, 3).map(unpackWires);
    expect(shares.flat().map((row) => row.id).sort()).toEqual(many.map((row) => row.id).sort());
    for (const [index, share] of shares.entries()) for (const row of share) expect(shareOf(row.id, 3)).toBe(index);
    expect(packWireShares([], 2).map(unpackWires)).toEqual([[], []]);
  });

  it("routes a packed board as it routes the same board unpacked", () => {
    const routed = (request: Parameters<ReturnType<typeof createLoomRun>["request"]>[0]): string[] => {
      const sent: LoomUpdate[] = [];
      const turns: Array<() => void> = [];
      const run = createLoomRun((update) => sent.push(update), ONE, (next) => turns.push(next));
      run.request(request);
      while (turns.length > 0) turns.shift()!();
      return sent.flatMap(ids);
    };
    const [wiresPacked] = packWireShares(wires, 1);
    expect(routed({ kind: "board", cards: packCards(cards), wires: wiresPacked!, view: atOrigin })).toEqual(
      routed({ kind: "plan", cards, wires, view: atOrigin }),
    );
  });
});

describe("the loom's run loop", () => {
  it("routes nothing on the caller's turn, then the nearest wire first, slice by slice", () => {
    const sent: LoomUpdate[] = [];
    const turns: Array<() => void> = [];
    const run = createLoomRun((update) => sent.push(update), ONE, (next) => turns.push(next));
    run.request({ kind: "plan", cards, wires, view: atOrigin });
    expect(sent).toEqual([]);
    expect(turns).toHaveLength(1);
    turns.shift()!();
    expect(sent.map(ids)).toEqual([["near"]]);
    while (turns.length > 0) turns.shift()!();
    expect(sent.map(ids)).toEqual([["near"], ["mid"], ["far"]]);
  });

  it("keeps a view that came before the board, when the board itself carries none", () => {
    // The page posts its first board before it has drawn a frame; the first
    // frame's view reaches the worker before the board's turn does.
    const sent: LoomUpdate[] = [];
    const turns: Array<() => void> = [];
    const run = createLoomRun((update) => sent.push(update), ONE, (next) => turns.push(next));
    run.request({ kind: "plan", cards, wires });
    run.request({ kind: "focus", view: atFar });
    turns.shift()!();
    expect(sent.map(ids)).toEqual([["far"]]);
  });

  it("routes only its own share once told it", () => {
    const sent: LoomUpdate[] = [];
    const turns: Array<() => void> = [];
    const run = createLoomRun((update) => sent.push(update), ONE, (next) => turns.push(next));
    run.request({ kind: "share", index: shareOf("mid", 2), count: 2 });
    run.request({ kind: "plan", cards, wires, view: atOrigin });
    while (turns.length > 0) turns.shift()!();
    const routed = sent.flatMap(ids);
    expect(routed).toContain("mid");
    for (const id of routed) expect(shareOf(id, 2)).toBe(shareOf("mid", 2));
  });

  it("begins the newest board when several land before its turn", () => {
    const sent: LoomUpdate[] = [];
    const turns: Array<() => void> = [];
    const run = createLoomRun((update) => sent.push(update), ONE, (next) => turns.push(next));
    run.request({ kind: "plan", cards, wires: [wire("near", "a", "b")], view: atOrigin });
    run.request({ kind: "plan", cards, wires, view: atOrigin });
    expect(turns).toHaveLength(1);
    while (turns.length > 0) turns.shift()!();
    expect(sent.flatMap(ids).sort()).toEqual(["far", "mid", "near"]);
  });
});

const T0 = 1_700_000_000_000;
const rect = (x: number, y: number): Rect => ({ x, y, width: 260, height: 96 });
const fact = (id: string): WireRouteFact => ({
  id,
  sourceSide: "right",
  targetSide: "left",
  source: { x: 260, y: 48 },
  target: { x: 600, y: 48 },
  lane: { source: { x: 0, y: 0 }, target: { x: 0, y: 0 } },
  cable: false,
});

describe("the wire scene, awaiting the loom", () => {
  const scene = () => {
    const board = new Map<string, Rect>([
      ["a", rect(0, 0)],
      ["b", rect(600, 0)],
    ]);
    const s = createWireScene({ rectOf: (id: NodeId) => board.get(id), awaitRoutes: true });
    const frame = (at: number): boolean => s.frame({ camera: { x: 0, y: 0, zoom: 1 }, width: 1600, height: 1000, pixelRatio: 2, tier: "near", wall: at });
    s.apply({ kind: "load", canvas: "t" as never, cards: [], wires: [{ id: "w", row: { id: "w", from: "a", to: "b", verb: "messages" } } as unknown as WireFact] } as SceneOp);
    return { s, frame };
  };
  const opacityNow = (s: ReturnType<typeof createWireScene>): number => s.records()[1 * RECORD_FLOATS + 4]!;

  it("draws nothing, labels nothing and picks nothing for a wire the loom has not answered", () => {
    const { s, frame } = scene();
    frame(T0);
    expect(s.inspect("w")).toMatchObject({ opacity: 0, pickable: false });
    expect(opacityNow(s)).toBe(0);
    expect(s.labelsInView()).toEqual([]);
    expect(s.waiting()).toEqual({ total: 1, inView: 1 });
  });

  it("fades the wire in from nothing when its route lands", () => {
    const { s, frame } = scene();
    frame(T0);
    s.apply({ kind: "routes", set: [fact("w")], remove: [] });
    expect(s.waiting()).toEqual({ total: 0, inView: 0 });
    expect(s.inspect("w")!.opacity).toBeGreaterThan(0);
    frame(T0 + 1);
    const early = opacityNow(s);
    expect(early).toBeLessThan(s.inspect("w")!.opacity);
    frame(T0 + 10_000);
    expect(opacityNow(s)).toBeCloseTo(s.inspect("w")!.opacity);
    expect(s.labelsInView().map((label) => label.id)).toEqual(["w"]);
  });

  it("draws a wire at once when the host has no loom", () => {
    const board = new Map<string, Rect>([
      ["a", rect(0, 0)],
      ["b", rect(600, 0)],
    ]);
    const s = createWireScene({ rectOf: (id: NodeId) => board.get(id) });
    s.apply({ kind: "load", canvas: "t" as never, cards: [], wires: [{ id: "w", row: { id: "w", from: "a", to: "b", verb: "messages" } } as unknown as WireFact] } as SceneOp);
    s.frame({ camera: { x: 0, y: 0, zoom: 1 }, width: 1600, height: 1000, pixelRatio: 2, tier: "near", wall: T0 });
    expect(s.inspect("w")!.opacity).toBeGreaterThan(0);
    expect(s.waiting()).toEqual({ total: 0, inView: 0 });
  });
});
