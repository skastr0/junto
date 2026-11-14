// @vitest-environment jsdom
/**
 * The shell's mirror answers with the rectangle the engine drew, not the row
 * it left (docs/canvas-gpu-architecture.md sections 16 and 19).
 *
 * A drag and a resize move the drawn card without writing its row, so a mirror
 * that reads `card.row.x` points the selection toolbar, the editors and every
 * anchored element at where the card used to be. The engine reports those live
 * screen rectangles in `FrameFacts.anchors`; these tests hold the mirror to
 * them, and hold it to the row again the moment the pointer lets go.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { asNodeId } from "@shared/model";
import type { CanvasTier, CardFact, FrameFacts, Rect } from "../src/window/canvas/contract";
import { createSurfaceMirror, type LiveSource } from "../src/window/canvas/shell/surface-mirror";
import { farSeatScale, seatFloorScale } from "@shared/canvas-tier";
import { heldRingRect } from "@shared/node-geometry";

const CARD: CardFact = {
  id: asNodeId("n"),
  row: { id: asNodeId("n"), kind: "note", text: "note", x: 10, y: 20, width: 220, height: 84, z: 1 },
  derived: { regionDepth: 0, blocked: false, z: 1 },
};

const rect = (x: number, y: number, width: number, height: number): Rect => ({ x, y, width, height });

type Rig = {
  readonly mirror: ReturnType<typeof createSurfaceMirror>;
  readonly setLive: (id: string, next: Rect | null) => void;
  readonly emit: (anchorRects: ReadonlyArray<{ id: string; rect: Rect }>, camera?: { x: number; y: number; zoom: number }) => void;
  readonly rects: () => number;
  readonly boardRectOf: (id: string) => Rect | undefined;
  readonly dispose: () => void;
};

const rig = (camera = { x: 0, y: 0, zoom: 1 }): Rig => {
  const live = new Map<string, Rect>();
  const listeners = new Set<(facts: FrameFacts) => void>();
  let rectCalls = 0;
  const source: LiveSource = {
    rectOf: (id) => live.get(id),
    onFrame: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  const mirror = createSurfaceMirror();
  mirror.attachLive(source);
  mirror.apply([
    { kind: "load", canvas: "factory" as never, cards: [CARD], wires: [] },
  ]);
  mirror.setCamera(camera);
  mirror.onRects(() => {
    rectCalls += 1;
  });
  return {
    mirror,
    setLive: (id, next) => {
      if (next === null) live.delete(id);
      else live.set(id, next);
    },
    emit: (anchors, nextCamera) => {
      const facts: FrameFacts = {
        at: 0,
        camera: nextCamera ?? mirror.camera(),
        tier: mirror.tier() as CanvasTier,
        scales: { farSeat: 1, seatFloor: 1, node: 1 },
        settled: true,
        anchors,
        marquee: null,
      };
      for (const listener of [...listeners]) listener(facts);
    },
    rects: () => rectCalls,
    boardRectOf: (id) => mirror.boardRectOf(id),
    dispose: () => {
      mirror.attachLive(source)();
    },
  };
};

describe("the mirror's live rectangles", () => {
  beforeEach(() => {
    // jsdom's default element origin keeps the page rectangle the frame's one.
    document.body.innerHTML = "";
  });

  it("answers the row while nothing is moving", () => {
    const r = rig();
    expect(r.mirror.screenRectOf("n")).toEqual(rect(10, 20, 220, 84));
    expect(r.mirror.boardRectOf("n")).toEqual(rect(10, 20, 220, 84));
    r.dispose();
  });

  it("follows a card the pointer is dragging, and tells the overlays", () => {
    const r = rig();
    r.setLive("n", rect(110, 70, 220, 84));
    const calls = r.rects();
    r.emit([{ id: "n", rect: rect(110, 70, 220, 84) }]);
    expect(r.mirror.screenRectOf("n")).toEqual(rect(110, 70, 220, 84));
    expect(r.mirror.boardRectOf("n")).toEqual(rect(110, 70, 220, 84));
    expect(r.rects()).toBe(calls + 1);
    r.dispose();
  });

  it("follows a live resize", () => {
    const r = rig();
    r.setLive("n", rect(10, 20, 300, 160));
    r.emit([{ id: "n", rect: rect(10, 20, 300, 160) }]);
    expect(r.mirror.screenRectOf("n")).toEqual(rect(10, 20, 300, 160));
    r.dispose();
  });

  it("writes an anchored element from the live rectangle, in the frame", () => {
    const r = rig();
    const element = document.createElement("div");
    r.mirror.anchor("n", element);
    expect(element.style.transform).toBe("translate3d(10px, 20px, 0)");
    r.setLive("n", rect(150, 90, 220, 84));
    r.emit([{ id: "n", rect: rect(150, 90, 220, 84) }]);
    expect(element.style.transform).toBe("translate3d(150px, 90px, 0)");
    expect(element.style.getPropertyValue("--anchor-width")).toBe("220px");
    r.dispose();
  });

  it("drops the live rectangle on release, so the row answers again", () => {
    const r = rig();
    r.setLive("n", rect(110, 70, 220, 84));
    r.emit([{ id: "n", rect: rect(110, 70, 220, 84) }]);
    expect(r.mirror.screenRectOf("n")).toEqual(rect(110, 70, 220, 84));
    r.setLive("n", null);
    const calls = r.rects();
    r.emit([]);
    expect(r.mirror.screenRectOf("n")).toEqual(rect(10, 20, 220, 84));
    expect(r.rects()).toBe(calls + 1);
    r.dispose();
  });

  it("never answers a camera move from a frame-old rectangle", () => {
    const r = rig();
    const element = document.createElement("div");
    r.mirror.anchor("n", element);
    // An anchored card on its row: the frame reports it, and that report must
    // not become a cache that a later camera move reads. The engine computes
    // the anchor at the frame's own camera, so here it is the row at x = 110.
    r.emit([{ id: "n", rect: rect(110, 20, 220, 84) }], { x: 100, y: 0, zoom: 1 });
    expect(r.mirror.screenRectOf("n")).toEqual(rect(110, 20, 220, 84));
    expect(element.style.transform).toBe("translate3d(110px, 20px, 0)");
    r.dispose();
  });

  it("scales the live rectangle with the camera, as the engine frame reports it", () => {
    const r = rig({ x: 30, y: 40, zoom: 2 });
    r.setLive("n", rect(120, 100, 440, 168));
    r.emit([{ id: "n", rect: rect(120, 100, 440, 168) }], { x: 30, y: 40, zoom: 2 });
    expect(r.mirror.screenRectOf("n")).toEqual(rect(120, 100, 440, 168));
    expect(r.mirror.boardRectOf("n")).toEqual(rect(120, 100, 440, 168));
    r.dispose();
  });
});

describe("a ringed card's answered rectangle at the far tiers", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  const seatRow = (over: Record<string, unknown> = {}): CardFact["row"] => ({
    id: asNodeId("s"), kind: "agent", label: "Ada", x: 100, y: 200, width: 216, height: 56, z: 1,
    agentKey: "local:pi", harness: "pi", overseer: false, host: "local", ...over,
  }) as unknown as CardFact["row"];

  // Room to grow: a lone card takes the full ring at the far tiers.
  const card = (row: CardFact["row"], ringCap = 5.2): CardFact => ({
    id: row.id,
    row,
    derived: { regionDepth: 0, blocked: false, z: 1, ringCap },
  });

  const pageRect = (zoom: number, ring: { x: number; y: number; width: number; height: number }): Rect => ({
    x: ring.x * zoom,
    y: ring.y * zoom,
    width: ring.width * zoom,
    height: ring.height * zoom,
  });

  const ringScale = (zoom: number): number => Math.max(seatFloorScale(zoom), Math.min(farSeatScale(zoom), 5.2));

  it("answers the held ring alone, so an overlay centres on the ring", () => {
    const mirror = createSurfaceMirror();
    mirror.apply([{ kind: "load", canvas: "factory" as never, cards: [card(seatRow())], wires: [] }]);
    mirror.setCamera({ x: 0, y: 0, zoom: 0.15 });
    const answered = mirror.screenRectOf("s")!;
    const expected = pageRect(0.15, heldRingRect(seatRow(), ringScale(0.15))!);
    expect(answered.x).toBeCloseTo(expected.x, 4);
    expect(answered.y).toBeCloseTo(expected.y, 4);
    expect(answered.width).toBeCloseTo(expected.width, 4);
    expect(answered.height).toBeCloseTo(expected.height, 4);
    // The ring, never a union with the card box the far tier does not paint: a
    // union reaches from the box's left edge to the ring's right, 48.5 wide at
    // this zoom, and centres the toolbar a quarter card right of the ring.
    expect(answered.width).toBeLessThan(45);
    // It stands about 16 screen px above the card's own top edge, which is
    // where the selection toolbar used to land across the ring.
    expect(answered.y).toBeLessThan(200 * 0.15 - 15);
  });

  it("covers a kind seat's ring too: the far tier holds one for every seat kind", () => {
    const terminal = seatRow({ kind: "terminal", bindingId: "b", label: "Shell" });
    const mirror = createSurfaceMirror();
    mirror.apply([{ kind: "load", canvas: "factory" as never, cards: [card(terminal)], wires: [] }]);
    mirror.setCamera({ x: 0, y: 0, zoom: 0.15 });
    expect(mirror.screenRectOf("s")).toEqual(pageRect(0.15, heldRingRect(terminal, ringScale(0.15))!));
  });

  it("leaves an unringed card on its own rectangle at the far tiers", () => {
    const note = { id: asNodeId("n"), kind: "note" as const, text: "note", x: 10, y: 20, width: 220, height: 84, z: 1 };
    const mirror = createSurfaceMirror();
    mirror.apply([{ kind: "load", canvas: "factory" as never, cards: [{ id: "n", row: note, derived: { regionDepth: 0, blocked: false, z: 1 } }], wires: [] }]);
    mirror.setCamera({ x: 0, y: 0, zoom: 0.15 });
    expect(mirror.screenRectOf("n")).toEqual(rect(1.5, 3, 33, 12.6));
  });

  it("leaves the card's own rectangle alone at near", () => {
    const mirror = createSurfaceMirror();
    mirror.apply([{ kind: "load", canvas: "factory" as never, cards: [card(seatRow())], wires: [] }]);
    mirror.setCamera({ x: 0, y: 0, zoom: 1 });
    expect(mirror.screenRectOf("s")).toEqual(rect(100, 200, 216, 56));
  });

  it("keeps a live drag rectangle as the engine drew it, ring or no ring", () => {
    const mirror = createSurfaceMirror();
    const listeners = new Set<(facts: FrameFacts) => void>();
    mirror.attachLive({ rectOf: (id) => (id === "s" ? rect(150, 240, 216, 56) : undefined), onFrame: (l) => { listeners.add(l); return () => listeners.delete(l); } });
    mirror.apply([{ kind: "load", canvas: "factory" as never, cards: [card(seatRow())], wires: [] }]);
    mirror.setCamera({ x: 0, y: 0, zoom: 0.15 });
    for (const listener of listeners) {
      listener({ at: 0, camera: mirror.camera(), tier: mirror.tier() as CanvasTier, scales: { farSeat: 1, seatFloor: 1, node: 1 }, settled: true, anchors: [{ id: "s", rect: rect(150, 240, 216, 56) }], marquee: null });
    }
    expect(mirror.screenRectOf("s")).toEqual(rect(150, 240, 216, 56));
  });
});
