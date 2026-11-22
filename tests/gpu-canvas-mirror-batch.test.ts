// @vitest-environment jsdom
// The mirror copies its card map once per apply (issue 915), not once per op,
// and an apply still lands whole: a listener called inside it sees the map
// as it was before the apply began.

import { describe, expect, it } from "vitest";
import { asNodeId } from "@shared/model";
import type { CardFact } from "../src/window/canvas/contract";
import { createSurfaceMirror } from "../src/window/canvas/shell/surface-mirror";

const note = (id: string, x: number): CardFact => ({
  id: asNodeId(id),
  row: { id: asNodeId(id), kind: "note", text: id, x, y: 0, width: 220, height: 84, z: 1 },
  derived: { regionDepth: 0, blocked: false, z: 1 },
});

describe("a mirror apply", () => {
  it("lands a batch of moves, adds and removals whole, and listeners inside it see the map before it", () => {
    const mirror = createSurfaceMirror();
    const ids = Array.from({ length: 200 }, (_, i) => `n${String(i)}`);
    mirror.apply([{ kind: "load", canvas: "factory" as never, cards: ids.map((id, i) => note(id, i * 300)), wires: [] }]);
    const seen: Array<number | undefined> = [];
    mirror.onSelection(() => seen.push(mirror.card(asNodeId("n0"))?.row.x));
    mirror.apply([
      ...ids.map((id, i) => ({ kind: "card" as const, fact: note(id, i * 300 + 40) })),
      { kind: "selection" as const, fact: { nodeIds: [] } as never },
      { kind: "removeCard" as const, id: asNodeId("n1") },
      { kind: "card" as const, fact: note("fresh", 9_000) },
    ]);
    expect(seen).toEqual([0]);
    expect(mirror.card(asNodeId("n0"))?.row.x).toBe(40);
    expect(mirror.card(asNodeId("n199"))?.row.x).toBe(199 * 300 + 40);
    expect(mirror.card(asNodeId("n1"))).toBeUndefined();
    expect(mirror.card(asNodeId("fresh"))?.row.x).toBe(9_000);
    expect(mirror.cardIds()).toHaveLength(200);
  });
});
