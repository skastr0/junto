import { describe, expect, it } from "vitest";
import {
  composeEdgeMapChangeNotice,
  planEdgeMapChanges,
} from "../src/shared/managed-terminal-injection";
import type { CanvasDoc } from "../src/shared/canvas";

describe("edge-map change injection", () => {
  const doc = (edges: Array<[string, string]>): CanvasDoc => ({
    nodes: [
      { id: "seat-a", type: "text", text: "a", x: 0, y: 0, width: 1, height: 1, ether: { entity: { kind: "agent" } } },
      { id: "n-peer", type: "text", text: "p", x: 0, y: 0, width: 1, height: 1, ether: { entity: { kind: "agent" } } },
      { id: "n-new", type: "text", text: "q", x: 0, y: 0, width: 1, height: 1, ether: { entity: { kind: "agent" } } },
      { id: "n-note", type: "text", text: "n", x: 0, y: 0, width: 1, height: 1, ether: { entity: { kind: "note" } } },
    ],
    edges: edges.map(([fromNode, toNode], i) => ({ id: `e${i}`, fromNode, toNode })),
  });

  it("plans added and removed slot-bearing edges per seat", () => {
    const before = doc([["seat-a", "n-peer"]]);
    const after = doc([
      ["seat-a", "n-new"],
      ["seat-a", "n-note"],
    ]);
    const changes = planEdgeMapChanges(before, after);
    const seatA = changes.find((change) => change.seatId === "seat-a");
    // A note bears no slot: no verb joins an agent to it.
    expect(seatA?.added.map((t) => t.id)).toEqual(["n-new"]);
    expect(seatA?.removed.map((t) => t.id)).toEqual(["n-peer"]);
    // Both peers are seats too, and each hears its own side of the change.
    expect(changes.map((change) => change.seatId).sort()).toEqual(["n-new", "n-peer", "seat-a"]);
  });

  it("does not plan when the edge map is unchanged", () => {
    const same = doc([["seat-a", "n-peer"]]);
    expect(planEdgeMapChanges(same, same)).toEqual([]);
  });

  it("names what the seat can now reach and no longer reach, in one line", () => {
    const text = composeEdgeMapChangeNotice({
      seatId: "seat-a",
      added: [{ id: "alpha", kind: "agent" }, { id: "bravo", kind: "agent" }],
      removed: [{ id: "charlie", kind: "agent" }],
    });
    expect(text).toBe(
      "Your connections changed. You can now reach `alpha` (agent), `bravo` (agent). " +
        "You can no longer reach `charlie` (agent). Run `junto capabilities` for details.",
    );
  });

  it("says plainly when nothing changed", () => {
    expect(composeEdgeMapChangeNotice({ seatId: "s", added: [], removed: [] })).toBe(
      "Your connections did not change. Run `junto capabilities` to see them.",
    );
  });
});
/**
 * `planEdgeMapChanges` builds its adjacency from a node index and short-circuits
 * on documents whose edge input is unchanged. Both are performance shape, so the
 * contract is pinned against a direct reimplementation of the naive walk: the
 * answers must agree on every document pair, including the ones that make an
 * index and a linear scan disagree.
 */
describe("edge-map diff equivalence", () => {
  type Doc = CanvasDoc;

  /**
   * The naive walk, restated: a linear `find` per edge endpoint and per seat
   * probe. Deliberately not shared with the implementation — a reference that
   * imports the thing it checks proves nothing.
   */
  const referencePlan = (previous: Doc, next: Doc) => {
    const slot: Readonly<Record<string, string | undefined>> = {
      agent: "msg",
      page: "browser",
    };
    const adjacency = (doc: Doc): Map<string, { id: string; kind?: string }[]> => {
      const out = new Map<string, { id: string; kind?: string }[]>();
      for (const edge of doc.edges) {
        for (const [a, b] of [
          [edge.fromNode, edge.toNode],
          [edge.toNode, edge.fromNode],
        ] as const) {
          const node = doc.nodes.find((n) => n.id === b);
          if (!node) continue;
          const kind = node.ether?.entity?.kind;
          if (kind === undefined || slot[kind] === undefined) continue;
          const list = out.get(a);
          const target = { id: b, ...(kind !== undefined ? { kind } : {}) };
          if (list) list.push(target);
          else out.set(a, [target]);
        }
      }
      return out;
    };
    const before = adjacency(previous);
    const after = adjacency(next);
    const isSeat = (doc: Doc, id: string): boolean =>
      doc.nodes.find((n) => n.id === id)?.ether?.entity?.kind === "agent";
    const key = (t: { id: string; kind?: string }): string => `${t.kind ?? ""}:${t.id}`;
    const changes: Array<{ seatId: string; added: unknown[]; removed: unknown[] }> = [];
    for (const seatId of new Set([...before.keys(), ...after.keys()])) {
      if (!isSeat(next, seatId) && !isSeat(previous, seatId)) continue;
      const prev = new Set((before.get(seatId) ?? []).map(key));
      const nextSet = new Set((after.get(seatId) ?? []).map(key));
      const added = (after.get(seatId) ?? []).filter((t) => !prev.has(key(t)));
      const removed = (before.get(seatId) ?? []).filter((t) => !nextSet.has(key(t)));
      if (added.length === 0 && removed.length === 0) continue;
      changes.push({
        seatId,
        added: [...added].sort((a, b) => a.id.localeCompare(b.id)),
        removed: [...removed].sort((a, b) => a.id.localeCompare(b.id)),
      });
    }
    return changes.sort((a, b) => a.seatId.localeCompare(b.seatId));
  };

  const node = (id: string, kind?: string, x = 0): CanvasDoc["nodes"][number] =>
    ({
      id,
      type: "text",
      text: id,
      x,
      y: 0,
      width: 1,
      height: 1,
      ...(kind === undefined ? {} : { ether: { entity: { kind } } }),
    }) as CanvasDoc["nodes"][number];

  const doc = (
    nodes: CanvasDoc["nodes"],
    edges: Array<[string, string]>,
  ): CanvasDoc =>
    ({
      nodes,
      edges: edges.map(([fromNode, toNode], i) => ({ id: `e${i}`, fromNode, toNode })),
    }) as CanvasDoc;

  const seats = [node("seat-a", "agent"), node("seat-b", "agent")];
  const sinks = [node("n-peer", "agent"), node("n-page", "page"), node("n-other", "agent")];
  /** Kind with no slot, and a node carrying no entity at all. */
  const inert = [node("n-note", "note"), node("n-bare")];

  const cases: Array<[string, CanvasDoc, CanvasDoc]> = [
    [
      "edge added to a seat",
      doc([...seats, ...sinks, ...inert], [["seat-a", "n-peer"]]),
      doc([...seats, ...sinks, ...inert], [["seat-a", "n-peer"], ["seat-a", "n-page"]]),
    ],
    [
      "edge reversed — the diff is undirected",
      doc([...seats, ...sinks], [["seat-a", "n-peer"]]),
      doc([...seats, ...sinks], [["n-peer", "seat-a"]]),
    ],
    [
      "endpoint node deleted out from under its edges",
      doc([...seats, ...sinks], [["seat-a", "n-peer"], ["seat-a", "n-page"]]),
      doc([...seats, node("n-page", "page")], [["seat-a", "n-peer"], ["seat-a", "n-page"]]),
    ],
    [
      "edge to an id no node carries",
      doc([...seats, ...sinks], [["seat-a", "n-peer"]]),
      doc([...seats, ...sinks], [["seat-a", "n-peer"], ["seat-a", "n-ghost"]]),
    ],
    [
      "duplicate node id — the first occurrence decides",
      doc(
        [node("dup", "agent"), node("dup", "page"), ...sinks],
        [["dup", "n-peer"]],
      ),
      doc(
        [node("dup", "agent"), node("dup", "page"), ...sinks],
        [["dup", "n-peer"], ["dup", "n-page"]],
      ),
    ],
    [
      "seat-to-seat edge — both endpoints are seats",
      doc([...seats, ...sinks], []),
      doc([...seats, ...sinks], [["seat-a", "seat-b"]]),
    ],
    [
      "self edge on a seat",
      doc([...seats, ...sinks], []),
      doc([...seats, ...sinks], [["seat-a", "seat-a"]]),
    ],
    [
      "inert kinds churn without moving a grant",
      doc([...seats, ...sinks, ...inert], [["seat-a", "n-note"], ["seat-a", "n-peer"]]),
      doc([...seats, ...sinks, ...inert], [["seat-a", "n-bare"], ["seat-a", "n-peer"]]),
    ],
    [
      "node changes kind while every edge stays put",
      doc([...seats, node("swing", "note")], [["seat-a", "swing"]]),
      doc([...seats, node("swing", "agent")], [["seat-a", "swing"]]),
    ],
    [
      "a node moves and nothing else",
      doc([...seats, ...sinks], [["seat-a", "n-peer"]]),
      doc([node("seat-a", "agent", 900), node("seat-b", "agent"), ...sinks], [["seat-a", "n-peer"]]),
    ],
  ];

  for (const [label, previous, next] of cases) {
    it(`agrees with the naive walk: ${label}`, () => {
      expect(planEdgeMapChanges(previous, next)).toEqual(referencePlan(previous, next));
      // The diff is antisymmetric, so run it the other way too.
      expect(planEdgeMapChanges(next, previous)).toEqual(referencePlan(next, previous));
    });
  }

  it("still reports a grant change when only a node kind moved", () => {
    const before = doc([...seats, node("swing", "note")], [["seat-a", "swing"]]);
    const after = doc([...seats, node("swing", "agent")], [["seat-a", "swing"]]);
    const changes = planEdgeMapChanges(before, after);
    expect(changes).toHaveLength(1);
    expect(changes[0].seatId).toBe("seat-a");
    expect(changes[0].added.map((t) => t.id)).toEqual(["swing"]);
  });
});
