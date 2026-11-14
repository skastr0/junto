// Region chrome through the chain that runs in the window: the real pick over
// the engine's spatial index, then the pointer machine, then the cursor the
// shell puts on the canvas. A region takes the pointer on its title bar and
// its frame strips, and a selected region's eight grips are the resizer's
// (docs/canvas-gpu-inventory/interaction.md; GroupNode.tsx:296-366).
//
// The region's own rectangle is the board unit its chrome is drawn in, so the
// same points are used at every zoom.

import { describe, expect, it } from "vitest";
import type { CanvasInput, CardFact, Hit, Intent, NodeId, Part, Point, SelectionFact, SpatialIndex } from "../src/window/canvas/contract";
import { pickAt, type PickWorld } from "../src/window/canvas/engine/pick";
import { POINTER_IDLE, stepPointer, type PointerEffect, type PointerMachineEvent, type PointerWorld } from "../src/window/canvas/engine/pointer";
import { cursorFor } from "../src/window/canvas/shell/hands";
import { note, region } from "./support/model-nodes";
import type { Node } from "../src/shared/model";

type Card = { readonly node: Node };

const REGION = region("r", { x: 100, y: 100, width: 600, height: 400 });
const INSIDE = note("n", "n", { x: 150, y: 300, width: 100, height: 80 });
const OUTSIDE = note("m", "m", { x: 800, y: 100, width: 200, height: 100 });

const factOf = (node: Node): CardFact => ({
  id: node.id,
  row: node,
  derived: { regionDepth: node.kind === "region" ? 0 : 1, blocked: false, z: node.z },
});

type Board = {
  readonly cards: ReadonlyArray<Node>;
  selection: ReadonlyArray<NodeId>;
  readonly holds: boolean;
};

const board = (more: Partial<Board> = {}): Board => ({
  cards: [REGION, INSIDE, OUTSIDE],
  selection: [],
  holds: false,
  ...more,
});

const rectOf = (node: Node) => ({ x: node.x, y: node.y, width: node.width, height: node.height });

const inside = (r: { x: number; y: number; width: number; height: number }, p: Point): boolean =>
  p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;

const indexOf = (b: Board): SpatialIndex => ({
  cardsAt: (at) => b.cards.filter((node) => inside(rectOf(node), at)).map((node) => node.id),
  cardsNear: (at, slop) =>
    b.cards
      .filter((node) => {
        const rect = rectOf(node);
        return at.x >= rect.x - slop && at.x <= rect.x + rect.width + slop && at.y >= rect.y - slop && at.y <= rect.y + rect.height + slop;
      })
      .map((node) => node.id),
  wiresAt: () => [],
});

const worldOf = (b: Board): PointerWorld => {
  const byId = (id: NodeId): Node | undefined => b.cards.find((node) => node.id === id);
  const selection = (): SelectionFact => ({ nodeIds: b.selection });
  const pickWorld = (): PickWorld => ({
    index: indexOf(b),
    card: (id) => {
      const node = byId(id);
      return node === undefined ? undefined : factOf(node);
    },
    wire: () => undefined,
    selection: selection(),
    scale: 1,
    tier: "near",
    wireMode: "rest",
  });
  return {
    pick: (screen): Hit => pickAt(pickWorld(), screen),
    screenToBoard: (screen) => screen,
    viewport: () => ({ width: 1400, height: 900 }),
    rectOf: (id) => {
      const node = byId(id);
      return node === undefined ? undefined : rectOf(node);
    },
    kindOf: (id) => byId(id)?.kind,
    query: (rect) =>
      b.cards
        .filter((node) => {
          const r = rectOf(node);
          return rect.x < r.x + r.width && rect.x + rect.width > r.x && rect.y < r.y + r.height && rect.y + rect.height > r.y;
        })
        .map((node) => node.id),
    selection: () => b.selection,
    canConnect: () => false,
    verbsFor: () => [],
    riders: (regionId) => {
      if (!b.holds) return [];
      const frame = byId(regionId);
      if (frame === undefined) return [];
      const r = rectOf(frame);
      return b.cards
        .filter((node) => node.id !== regionId)
        .filter((node) => {
          const rect = rectOf(node);
          return inside(r, { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
        })
        .map((node) => node.id);
    },
  };
};

const MODIFIERS = { shift: false, alt: false, ctrl: false, meta: false };

const pointer = (phase: "down" | "move" | "up", x: number, y: number): CanvasInput => ({
  kind: "pointer",
  phase,
  pointerId: 1,
  at: { x, y },
  button: 0,
  buttons: phase === "up" ? 0 : 1,
  modifiers: MODIFIERS,
  clicks: 1,
});

const run = (b: Board, events: ReadonlyArray<PointerMachineEvent>) => {
  const world = worldOf(b);
  let state = POINTER_IDLE;
  const intents: Array<Intent> = [];
  const effects: Array<PointerEffect> = [];
  for (const event of events) {
    const step = stepPointer(state, event, world);
    state = step.state;
    intents.push(...step.intents);
    effects.push(...step.effects);
  }
  return { intents, effects, said: intents.filter((intent) => intent.kind !== "gesture") };
};

const ofKind = <K extends Intent["kind"]>(intents: ReadonlyArray<Intent>, kind: K) =>
  intents.filter((intent): intent is Extract<Intent, { kind: K }> => intent.kind === kind);

const hoverOf = (intents: ReadonlyArray<Intent>): Hit | null | undefined => {
  const hover = [...intents]
    .reverse()
    .find((intent): intent is Extract<Intent, { kind: "hover" }> => intent.kind === "hover");
  return hover?.hit;
};

const partAt = (b: Board, at: Point): Part => {
  const hit = worldOf(b).pick(at);
  if (hit === null) throw new Error("the point is the pane");
  return hit.part;
};

describe("an unselected region takes the pointer on its chrome and nowhere else", () => {
  const b = board();

  it("hovers its title bar as regionTitle, and the shell shows the grab cursor", () => {
    const hit = worldOf(b).pick({ x: 300, y: 110 });
    expect(hit).toMatchObject({ nodeId: "r", part: { kind: "regionTitle" } });
    expect(cursorFor(hit)).toBe("grab");
    const { intents } = run(b, [pointer("move", 300, 110)]);
    expect(hoverOf(intents)).toMatchObject({ nodeId: "r", part: { kind: "regionTitle" } });
  });

  it("hovers each 12-unit frame strip as regionFrame, and the shell shows the grab cursor", () => {
    for (const at of [{ x: 105, y: 300 }, { x: 695, y: 300 }, { x: 300, y: 495 }]) {
      const hit = worldOf(b).pick(at);
      expect(hit, `${at.x},${at.y}`).toMatchObject({ nodeId: "r", part: { kind: "regionFrame" } });
      expect(cursorFor(hit)).toBe("grab");
    }
  });

  it("leaves its interior to the pane", () => {
    expect(partAt(b, { x: 400, y: 300 }).kind).toBe("pane");
    expect(partAt(b, { x: 300, y: 110 }).kind).toBe("regionTitle");
  });

  it("has no resize grips before it is selected: its corner is the frame strip", () => {
    expect(partAt(b, { x: 700, y: 500 }).kind).toBe("regionFrame");
    const { said, effects } = run(b, [pointer("down", 700, 500), pointer("move", 720, 520), pointer("up", 720, 520)]);
    expect(ofKind(said, "resize")).toEqual([]);
    expect(effects.some((effect) => effect.kind === "resizing")).toBe(false);
    expect(ofKind(said, "move")).toHaveLength(1);
  });
});

describe("a selected region's eight grips resize it", () => {
  const selected = board({ selection: ["r"] });

  it("picks all four corners as resize, with the corner cursors", () => {
    const corners = [
      { at: { x: 700, y: 500 }, corner: "se", cursor: "nwse-resize" },
      { at: { x: 700, y: 100 }, corner: "ne", cursor: "nesw-resize" },
      { at: { x: 100, y: 100 }, corner: "nw", cursor: "nwse-resize" },
      { at: { x: 100, y: 500 }, corner: "sw", cursor: "nesw-resize" },
    ] as const;
    for (const { at, corner, cursor } of corners) {
      const hit = worldOf(selected).pick(at);
      expect(hit, `${corner} corner`).toMatchObject({ nodeId: "r", part: { kind: "resize", corner } });
      expect(cursorFor(hit)).toBe(cursor);
    }
  });

  it("picks all four edge lines as resizeEdge, with the one-axis cursors", () => {
    const edges = [
      { at: { x: 400, y: 100 }, edge: "n", cursor: "ns-resize" },
      { at: { x: 700, y: 300 }, edge: "e", cursor: "ew-resize" },
      { at: { x: 400, y: 500 }, edge: "s", cursor: "ns-resize" },
      { at: { x: 100, y: 300 }, edge: "w", cursor: "ew-resize" },
    ] as const;
    for (const { at, edge, cursor } of edges) {
      const hit = worldOf(selected).pick(at);
      expect(hit, `${edge} edge`).toMatchObject({ nodeId: "r", part: { kind: "resizeEdge", edge } });
      expect(cursorFor(hit)).toBe(cursor);
    }
  });

  it("the strips step aside: the left edge is a resize line, not a frame strip", () => {
    expect(partAt(selected, { x: 105, y: 300 })).toMatchObject({ kind: "resizeEdge", edge: "w" });
    expect(partAt(selected, { x: 300, y: 300 }).kind).toBe("pane");
  });

  it("a corner drag is one resize with the new rectangle, and no move", () => {
    const { said, effects, intents } = run(selected, [
      pointer("down", 700, 500),
      pointer("move", 760, 560),
      pointer("up", 760, 560),
    ]);
    expect(ofKind(said, "resize")).toEqual([
      { kind: "resize", id: "r", rect: { x: 100, y: 100, width: 660, height: 460 } },
    ]);
    expect(effects.filter((effect) => effect.kind === "resizing")).toEqual([
      { kind: "resizing", id: "r", rect: { x: 100, y: 100, width: 660, height: 460 } },
      { kind: "resizing", id: "r", rect: null },
    ]);
    expect(ofKind(said, "move")).toEqual([]);
    expect(ofKind(intents, "gesture")).toEqual([
      { kind: "gesture", gesture: "resize", nodeIds: ["r"] },
      { kind: "gesture", gesture: null, nodeIds: [] },
    ]);
  });

  it("an edge line resizes one axis only", () => {
    const { said } = run(selected, [pointer("down", 700, 300), pointer("move", 730, 340), pointer("up", 730, 340)]);
    expect(said).toEqual([{ kind: "resize", id: "r", rect: { x: 100, y: 100, width: 630, height: 400 } }]);
  });

  it("every one of the eight grips writes a resize when dragged out and back", () => {
    const grips: ReadonlyArray<{ at: Point; to: Point; rect: { x: number; y: number; width: number; height: number } }> = [
      { at: { x: 700, y: 500 }, to: { x: 720, y: 520 }, rect: { x: 100, y: 100, width: 620, height: 420 } },
      { at: { x: 700, y: 100 }, to: { x: 720, y: 80 }, rect: { x: 100, y: 80, width: 620, height: 420 } },
      { at: { x: 100, y: 100 }, to: { x: 80, y: 80 }, rect: { x: 80, y: 80, width: 620, height: 420 } },
      { at: { x: 100, y: 500 }, to: { x: 80, y: 520 }, rect: { x: 80, y: 100, width: 620, height: 420 } },
      { at: { x: 400, y: 100 }, to: { x: 400, y: 80 }, rect: { x: 100, y: 80, width: 600, height: 420 } },
      { at: { x: 700, y: 300 }, to: { x: 720, y: 300 }, rect: { x: 100, y: 100, width: 620, height: 400 } },
      { at: { x: 400, y: 500 }, to: { x: 400, y: 520 }, rect: { x: 100, y: 100, width: 600, height: 420 } },
      { at: { x: 100, y: 300 }, to: { x: 80, y: 300 }, rect: { x: 80, y: 100, width: 620, height: 400 } },
    ];
    for (const grip of grips) {
      const { said } = run(selected, [pointer("down", grip.at.x, grip.at.y), pointer("move", grip.to.x, grip.to.y), pointer("up", grip.to.x, grip.to.y)]);
      expect(ofKind(said, "resize"), `${grip.at.x},${grip.at.y}`).toEqual([{ kind: "resize", id: "r", rect: grip.rect }]);
    }
  });

  it("a grip dragged below the region minimum stops at 320 by 180", () => {
    const { said } = run(selected, [pointer("down", 700, 500), pointer("move", 100, 100), pointer("up", 100, 100)]);
    expect(said).toEqual([{ kind: "resize", id: "r", rect: { x: 100, y: 100, width: 320, height: 180 } }]);
  });
});

describe("the gesture says which card the pointer holds", () => {
  it("a card drag names the grabbed card first, then the rest of the selection", () => {
    const a = note("a", "a", { x: 0, y: 0, width: 100, height: 100 });
    const b = note("b", "b", { x: 120, y: 0, width: 100, height: 100 });
    const board = { cards: [a, b], selection: ["a", "b"], holds: false };
    const { intents, effects } = run(board, [pointer("down", 170, 50), pointer("move", 190, 70), pointer("up", 190, 70)]);
    expect(ofKind(intents, "gesture")[0]).toEqual({ kind: "gesture", gesture: "drag", nodeIds: ["b", "a"] });
    // The offset names the same cards; its order is the selection's, which the
    // paint does not read.
    expect(effects.filter((effect) => effect.kind === "offset")[0]).toMatchObject({ ids: ["a", "b"], by: { x: 20, y: 20 } });
  });

  it("a region drag names the region first, then its riders, and ends with null", () => {
    const held = board({ holds: true });
    const { intents } = run(held, [pointer("down", 300, 110), pointer("move", 320, 130), pointer("up", 320, 130)]);
    expect(ofKind(intents, "gesture")).toEqual([
      { kind: "gesture", gesture: "drag", nodeIds: ["r", "n"] },
      { kind: "gesture", gesture: null, nodeIds: [] },
    ]);
  });
});
