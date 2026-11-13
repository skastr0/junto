/**
 * Picking (docs/canvas-gpu-plan.md, track F): one function over the spatial
 * index, the parts a gesture starts from, paint order, and the wire gate the
 * architecture sets (loupe or cone only).
 */

import { describe, expect, it } from "vitest";
import type { Node } from "@shared/model";
import { isImageFile, renderedNodeSize } from "@shared/node-geometry";
import {
  pickAt,
  pickCard,
  type PickWorld,
} from "../src/window/canvas/engine/pick";
import type {
  CardFact,
  Rect,
  SelectionFact,
  SpatialIndex,
  WireFact,
  WireMode,
} from "../src/window/canvas/contract";
import { note, region, taskBoard, file, wire, seat } from "./support/model-nodes";

const factOf = (row: Node, z = 0): CardFact => ({
  id: row.id,
  row,
  derived: { regionDepth: 0, blocked: false, z },
});

const drawnRect = (row: Node): Rect => ({ x: row.x, y: row.y, ...renderedNodeSize(row.kind, row) });

const fakeIndex = (
  cards: ReadonlyArray<CardFact>,
  wires: ReadonlyArray<WireFact> = [],
  rectOf: (id: string) => Rect | undefined = (id) => {
    const card = cards.find((at) => at.id === id);
    return card === undefined ? undefined : drawnRect(card.row);
  },
): SpatialIndex => {
  const rects = cards.map((card) => ({ id: card.id, rect: rectOf(card.id) ?? drawnRect(card.row) }));
  const near = (at: { x: number; y: number }, slop: number, rect: Rect): boolean =>
    at.x >= rect.x - slop && at.x <= rect.x + rect.width + slop && at.y >= rect.y - slop && at.y <= rect.y + rect.height + slop;
  return {
    cardsAt: (at) => rects.filter(({ rect }) => at.x >= rect.x && at.x <= rect.x + rect.width && at.y >= rect.y && at.y <= rect.y + rect.height).map(({ id }) => id),
    cardsNear: (at, slop) => rects.filter(({ rect }) => near(at, slop, rect)).map(({ id }) => id),
    wiresAt: (_at, _slop) => wires.map((w) => w.id),
  };
};

const worldOf = (
  cards: ReadonlyArray<CardFact>,
  options: {
    readonly selected?: ReadonlyArray<string>;
    readonly wires?: ReadonlyArray<WireFact>;
    readonly wireMode?: WireMode;
    readonly connecting?: PickWorld["connecting"];
    readonly rectOf?: (id: string) => Rect | undefined;
  } = {},
): PickWorld => {
  const selection: SelectionFact = { nodeIds: options.selected ?? [] };
  const byId = new Map(cards.map((card) => [card.id, card]));
  const wireById = new Map((options.wires ?? []).map((w) => [w.id, w]));
  return {
    index: fakeIndex(cards, options.wires, options.rectOf),
    card: (id) => byId.get(id),
    wire: (id) => wireById.get(id),
    selection,
    scale: 1,
    tier: "near",
    wireMode: options.wireMode ?? "rest",
    ...(options.connecting === undefined ? {} : { connecting: options.connecting }),
    ...(options.rectOf === undefined ? {} : { rectOf: options.rectOf }),
  };
};

const centre = (row: Node) => {
  const rect = drawnRect(row);
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
};

describe("picking a card", () => {
  it("returns the body under a point inside the card's drawn rectangle", () => {
    const row = note("a", "a", { x: 100, y: 50 });
    const hit = pickAt(worldOf([factOf(row)]), centre(row));
    expect(hit).toMatchObject({ nodeId: "a", part: { kind: "body" } });
  });

  it("uses the drawn rectangle, not the stored one: a seat is its ring's 216 by 56", () => {
    const row = seat("s", { x: 100, y: 50, width: 900, height: 300 });
    const hit = pickAt(worldOf([factOf(row)]), { x: 100 + 200, y: 50 + 40 });
    expect(hit).toMatchObject({ nodeId: "s", part: { kind: "body" } });
    expect(pickAt(worldOf([factOf(row)]), { x: 100 + 500, y: 50 + 200 }).part.kind).toBe("pane");
  });

  it("takes the topmost card when two overlap, in paint order", () => {
    const below = factOf(note("below", "below", { x: 0, y: 0 }), 0);
    const above = factOf(note("above", "above", { x: 40, y: 20 }), 5);
    const hit = pickAt(worldOf([below, above]), { x: 100, y: 60 });
    expect(hit.nodeId).toBe("above");
  });

  it("picks the live rectangle of a card being dragged", () => {
    const row = note("a", "a", { x: 0, y: 0 });
    const world = worldOf([factOf(row)], {
      rectOf: (id) => (id === "a" ? { x: 500, y: 500, width: 200, height: 100 } : undefined),
    });
    expect(pickAt(world, { x: 550, y: 550 }).nodeId).toBe("a");
    expect(pickAt(world, { x: 50, y: 50 }).part.kind).toBe("pane");
  });

  it("falls back to the pane for empty ground", () => {
    expect(pickAt(worldOf([]), { x: 5, y: 5 }).part.kind).toBe("pane");
  });
});

describe("the parts a gesture starts from", () => {
  it("finds a source handle on each side, just outside the border", () => {
    const row = note("a", "a", { x: 100, y: 100 });
    const world = worldOf([factOf(row)]);
    const right = pickAt(world, { x: 300 + 2, y: 150 });
    expect(right).toMatchObject({ nodeId: "a", part: { kind: "handle", side: "right", role: "source" } });
    const top = pickAt(world, { x: 200, y: 100 - 2 });
    expect(top).toMatchObject({ part: { kind: "handle", side: "top", role: "source" } });
  });

  it("has no handles to press from far or overview, as the stylesheet hides them", () => {
    const row = note("a", "a", { x: 100, y: 100 });
    for (const tier of ["far", "overview"] as const) {
      const world = { ...worldOf([factOf(row)]), tier };
      expect(pickAt(world, { x: 300 + 2, y: 150 }).part.kind).toBe("pane");
    }
  });

  it("finds a target handle just inside the border", () => {
    const row = note("a", "a", { x: 100, y: 100 });
    const hit = pickAt(worldOf([factOf(row)]), { x: 300 - 3, y: 150 });
    expect(hit).toMatchObject({ nodeId: "a", part: { kind: "handle", side: "right", role: "target" } });
  });

  it("gives no handles to a region, a label, git or Files", () => {
    const row = region("r", { x: 0, y: 0, width: 400, height: 300 });
    const hit = pickAt(worldOf([factOf(row)]), { x: 400 - 3, y: 150 });
    expect(hit.part.kind).toBe("regionFrame");
  });

  it("offers landing zones only while connecting a pair that has two verbs", () => {
    const connecting = { from: "other", fromKind: "agent", verbs: ["navigates", "messages"] };
    const target = seat("s", { x: 100, y: 100 });
    const zone = pickAt(worldOf([factOf(target)], { connecting }), { x: 100 + 20, y: 150 });
    expect(zone).toMatchObject({ nodeId: "s", part: { kind: "verbZone", verb: "navigates" } });
    const right = pickAt(worldOf([factOf(target)], { connecting }), { x: 100 + 200, y: 150 });
    expect(right).toMatchObject({ part: { kind: "verbZone", verb: "messages" } });
  });

  it("shows a resize corner only on a selected resizable card", () => {
    const row = note("a", "a", { x: 100, y: 100 });
    const at = { x: 300, y: 200 };
    expect(pickAt(worldOf([factOf(row)]), at).part.kind).toBe("body");
    expect(pickAt(worldOf([factOf(row)], { selected: ["a"] }), at)).toMatchObject({
      part: { kind: "resize", corner: "se" },
    });
  });

  it("shows the four edge lines, one axis each, between the corners", () => {
    const row = note("a", "a", { x: 100, y: 100 });
    const world = worldOf([factOf(row)], { selected: ["a"] });
    expect(pickAt(world, { x: 150, y: 102 })).toMatchObject({ part: { kind: "resizeEdge", edge: "n" } });
    expect(pickAt(world, { x: 298, y: 130 })).toMatchObject({ part: { kind: "resizeEdge", edge: "e" } });
    expect(pickAt(world, { x: 150, y: 198 })).toMatchObject({ part: { kind: "resizeEdge", edge: "s" } });
    expect(pickAt(world, { x: 102, y: 130 })).toMatchObject({ part: { kind: "resizeEdge", edge: "w" } });
  });

  it("does not resize a fixed seat or an image", () => {
    const seatRow = seat("s", { x: 100, y: 100 });
    const seatHit = pickAt(worldOf([factOf(seatRow)], { selected: ["s"] }), { x: 316, y: 156 });
    expect(seatHit.part.kind).not.toBe("resize");
    const image = file("img", { x: 100, y: 100, path: "junto-content://object/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?byteLength=12&mediaType=image%2Fpng" });
    if (!isImageFile(image.path)) throw new Error("fixture is not an image");
    const imageHit = pickAt(worldOf([factOf(image)], { selected: ["img"] }), { x: 300, y: 200 });
    expect(imageHit.part.kind).toBe("image");
  });

  it("picks an image's own part inside its body", () => {
    const image = file("img", { x: 0, y: 0, path: "junto-content://object/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa?byteLength=12&mediaType=image%2Fpng" });
    const hit = pickAt(worldOf([factOf(image)]), centre(image));
    expect(hit).toMatchObject({ nodeId: "img", part: { kind: "image" } });
  });

  it("picks the tasks card's enqueue at the end of its name row", () => {
    const row = taskBoard("t", { x: 100, y: 100, width: 216, height: 56 });
    expect(pickAt(worldOf([factOf(row)]), { x: 300, y: 105 })).toMatchObject({
      nodeId: "t",
      part: { kind: "taskEnqueue" },
    });
    expect(pickCard(worldOf([factOf(row)]), centre(row))?.part.kind).toBe("body");
  });
});

describe("regions", () => {
  const row = region("r", { x: 100, y: 100, width: 600, height: 400 });

  it("takes its title bar and frame strips, never its interior", () => {
    const world = worldOf([factOf(row)]);
    expect(pickAt(world, { x: 300, y: 110 }).part.kind).toBe("regionTitle");
    expect(pickAt(world, { x: 105, y: 300 }).part.kind).toBe("regionFrame");
    expect(pickAt(world, { x: 695, y: 300 }).part.kind).toBe("regionFrame");
    expect(pickAt(world, { x: 300, y: 495 }).part.kind).toBe("regionFrame");
    expect(pickAt(world, { x: 300, y: 300 }).part.kind).toBe("pane");
  });

  it("gives a selected region its resize corners and no strips", () => {
    const world = worldOf([factOf(row)], { selected: ["r"] });
    expect(pickAt(world, { x: 700, y: 500 })).toMatchObject({ part: { kind: "resize", corner: "se" } });
    // The frame strips step aside, and the edge lines resize one axis there.
    expect(pickAt(world, { x: 105, y: 300 })).toMatchObject({ part: { kind: "resizeEdge", edge: "w" } });
    expect(pickAt(world, { x: 300, y: 300 }).part.kind).toBe("pane");
  });

  it("lets a card above a region win the point", () => {
    const card = factOf(note("n", "n", { x: 100, y: 100, width: 200, height: 100 }), 1);
    const hit = pickAt(worldOf([factOf(row), card]), { x: 150, y: 110 });
    expect(hit.nodeId).toBe("n");
  });
});

describe("wires", () => {
  const row = note("a", "a");
  const edge: WireFact = {
    id: wire("w", "a", "b", "flows").id,
    row: wire("w", "a", "b", "flows"),
  };

  it("is not picked at rest", () => {
    expect(pickAt(worldOf([factOf(row)], { wires: [edge] }), { x: 900, y: 900 }).part.kind).toBe("pane");
  });

  it("is picked in loupe and cone mode", () => {
    for (const mode of ["loupe", "cone"] as const) {
      expect(pickAt(worldOf([factOf(row)], { wires: [edge], wireMode: mode }), { x: 900, y: 900 })).toMatchObject({
        wireId: "w",
        part: { kind: "wire" },
      });
    }
  });

  it("loses to a card above it", () => {
    const world = worldOf([factOf(row)], { wires: [edge], wireMode: "loupe" });
    expect(pickAt(world, centre(row)).nodeId).toBe("a");
  });
});
