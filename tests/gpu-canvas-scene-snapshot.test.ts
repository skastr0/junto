// The magnifier's lens is seeded from the scene's state, not a capped replay
// (#912): the snapshot folds every op into what it leaves, at any history length.

import { describe, expect, it } from "vitest";
import { asCanvasName } from "@shared/model";
import type { CardFact, SceneOp } from "../src/window/canvas/contract";
import { createSceneSnapshot } from "../src/window/canvas/shell/scene-snapshot";
import { seat } from "./support/model-nodes";

const card = (id: string, x = 0): CardFact => ({ id, row: seat(id, { x, y: 0 }), derived: { regionDepth: 0, blocked: false, z: 0 } });

describe("the scene snapshot", () => {
  it("is the board's state after any number of ops, load first, transient ops dropped", () => {
    const snapshot = createSceneSnapshot();
    expect(snapshot.ops()).toEqual([]);
    snapshot.apply([{ kind: "theme", mode: "bright" }, { kind: "load", canvas: asCanvasName("factory"), cards: [card("a"), card("b")], wires: [] }]);
    // Far more ops than the old 50,000 buffer held: the state stays one card each.
    const moves: SceneOp[] = [];
    for (let i = 0; i < 60_000; i += 1) moves.push({ kind: "card", fact: card("a", i) });
    snapshot.apply(moves);
    snapshot.apply([
      { kind: "removeCard", id: "b" },
      { kind: "card", fact: card("c") },
      { kind: "selection", fact: { nodeIds: ["a"] } },
      { kind: "pulse", wireId: "w" as never, at: 1 },
    ]);
    const ops = snapshot.ops();
    expect(ops.map((op) => op.kind)).toEqual(["theme", "load", "selection"]);
    const load = ops[1] as Extract<SceneOp, { kind: "load" }>;
    expect(load.cards.map((c) => [c.id, c.row.x])).toEqual([
      ["a", 59_999],
      ["c", 0],
    ]);
  });
});
