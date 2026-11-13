// The pointer machine's table (docs/canvas-gpu-architecture.md section 15,
// docs/canvas-gpu-plan.md track F): event sequences in, the intents and
// effects they must produce out, one row per gesture rule.

import { describe, expect, it } from "vitest";
import type { CanvasInput, Hit, Intent, NodeId, Part, Point, Rect } from "../src/window/canvas/contract";
import { autoPan } from "../src/window/canvas/engine/pointer/auto-pan";
import {
  POINTER_IDLE,
  stepPointer,
  type PointerEffect,
  type PointerMachineEvent,
  type PointerState,
  type PointerWorld,
} from "../src/window/canvas/engine/pointer/machine";
import { handlePoint, resizeRuleFor, resizedRect, verbZones } from "../src/window/canvas/engine/pointer/rules";

// --- a small board ---------------------------------------------------------

type Card = { readonly kind: string; readonly rect: Rect };

type Board = {
  readonly cards: Record<NodeId, Card>;
  selection: ReadonlyArray<NodeId>;
  camera: { x: number; y: number; zoom: number };
  /** Parts drawn over the cards, topmost first (resize grips, buttons, wires, clusters). */
  readonly parts: Array<{ readonly area: Rect; readonly nodeId?: NodeId; readonly wireId?: string; readonly part: Part }>;
  readonly verbs: Record<string, ReadonlyArray<string>>;
  readonly holds: Record<NodeId, boolean>;
};

const inside = (r: Rect, p: Point) => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;
const meets = (a: Rect, b: Rect) => a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y;
const NO_HANDLES = new Set(["region", "label", "git", "files"]);
const REGION_TITLE = 30;

const board = (cards: Record<NodeId, Card>, more: Partial<Omit<Board, "cards">> = {}): Board => ({
  cards,
  selection: more.selection ?? [],
  camera: more.camera ?? { x: 0, y: 0, zoom: 1 },
  parts: more.parts ?? [],
  verbs: more.verbs ?? {},
  holds: more.holds ?? {},
});

const worldOf = (b: Board): PointerWorld => {
  const screenToBoard = (s: Point): Point => ({ x: (s.x - b.camera.x) / b.camera.zoom, y: (s.y - b.camera.y) / b.camera.zoom });
  const ids = () => Object.keys(b.cards);
  return {
    screenToBoard,
    viewport: () => ({ width: 1000, height: 800 }),
    rectOf: (id) => b.cards[id]?.rect,
    kindOf: (id) => b.cards[id]?.kind,
    selection: () => b.selection,
    query: (rect) => ids().filter((id) => meets(b.cards[id]!.rect, rect)),
    canConnect: (s, t) => {
      const a = b.cards[s];
      const c = b.cards[t];
      return a !== undefined && c !== undefined && s !== t && !NO_HANDLES.has(a.kind) && !NO_HANDLES.has(c.kind);
    },
    verbsFor: (s, t) => b.verbs[`${s}>${t}`] ?? ["feeds"],
    riders: (regionId) => {
      if (!b.holds[regionId]) return [];
      const region = b.cards[regionId]!.rect;
      return ids().filter((id) => {
        if (id === regionId) return false;
        const r = b.cards[id]!.rect;
        return inside(region, { x: r.x + r.width / 2, y: r.y + r.height / 2 });
      });
    },
    pick: (screen): Hit | null => {
      const at = screenToBoard(screen);
      for (const extra of b.parts) {
        if (inside(extra.area, at)) {
          return { part: extra.part, at, ...(extra.nodeId ? { nodeId: extra.nodeId } : {}), ...(extra.wireId ? { wireId: extra.wireId } : {}) };
        }
      }
      for (const id of [...ids()].reverse()) {
        const card = b.cards[id]!;
        if (!NO_HANDLES.has(card.kind)) {
          for (const side of ["top", "right", "bottom", "left"] as const) {
            const p = handlePoint(card.rect, side, "source");
            if (Math.hypot(p.x - at.x, p.y - at.y) <= 6) return { nodeId: id, part: { kind: "handle", side, role: "source", id: `s-${side}` }, at };
          }
        }
        if (!inside(card.rect, at)) continue;
        if (card.kind === "region") {
          if (at.y <= card.rect.y + REGION_TITLE) return { nodeId: id, part: { kind: "regionTitle" }, at };
          continue; // a region's inside is the pane
        }
        return { nodeId: id, part: { kind: "body" }, at };
      }
      return { part: { kind: "pane" }, at };
    },
  };
};

// --- input -----------------------------------------------------------------

const NONE = { shift: false, alt: false, ctrl: false, meta: false };
type Opts = { button?: number; shift?: boolean; clicks?: number; id?: number };
const ptr = (phase: "down" | "move" | "up" | "cancel" | "leave", x: number, y: number, o: Opts = {}): CanvasInput => ({
  kind: "pointer",
  phase,
  pointerId: o.id ?? 1,
  at: { x, y },
  button: o.button ?? 0,
  buttons: phase === "up" ? 0 : 1 << (o.button === 1 ? 2 : o.button === 2 ? 1 : 0),
  modifiers: { ...NONE, shift: o.shift ?? false },
  clicks: o.clicks ?? (phase === "move" ? 0 : 1),
});
const down = (x: number, y: number, o?: Opts) => ptr("down", x, y, o);
const move = (x: number, y: number, o?: Opts) => ptr("move", x, y, o);
const up = (x: number, y: number, o?: Opts) => ptr("up", x, y, o);
const TICK: PointerMachineEvent = { kind: "tick" };

const run = (b: Board, events: ReadonlyArray<PointerMachineEvent | ((b: Board) => void)>, from: PointerState = POINTER_IDLE) => {
  const world = worldOf(b);
  let state = from;
  const intents: Array<Intent> = [];
  const effects: Array<PointerEffect> = [];
  for (const event of events) {
    if (typeof event === "function") {
      event(b);
      continue;
    }
    const step = stepPointer(state, event, world);
    state = step.state;
    intents.push(...step.intents);
    effects.push(...step.effects);
  }
  return { state, intents, effects, said: intents.filter((i) => i.kind !== "hover" && i.kind !== "gesture") };
};

const ofKind = <K extends Intent["kind"]>(intents: ReadonlyArray<Intent>, kind: K) =>
  intents.filter((i): i is Extract<Intent, { kind: K }> => i.kind === kind);

// Three cards in a row and a region below them.
const A: Card = { kind: "note", rect: { x: 100, y: 100, width: 200, height: 100 } };
const B: Card = { kind: "note", rect: { x: 400, y: 100, width: 200, height: 100 } };
const C: Card = { kind: "agent", rect: { x: 700, y: 100, width: 216, height: 56 } };
const R: Card = { kind: "region", rect: { x: 50, y: 300, width: 600, height: 300 } };
const three = (more?: Partial<Omit<Board, "cards">>) => board({ a: A, b: B, c: C, r: R }, more);

// --- the table -------------------------------------------------------------

describe("click", () => {
  it("selects one card, replacing the selection", () => {
    const { said } = run(three({ selection: ["b", "c"] }), [down(150, 150), up(150, 150)]);
    expect(said).toEqual([{ kind: "select", nodeIds: ["a"], mode: "replace" }]);
  });

  it("with Shift toggles the card and never drags it", () => {
    const b = three({ selection: ["b"] });
    const { said, effects } = run(b, [down(150, 150, { shift: true }), move(250, 250), up(250, 250, { shift: true })]);
    expect(said).toEqual([{ kind: "select", nodeIds: ["a"], mode: "toggle" }]);
    expect(effects).toEqual([]);
  });

  it("with Shift on region chrome toggles the region", () => {
    const { said } = run(three(), [down(300, 310, { shift: true }), up(300, 310, { shift: true })]);
    expect(said).toEqual([{ kind: "select", nodeIds: ["r"], mode: "toggle" }]);
  });

  it("on the pane deselects", () => {
    const { said } = run(three({ selection: ["a"] }), [down(50, 50), up(50, 50)]);
    expect(said).toEqual([{ kind: "clearSelection" }]);
  });

  it("inside a region's frame is the pane", () => {
    const { said } = run(three({ selection: ["a"] }), [down(300, 450), up(300, 450)]);
    expect(said).toEqual([{ kind: "clearSelection" }]);
  });

  it("does not drag under 1 px", () => {
    const { said, effects } = run(three(), [down(150, 150), move(150.7, 150.7), up(150.7, 150.7)]);
    expect(said).toEqual([{ kind: "select", nodeIds: ["a"], mode: "replace" }]);
    expect(effects).toEqual([]);
  });

  it("on a wire selects it", () => {
    const b = three({ parts: [{ area: { x: 320, y: 140, width: 60, height: 20 }, wireId: "w1", part: { kind: "wire" } }] });
    const { said } = run(b, [down(350, 150), up(350, 150)]);
    expect(said).toEqual([{ kind: "selectWire", wireId: "w1" }]);
  });

  it("on a cluster badge moves the camera there", () => {
    const b = three({ parts: [{ area: { x: 0, y: 0, width: 40, height: 40 }, part: { kind: "cluster", memberIds: ["a", "b"] } }] });
    const { said, effects } = run(b, [down(20, 20), up(20, 20)]);
    expect(said).toEqual([]);
    expect(effects).toEqual([{ kind: "cluster", memberIds: ["a", "b"], at: { x: 20, y: 20 } }]);
  });

  it("on a task card's enqueue adds a task, on a bubble's close closes it", () => {
    const b = three({
      parts: [
        { area: { x: 110, y: 110, width: 20, height: 20 }, nodeId: "a", part: { kind: "taskEnqueue" } },
        { area: { x: 410, y: 110, width: 20, height: 20 }, nodeId: "b", part: { kind: "bubbleClose" } },
      ],
    });
    expect(run(b, [down(120, 120), up(120, 120)]).said).toEqual([{ kind: "enqueueTask", nodeId: "a" }]);
    expect(run(b, [down(420, 120), up(420, 120)]).said).toEqual([{ kind: "closeBubble", nodeId: "b" }]);
  });

  it("on a control that the pointer left before lifting does nothing", () => {
    const b = three({ parts: [{ area: { x: 110, y: 110, width: 20, height: 20 }, nodeId: "a", part: { kind: "taskEnqueue" } }] });
    expect(run(b, [down(120, 120), move(180, 180), up(180, 180)]).said).toEqual([]);
  });

  it("on an image selects first and opens it when the card was selected", () => {
    const parts = [{ area: { x: 110, y: 110, width: 80, height: 80 }, nodeId: "a", part: { kind: "image" } as Part }];
    expect(run(three({ parts }), [down(150, 150), up(150, 150)]).said).toEqual([{ kind: "select", nodeIds: ["a"], mode: "replace" }]);
    expect(run(three({ parts, selection: ["a"] }), [down(150, 150), up(150, 150)]).said).toEqual([
      { kind: "open", nodeId: "a", part: { kind: "image" } },
    ]);
  });

  it("on a ring flag or a note link opens it", () => {
    const parts = [
      { area: { x: 110, y: 110, width: 20, height: 20 }, nodeId: "a", part: { kind: "ringFlag" } as Part },
      { area: { x: 410, y: 110, width: 20, height: 20 }, nodeId: "b", part: { kind: "noteLink", href: "https://x.test" } as Part },
    ];
    expect(run(three({ parts }), [down(120, 120), up(120, 120)]).said).toEqual([{ kind: "open", nodeId: "a", part: { kind: "ringFlag" } }]);
    expect(run(three({ parts }), [down(420, 120), up(420, 120)]).said).toEqual([
      { kind: "open", nodeId: "b", part: { kind: "noteLink", href: "https://x.test" } },
    ]);
  });
});

describe("double click", () => {
  it("on a card opens it", () => {
    const { said } = run(three(), [down(150, 150), up(150, 150), down(150, 150, { clicks: 2 }), up(150, 150, { clicks: 2 })]);
    expect(ofKind(said, "open")).toEqual([{ kind: "open", nodeId: "a", part: { kind: "body" } }]);
  });

  it("counts when only the down carries the count", () => {
    const { said } = run(three(), [down(150, 150), up(150, 150), down(150, 150, { clicks: 2 }), up(150, 150, { clicks: 0 })]);
    expect(ofKind(said, "open")).toHaveLength(1);
  });

  it("on the pane adds a note at the board point, and the first click deselects", () => {
    const b = three({ selection: ["a"], camera: { x: 100, y: 50, zoom: 2 } });
    const { said } = run(b, [down(40, 40), up(40, 40), down(40, 40, { clicks: 2 }), up(40, 40, { clicks: 2 })]);
    expect(said).toEqual([{ kind: "clearSelection" }, { kind: "addNote", at: { x: -30, y: -5 } }]);
  });

  it("on a region's title names it (open with the title part)", () => {
    const { said } = run(three(), [down(300, 310), up(300, 310), down(300, 310, { clicks: 2 }), up(300, 310, { clicks: 2 })]);
    expect(ofKind(said, "open")).toEqual([{ kind: "open", nodeId: "r", part: { kind: "regionTitle" } }]);
  });

  it("on a wire selects it and opens nothing", () => {
    const b = three({ parts: [{ area: { x: 320, y: 140, width: 60, height: 20 }, wireId: "w1", part: { kind: "wire" } }] });
    const { said } = run(b, [down(350, 150), up(350, 150), down(350, 150, { clicks: 2 }), up(350, 150, { clicks: 2 })]);
    expect(said).toEqual([
      { kind: "selectWire", wireId: "w1" },
      { kind: "selectWire", wireId: "w1" },
    ]);
  });
});

describe("marquee", () => {
  it("left drag on the pane takes cards partly inside, never regions, and opens the menu for two or more", () => {
    const { said, effects } = run(three({ selection: ["c"] }), [down(80, 80), move(450, 400), up(450, 400)]);
    // a fully inside, b partly inside, region r overlapped but never taken.
    expect(ofKind(said, "select").at(-1)).toEqual({ kind: "select", nodeIds: ["a", "b"], mode: "replace" });
    expect(ofKind(said, "marqueeMenu")).toEqual([
      { kind: "marqueeMenu", nodeIds: ["a", "b"], bounds: { x: 100, y: 100, width: 500, height: 100 } },
    ]);
    expect(effects).toContainEqual({ kind: "marquee", rect: { x: 80, y: 80, width: 370, height: 320 } });
    expect(effects.at(-1)).toEqual({ kind: "marquee", rect: null });
  });

  it("resets the selection as it starts and says each change once", () => {
    const { said } = run(three({ selection: ["c"] }), [down(80, 80), move(90, 90), move(95, 95), move(150, 150), move(160, 160), up(160, 160)]);
    expect(said).toEqual([{ kind: "clearSelection" }, { kind: "select", nodeIds: ["a"], mode: "replace" }]);
  });

  it("one card opens no menu, and the press is not a click", () => {
    const { said } = run(three(), [down(80, 80), move(150, 150), up(150, 150)]);
    expect(said).toEqual([{ kind: "select", nodeIds: ["a"], mode: "replace" }]);
  });

  it("starts inside a region's frame", () => {
    const { said } = run(board({ r: R, inner: { kind: "note", rect: { x: 100, y: 400, width: 100, height: 80 } } }), [down(80, 380), move(150, 450), up(150, 450)]);
    expect(said).toEqual([{ kind: "select", nodeIds: ["inner"], mode: "replace" }]);
  });
});

describe("card drag", () => {
  it("of three selected cards writes exactly one move naming three cards", () => {
    const b = three({ selection: ["a", "b", "c"] });
    const { intents, said, effects } = run(b, [down(150, 150), move(160, 170), move(190, 210), up(190, 210)]);
    const moves = ofKind(said, "move");
    expect(moves).toHaveLength(1);
    expect(moves[0]!.positions).toEqual([
      { id: "a", x: 140, y: 160 },
      { id: "b", x: 440, y: 160 },
      { id: "c", x: 740, y: 160 },
    ]);
    expect(said).toEqual(moves); // nothing else is written, not even a select
    expect(effects.filter((e) => e.kind === "offset")).toEqual([
      { kind: "offset", ids: ["a", "b", "c"], by: { x: 10, y: 20 } },
      { kind: "offset", ids: ["a", "b", "c"], by: { x: 40, y: 60 } },
      { kind: "offset", ids: ["a", "b", "c"], by: null },
    ]);
    expect(ofKind(intents, "gesture")).toEqual([
      { kind: "gesture", gesture: "drag", nodeIds: ["a", "b", "c"] },
      { kind: "gesture", gesture: null, nodeIds: [] },
    ]);
  });

  it("starts after 1 px", () => {
    const { effects } = run(three(), [down(150, 150), move(151, 150)]);
    expect(effects).toEqual([]);
    const past = run(three(), [down(150, 150), move(151, 151)]);
    expect(past.effects).toEqual([{ kind: "offset", ids: ["a"], by: { x: 1, y: 1 } }]);
  });

  it("of an unselected card selects it first and moves only it", () => {
    const { said } = run(three({ selection: ["b", "c"] }), [down(150, 150), move(200, 150), up(200, 150)]);
    expect(said).toEqual([
      { kind: "select", nodeIds: ["a"], mode: "replace" },
      { kind: "move", positions: [{ id: "a", x: 150, y: 100 }] },
    ]);
  });

  it("names only the cards whose rounded position changed, and nothing when none did", () => {
    const b = board({ a: A, f: { kind: "note", rect: { x: 400.4, y: 100, width: 200, height: 100 } } }, { selection: ["a", "f"] });
    // 0.3 rounds a to where it was; f's stored 400.4 rounds to 401, which differs.
    const nudged = run(b, [down(150, 150), move(155, 150), move(150.3, 150), up(150.3, 150)]);
    expect(ofKind(nudged.said, "move")).toEqual([{ kind: "move", positions: [{ id: "f", x: 401, y: 100 }] }]);
    const back = run(three({ selection: ["a", "b"] }), [down(150, 150), move(190, 190), move(150, 150), up(150, 150)]);
    expect(ofKind(back.said, "move")).toEqual([]);
  });

  it("leaves regions in the selection where they are", () => {
    const { said } = run(three({ selection: ["a", "r"] }), [down(150, 150), move(170, 150), up(170, 150)]);
    expect(ofKind(said, "move")).toEqual([{ kind: "move", positions: [{ id: "a", x: 120, y: 100 }] }]);
  });

  it("moves in board units at any zoom", () => {
    const { said } = run(three({ camera: { x: 0, y: 0, zoom: 0.5 } }), [down(75, 75), move(85, 75), up(85, 75)]);
    expect(ofKind(said, "move")).toEqual([{ kind: "move", positions: [{ id: "a", x: 120, y: 100 }] }]);
  });

  it("a lost pointer keeps the drag where it got to", () => {
    const { said, state } = run(three(), [down(150, 150), move(180, 150), ptr("cancel", 180, 150)]);
    expect(ofKind(said, "move")).toEqual([{ kind: "move", positions: [{ id: "a", x: 130, y: 100 }] }]);
    expect(state.gesture.kind).toBe("idle");
  });
});

describe("region drag", () => {
  const riders = () =>
    board(
      {
        r: R,
        // centre (175, 390) inside: rides
        inside: { kind: "note", rect: { x: 100, y: 350, width: 150, height: 80 } },
        // straddles the right edge, centre (640, 400) inside: rides
        straddle: { kind: "note", rect: { x: 580, y: 360, width: 120, height: 80 } },
        // centre (750, 400) outside: stays
        outside: { kind: "note", rect: { x: 690, y: 360, width: 120, height: 80 } },
      },
      { holds: { r: true } },
    );

  it("from the title bar moves the region and the cards whose centres lie inside, when it holds", () => {
    const { said } = run(riders(), [down(300, 310), move(350, 330), up(350, 330)]);
    expect(said).toEqual([
      {
        kind: "move",
        positions: [
          { id: "r", x: 100, y: 320 },
          { id: "inside", x: 150, y: 370 },
          { id: "straddle", x: 630, y: 380 },
        ],
      },
      { kind: "select", nodeIds: ["r"], mode: "replace" },
    ]);
  });

  it("from a frame strip moves the region alone when it does not hold", () => {
    const b = riders();
    b.holds.r = false;
    b.parts.push({ area: { x: 50, y: 590, width: 600, height: 10 }, nodeId: "r", part: { kind: "regionFrame" } });
    const { said } = run(b, [down(300, 595), move(300, 645), up(300, 645)]);
    expect(said).toEqual([
      { kind: "move", positions: [{ id: "r", x: 50, y: 350 }] },
      { kind: "select", nodeIds: ["r"], mode: "replace" },
    ]);
  });

  it("has no threshold, and a click on the chrome selects the region and writes nothing", () => {
    expect(run(riders(), [down(300, 310), move(300.5, 310)]).effects).toEqual([{ kind: "offset", ids: ["r", "inside", "straddle"], by: { x: 0.5, y: 0 } }]);
    expect(run(riders(), [down(300, 310), up(300, 310)]).said).toEqual([{ kind: "select", nodeIds: ["r"], mode: "replace" }]);
  });

  it("has no edge auto-pan", () => {
    const { effects } = run(riders(), [down(300, 310), move(5, 310), up(5, 310)]);
    expect(effects.filter((e) => e.kind === "autoPan")).toEqual([]);
  });
});

describe("resize", () => {
  const grip = (id: NodeId, corner: "nw" | "ne" | "se" | "sw", at: Point) => ({
    area: { x: at.x - 5, y: at.y - 5, width: 10, height: 10 },
    nodeId: id,
    part: { kind: "resize", corner } as Part,
  });

  it("writes one resize with the final rect on release", () => {
    const b = three({ selection: ["a"], parts: [grip("a", "se", { x: 300, y: 200 })] });
    const { said, effects } = run(b, [down(300, 200), move(320, 220), move(350, 260), up(350, 260)]);
    expect(said).toEqual([{ kind: "resize", id: "a", rect: { x: 100, y: 100, width: 250, height: 160 } }]);
    expect(effects).toEqual([
      { kind: "resizing", id: "a", rect: { x: 100, y: 100, width: 220, height: 120 } },
      { kind: "resizing", id: "a", rect: { x: 100, y: 100, width: 250, height: 160 } },
      { kind: "resizing", id: "a", rect: null },
    ]);
  });

  it("stops cards at 170 by 72, and a top left grip keeps the far corner still", () => {
    const b = three({ selection: ["a"], parts: [grip("a", "nw", { x: 100, y: 100 })] });
    const { said } = run(b, [down(100, 100), move(400, 400), up(400, 400)]);
    expect(said).toEqual([{ kind: "resize", id: "a", rect: { x: 130, y: 128, width: 170, height: 72 } }]);
  });

  it("an edge line resizes one axis", () => {
    const b = three({ selection: ["a"], parts: [{ area: { x: 295, y: 110, width: 10, height: 80 }, nodeId: "a", part: { kind: "resizeEdge", edge: "e" } }] });
    const { said } = run(b, [down(300, 150), move(340, 190), up(340, 190)]);
    expect(said).toEqual([{ kind: "resize", id: "a", rect: { x: 100, y: 100, width: 240, height: 100 } }]);
  });

  it("stops bare cards at 48 by 24 and regions at 320 by 180", () => {
    const label = board({ l: { kind: "label", rect: { x: 0, y: 0, width: 160, height: 40 } } }, { parts: [grip("l", "se", { x: 160, y: 40 })] });
    expect(run(label, [down(160, 40), move(0, 0), up(0, 0)]).said).toEqual([{ kind: "resize", id: "l", rect: { x: 0, y: 0, width: 48, height: 24 } }]);
    const region = three({ parts: [grip("r", "se", { x: 650, y: 600 })] });
    expect(run(region, [down(650, 600), move(0, 0), up(0, 0)]).said).toEqual([{ kind: "resize", id: "r", rect: { x: 50, y: 300, width: 320, height: 180 } }]);
  });

  it("is fixed for seat, image and page cards: the grip drags the card instead", () => {
    for (const kind of ["agent", "terminal", "file", "page"]) expect(resizeRuleFor(kind)).toEqual({ kind: "fixed" });
    const b = three({ selection: ["c"], parts: [grip("c", "se", { x: 916, y: 156 })] });
    const { said } = run(b, [down(916, 156), move(926, 166), up(926, 166)]);
    expect(said).toEqual([{ kind: "move", positions: [{ id: "c", x: 710, y: 110 }] }]);
  });

  it("writes nothing when the size did not change", () => {
    const b = three({ selection: ["a"], parts: [grip("a", "se", { x: 300, y: 200 })] });
    expect(run(b, [down(300, 200), up(300, 200)]).said).toEqual([]);
  });

  it("floors the travel as XYResizer does", () => {
    expect(resizedRect({ x: 0, y: 0, width: 200, height: 100 }, "se", { x: 10.9, y: -0.2 }, { width: 170, height: 72 })).toEqual({ x: 0, y: 0, width: 210, height: 99 });
  });
});

describe("connect", () => {
  // a's right source handle sits at (302, 150); b's left target at (403, 150).
  it("from a handle to another card's handle within 42 connects with both handles and the pair's first verb", () => {
    const b = three({ verbs: { "a>b": ["feeds", "watches", "asks"] } });
    // (365, 160): b's source left dot (398, 150) is 34.5 away, its target left dot (403, 150) 39.3; loose mode lands on either.
    const { said, intents } = run(b, [down(302, 150), move(320, 150), move(365, 160), up(365, 160)]);
    expect(said).toEqual([{ kind: "connect", source: "a", target: "b", sourceHandle: "s-right", targetHandle: "s-left", verb: "feeds" }]);
    expect(ofKind(intents, "gesture")).toEqual([
      { kind: "gesture", gesture: "connect", nodeIds: ["a"] },
      { kind: "gesture", gesture: null, nodeIds: [] },
    ]);
  });

  it("snaps within 42 board units and not beyond", () => {
    // b's nearest handles: target left (403, 150), source left (398, 150).
    expect(ofKind(run(three(), [down(302, 150), move(330, 150), move(357, 150), up(357, 150)]).said, "connect")).toHaveLength(1); // 41 from 398
    expect(run(three(), [down(302, 150), move(330, 150), move(355, 150), up(355, 150)]).said).toEqual([]); // 43 from 398
  });

  it("a drop on a card body counts", () => {
    // b's centre is 50 units from its nearest dot: past the snap radius, on the body.
    const { said } = run(three(), [down(302, 150), move(400, 300), move(500, 150), up(500, 150)]);
    expect(said).toEqual([{ kind: "connect", source: "a", target: "b", sourceHandle: "s-right", verb: "feeds" }]);
  });

  it("is refused onto a region, onto the card it began on, and from cards with no handles", () => {
    expect(run(three(), [down(302, 150), move(300, 280), move(300, 450), up(300, 450)]).said).toEqual([]); // region inside is pane
    expect(run(three(), [down(302, 150), move(300, 280), move(300, 310), up(300, 310)]).said).toEqual([]); // region title
    expect(run(three(), [down(302, 150), move(250, 150), move(200, 160), up(200, 160)]).said).toEqual([]); // its own body
    const git = board({ g: { kind: "git", rect: A.rect }, b: B }, { parts: [{ area: { x: 297, y: 145, width: 10, height: 10 }, nodeId: "g", part: { kind: "handle", side: "right", role: "source", id: "s-right" } }] });
    const fromGit = run(git, [down(302, 150), move(350, 150), move(450, 150), up(450, 150)]);
    expect(ofKind(fromGit.said, "connect")).toEqual([]);
  });

  it("onto a label, git or files card's body is left to the writer to refuse in its own words", () => {
    const b = board({ a: A, l: { kind: "label", rect: B.rect } });
    const { said } = run(b, [down(302, 150), move(400, 300), move(500, 150), up(500, 150)]);
    expect(said).toEqual([{ kind: "connect", source: "a", target: "l", sourceHandle: "s-right", verb: "feeds" }]);
  });

  it("does not snap to a label, which has no handles", () => {
    const b = board({ a: A, l: { kind: "label", rect: B.rect } });
    const { effects } = run(b, [down(302, 150), move(330, 150), move(380, 150)]);
    const preview = effects.filter((e) => e.kind === "connecting").at(-1);
    expect(preview).toMatchObject({ preview: { target: null, valid: false } });
  });

  it("lands on a verb zone when the pair offers two verbs: the left half takes the first, the right half the second", () => {
    const verbs = { "a>b": ["feeds", "watches"] };
    const left = run(three({ verbs }), [down(302, 150), move(330, 150), move(420, 190), up(420, 190)]);
    expect(left.said).toEqual([{ kind: "connect", source: "a", target: "b", sourceHandle: "s-right", targetHandle: "verb:feeds", verb: "feeds" }]);
    const right = run(three({ verbs }), [down(302, 150), move(330, 150), move(560, 130), up(560, 130)]);
    expect(right.said).toEqual([{ kind: "connect", source: "a", target: "b", sourceHandle: "s-right", targetHandle: "verb:watches", verb: "watches" }]);
  });

  it("the zones bleed 16 units past the card", () => {
    const verbs = { "a>b": ["feeds", "watches"] };
    expect(verbZones(B.rect, ["feeds", "watches"])[1]!.area).toEqual({ x: 500, y: 84, width: 116, height: 132 });
    const below = run(three({ verbs }), [down(302, 150), move(330, 150), move(590, 215), up(590, 215)]);
    expect(ofKind(below.said, "connect")[0]).toMatchObject({ verb: "watches", targetHandle: "verb:watches" });
  });

  it("from a target handle runs the wire the other way (loose mode)", () => {
    const b = three({ parts: [{ area: { x: 400, y: 145, width: 10, height: 10 }, nodeId: "b", part: { kind: "handle", side: "left", role: "target", id: "t-left" } }] });
    const { said } = run(b, [down(403, 150), move(380, 150), move(310, 150), up(310, 150)]);
    // (310, 150): a's source right dot (302, 150) is 8 away, its target right dot (297, 150) 13.
    expect(said).toEqual([{ kind: "connect", source: "a", target: "b", sourceHandle: "s-right", targetHandle: "t-left", verb: "feeds" }]);
  });

  it("is never click-to-connect", () => {
    const { said } = run(three(), [down(302, 150), up(302, 150), down(403, 150), up(403, 150)]);
    expect(ofKind(said, "connect")).toEqual([]);
  });

  it("a lost pointer connects nothing", () => {
    const { said, effects } = run(three(), [down(302, 150), move(380, 150), ptr("cancel", 400, 150)]);
    expect(said).toEqual([]);
    expect(effects.at(-1)).toEqual({ kind: "connecting", preview: null });
  });
});

describe("edge auto-pan", () => {
  it("is speed 15 within 40 px, rising from the inner line", () => {
    const view = { width: 1000, height: 800 };
    expect(autoPan({ x: 500, y: 400 }, view)).toBeNull();
    expect(autoPan({ x: 40, y: 400 }, view)).toBeNull();
    expect(autoPan({ x: 39, y: 400 }, view)).toEqual({ x: 15 / 40, y: 0 });
    expect(autoPan({ x: 0, y: 400 }, view)).toEqual({ x: 15, y: 0 });
    expect(autoPan({ x: -200, y: 400 }, view)).toEqual({ x: 15, y: 0 });
    expect(autoPan({ x: 980, y: 790 }, view)).toEqual({ x: -7.5, y: -11.25 });
  });

  it("runs during a card drag, and the drag follows the board on each tick", () => {
    const b = three();
    const { effects, said } = run(b, [
      down(150, 150),
      move(10, 150),
      (bd) => {
        bd.camera.x += 11.25; // the engine panned one frame
      },
      TICK,
      move(500, 150),
      up(500, 150),
    ]);
    expect(effects).toContainEqual({ kind: "autoPan", perFrame: { x: 11.25, y: 0 } });
    expect(effects).toContainEqual({ kind: "offset", ids: ["a"], by: { x: -151.25, y: 0 } });
    expect(effects).toContainEqual({ kind: "autoPan", perFrame: null });
    expect(ofKind(said, "move")).toEqual([{ kind: "move", positions: [{ id: "a", x: 439, y: 100 }] }]);
  });

  it("runs during a connect and a marquee", () => {
    expect(run(three(), [down(302, 150), move(995, 150)]).effects).toContainEqual({ kind: "autoPan", perFrame: { x: -13.125, y: 0 } });
    expect(run(three(), [down(50, 50), move(50, 795)]).effects).toContainEqual({ kind: "autoPan", perFrame: { x: 0, y: -13.125 } });
  });

  it("a tick with no auto-pan does nothing", () => {
    expect(run(three(), [down(150, 150), move(200, 150), TICK]).effects).toEqual([{ kind: "offset", ids: ["a"], by: { x: 50, y: 0 } }]);
  });
});

describe("right click", () => {
  const right = (x: number, y: number, o: Opts = {}) => [down(x, y, { ...o, button: 2 }), up(x, y, { ...o, button: 2 })];

  it("on the pane opens the add deck", () => {
    expect(run(three(), right(50, 50)).said).toEqual([{ kind: "menu", target: "pane", at: { x: 50, y: 50 }, screen: { x: 50, y: 50 } }]);
  });

  it("on a card with nothing selected opens its own menu (the seat menu for an agent)", () => {
    expect(run(three(), right(750, 120)).said).toEqual([{ kind: "menu", target: "card", nodeId: "c", at: { x: 750, y: 120 }, screen: { x: 750, y: 120 } }]);
  });

  it("on a selected card among several opens the multi-select menu", () => {
    expect(run(three({ selection: ["a", "b"] }), right(150, 150)).said).toEqual([
      { kind: "menu", target: "selection", at: { x: 150, y: 150 }, screen: { x: 150, y: 150 } },
    ]);
  });

  it("on an unselected card while others are selected opens the connect menu, and with Shift connects them all", () => {
    const b = three({ selection: ["a", "r", "b"] });
    expect(run(b, right(750, 120)).said).toEqual([
      { kind: "connectMenu", targetId: "c", sourceIds: ["a", "b"], at: { x: 750, y: 120 }, screen: { x: 750, y: 120 } },
    ]);
    expect(run(b, right(750, 120, { shift: true })).said).toEqual([{ kind: "connectAll", targetId: "c", sourceIds: ["a", "b"] }]);
  });

  it("with only labels selected falls through to the card's own menu", () => {
    const b = board({ l: { kind: "label", rect: A.rect }, c: C }, { selection: ["l"] });
    expect(run(b, right(750, 120)).said).toEqual([{ kind: "menu", target: "card", nodeId: "c", at: { x: 750, y: 120 }, screen: { x: 750, y: 120 } }]);
  });

  it("on region chrome opens the add deck there", () => {
    expect(run(three({ selection: ["a"] }), right(300, 310)).said).toEqual([
      { kind: "menu", target: "pane", nodeId: "r", at: { x: 300, y: 310 }, screen: { x: 300, y: 310 } },
    ]);
  });

  it("on a wire opens the wire menu", () => {
    const b = three({ parts: [{ area: { x: 320, y: 140, width: 60, height: 20 }, wireId: "w1", part: { kind: "wire" } }] });
    expect(run(b, right(350, 150)).said).toEqual([{ kind: "menu", target: "wire", wireId: "w1", at: { x: 350, y: 150 }, screen: { x: 350, y: 150 } }]);
  });

  it("never drags or selects", () => {
    const { said, effects } = run(three(), [down(150, 150, { button: 2 }), move(250, 250), up(250, 250, { button: 2 })]);
    expect(ofKind(said, "select")).toEqual([]);
    expect(effects).toEqual([]);
  });
});

describe("middle button", () => {
  it("drag pans the camera, over cards too, and writes nothing", () => {
    const { said, effects } = run(three(), [down(150, 150, { button: 1 }), move(160, 145, { button: 1 }), move(200, 145, { button: 1 }), up(200, 145, { button: 1 })]);
    expect(said).toEqual([]);
    expect(effects).toEqual([
      { kind: "pan", by: { x: 10, y: -5 } },
      { kind: "pan", by: { x: 40, y: 0 } },
    ]);
  });
});

describe("hover and pointers", () => {
  it("says hover once per change of what is under the pointer", () => {
    const { intents } = run(three(), [move(150, 150), move(160, 160), move(50, 50), ptr("leave", 50, 50)]);
    expect(intents.map((i) => (i.kind === "hover" ? i.hit?.nodeId ?? i.hit?.part.kind ?? null : i.kind))).toEqual(["a", "pane", null]);
  });

  it("ignores a second pointer while a gesture runs", () => {
    const { said } = run(three({ selection: ["a"] }), [down(150, 150), move(170, 150), down(500, 150, { id: 2 }), move(600, 150, { id: 2 }), up(600, 150, { id: 2 }), up(170, 150)]);
    expect(said).toEqual([{ kind: "move", positions: [{ id: "a", x: 120, y: 100 }] }]);
  });

  it("a hidden canvas lets a gesture go", () => {
    const { state, said } = run(three(), [down(150, 150), move(170, 150), { kind: "visibility", visible: false }]);
    expect(state.gesture.kind).toBe("idle");
    expect(ofKind(said, "move")).toHaveLength(1);
  });
});
