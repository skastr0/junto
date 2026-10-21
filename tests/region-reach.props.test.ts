import { describe, expect, it } from "vitest";
import { frameContains } from "../src/shared/model/canvas";
import { asNodeId } from "../src/shared/model";
import type { NodeKind } from "../src/shared/model/kinds";
import {
  atOrBelow,
  automationTargets,
  onOneLine,
  isResourceKind,
  isSeatKind,
  positionsOf,
  reaches,
  resourcesInReach,
  seatsInReach,
  type ReachCanvas,
  type ReachNode,
} from "../src/shared/region-reach";

// Properties of region reach over random canvases, beside the worked examples
// in region-reach.test.ts. Seeded, so a failure names the seed that replays it.

const KINDS: ReadonlyArray<NodeKind> = ["agent", "peer", "task", "artifacts", "note", "page", "region", "region"];

const rng = (seed: number) => {
  let state = seed >>> 0;
  return (below: number): number => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % below;
  };
};

const randomCanvas = (seed: number): ReadonlyArray<ReachNode> => {
  const next = rng(seed);
  const count = 6 + next(18);
  return Array.from({ length: count }, (_, i) => {
    const kind = KINDS[next(KINDS.length)]!;
    const big = kind === "region";
    return {
      id: asNodeId(`n${String(i).padStart(2, "0")}`),
      kind,
      x: next(600) - 100,
      y: next(600) - 100,
      width: big ? 100 + next(500) : 20 + next(60),
      height: big ? 100 + next(500) : 20 + next(60),
    };
  });
};

const canvasOf = (nodes: ReadonlyArray<ReachNode>): ReachCanvas => ({ nodes: new Map(nodes.map((n) => [n.id, n])) });

const SEEDS = Array.from({ length: 200 }, (_, i) => i + 1);

/** Runs a check on every seed; it returns the violations it found, none expected. */
const forall = (check: (nodes: ReadonlyArray<ReachNode>, canvas: ReachCanvas) => ReadonlyArray<string>) => () => {
  const violations: string[] = [];
  for (const seed of SEEDS) {
    const nodes = randomCanvas(seed);
    for (const v of check(nodes, canvasOf(nodes))) if (violations.length < 10) violations.push(`seed ${seed}: ${v}`);
  }
  expect(violations).toEqual([]);
};

const ids = (nodes: ReadonlyArray<ReachNode>) => nodes.map((n) => n.id as string);
const sorted = (list: ReadonlyArray<string>) => [...list].sort();
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

describe("region reach properties", () => {
  it("is symmetric, and a node reaches itself", forall((nodes, canvas) => {
    const out: string[] = [];
    for (const a of nodes) {
      if (!reaches(canvas, a.id, a.id)) out.push(`${a.id} does not reach itself`);
      for (const b of nodes) {
        if (reaches(canvas, a.id, b.id) !== reaches(canvas, b.id, a.id)) out.push(`${a.id} ~ ${b.id} is not symmetric`);
      }
    }
    return out;
  }));

  it("makes onOneLine symmetric, and atOrBelow transitive over nodes with at most one position", forall((nodes, canvas) => {
    const out: string[] = [];
    const at = nodes.map((n) => [n.id, positionsOf(canvas, n.id)!] as const);
    for (const [ia, a] of at) for (const [ib, b] of at) {
      if (onOneLine(canvas, a, b) !== onOneLine(canvas, b, a)) out.push(`onOneLine ${ia}, ${ib}`);
      if (!atOrBelow(canvas, a, b) || (b._tag === "Regions" && b.innermost.length > 1)) continue;
      for (const [ic, c] of at) {
        if (atOrBelow(canvas, b, c) && !atOrBelow(canvas, a, c)) out.push(`atOrBelow ${ia} > ${ib} > ${ic}`);
      }
    }
    return out;
  }));

  it("agrees between resourcesInReach, seatsInReach and reaches", forall((nodes, canvas) => {
    const out: string[] = [];
    for (const seat of nodes.filter((n) => isSeatKind(n.kind))) {
      const resources = new Set(ids(resourcesInReach(canvas, seat.id)));
      for (const resource of nodes.filter((n) => isResourceKind(n.kind))) {
        const expected = reaches(canvas, seat.id, resource.id);
        if (resources.has(resource.id) !== expected) out.push(`${seat.id} -> ${resource.id} resourcesInReach`);
        if (ids(seatsInReach(canvas, resource.id)).includes(seat.id) !== expected) out.push(`${resource.id} <- ${seat.id} seatsInReach`);
      }
    }
    return out;
  }));

  it("lists only the right kinds, never the anchor, sorted by id", forall((nodes, canvas) => {
    const out: string[] = [];
    for (const anchor of nodes) {
      const resources = resourcesInReach(canvas, anchor.id);
      const seats = seatsInReach(canvas, anchor.id);
      if (!resources.every((n) => isResourceKind(n.kind) && n.id !== anchor.id)) out.push(`${anchor.id} resources hold a wrong node`);
      if (!seats.every((n) => isSeatKind(n.kind) && n.id !== anchor.id)) out.push(`${anchor.id} seats hold a wrong node`);
      if (!same(ids(resources), sorted(ids(resources))) || !same(ids(seats), sorted(ids(seats)))) out.push(`${anchor.id} unsorted`);
    }
    return out;
  }));

  it("puts a node outside every region at the root, and the root reaches everything", forall((nodes, canvas) => {
    const out: string[] = [];
    const regions = nodes.filter((n) => n.kind === "region");
    for (const a of nodes) {
      const inside = regions.some((r) => r.id !== a.id && frameContains(r, a));
      const at = positionsOf(canvas, a.id)!;
      if ((at._tag === "Root") === inside) out.push(`${a.id} root is ${at._tag === "Root"} but inside is ${inside}`);
      if (at._tag === "Root") for (const b of nodes) if (!reaches(canvas, a.id, b.id)) out.push(`root ${a.id} misses ${b.id}`);
    }
    return out;
  }));

  it("holds only innermost positions: none lies strictly inside another", forall((nodes, canvas) => {
    const out: string[] = [];
    const byId = new Map(nodes.map((n) => [n.id as string, n]));
    for (const a of nodes) {
      const at = positionsOf(canvas, a.id)!;
      if (at._tag === "Root") continue;
      for (const p of at.innermost) for (const q of at.innermost) {
        if (p !== q && frameContains(byId.get(p)!, byId.get(q)!) && !frameContains(byId.get(q)!, byId.get(p)!)) {
          out.push(`${a.id} holds ${p} above ${q}`);
        }
      }
      if (!same([...at.innermost], sorted(at.innermost))) out.push(`${a.id} positions unsorted`);
    }
    return out;
  }));

  it("does not depend on node insertion order", forall((nodes, canvas) => {
    const out: string[] = [];
    const reversed = canvasOf([...nodes].reverse());
    for (const a of nodes) {
      if (!same(positionsOf(reversed, a.id), positionsOf(canvas, a.id))) out.push(`${a.id} positions`);
      if (!same(ids(resourcesInReach(reversed, a.id)), ids(resourcesInReach(canvas, a.id)))) out.push(`${a.id} resources`);
    }
    return out;
  }));

  it("keeps positions unchanged when an unrelated node moves", forall((nodes, canvas) => {
    const out: string[] = [];
    // Moving a non-region node changes no region's frame, so every other node's positions stay.
    const mover = nodes.find((n) => n.kind !== "region");
    if (mover === undefined) return out;
    const moved = canvasOf(nodes.map((n) => (n.id === mover.id ? { ...n, x: n.x + 37, y: n.y - 53 } : n)));
    for (const a of nodes) {
      if (a.id !== mover.id && !same(positionsOf(moved, a.id), positionsOf(canvas, a.id))) out.push(`${a.id} changed when ${mover.id} moved`);
    }
    return out;
  }));

  it("keeps a seat author's targets inside the operator's targets and the author's reach", forall((nodes, canvas) => {
    const out: string[] = [];
    for (const automation of nodes.filter((n) => n.kind === "note")) {
      const operator = new Set(ids(automationTargets(canvas, automation.id, { kind: "operator" })));
      const at = positionsOf(canvas, automation.id)!;
      for (const seat of nodes.filter((n) => isSeatKind(n.kind))) {
        for (const target of automationTargets(canvas, automation.id, { kind: "seat", seat: seat.id })) {
          if (!operator.has(target.id)) out.push(`${automation.id} by ${seat.id} hits ${target.id} beyond the operator's targets`);
          if (!reaches(canvas, seat.id, target.id)) out.push(`${seat.id} does not reach its target ${target.id}`);
          if (!atOrBelow(canvas, at, positionsOf(canvas, target.id)!)) out.push(`${target.id} is above ${automation.id}`);
        }
      }
    }
    return out;
  }));
});

describe("atOrBelow across a node with two positions", () => {
  // Pinned behaviour, not a promise: "some position at or below some position"
  // chains through a node in two overlapping regions without relating its ends.
  it("is not transitive through a node in two partly overlapping regions", () => {
    const at = (id: string, kind: NodeKind, x: number, y: number, w: number, h: number): ReachNode => ({ id: asNodeId(id), kind, x, y, width: w, height: h });
    const canvas = canvasOf([
      at("X", "region", 0, 0, 300, 300),
      at("Y", "region", 200, 0, 300, 300),
      at("Z", "region", 350, 10, 100, 100),
      at("a", "agent", 10, 10, 20, 20),
      at("b", "agent", 210, 10, 20, 20),
      at("c", "agent", 360, 20, 20, 20),
    ]);
    const pos = (id: string) => positionsOf(canvas, asNodeId(id))!;
    expect(atOrBelow(canvas, pos("a"), pos("b"))).toBe(true);
    expect(atOrBelow(canvas, pos("b"), pos("c"))).toBe(true);
    expect(atOrBelow(canvas, pos("a"), pos("c"))).toBe(false);
  });
});
