// @vitest-environment jsdom
/**
 * The reach preview over the GPU canvas: a drag or a region resize paints the
 * reach change of the frame it drew, and the drop clears it.
 *
 * The rules (`reachChange`, `nodeReachChanges`, `reachChangeSummary`) are
 * tested on their own; this holds the shell's wiring to them: the canvas the
 * gesture started from, the live rectangles the engine answers for the cards
 * the pointer owns, one scene op when something changed and none when it did
 * not.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Canvas } from "@shared/model";
import { asNodeId, asCanvasName } from "@shared/model";
import type { FrameFacts, Intent, ReachMark, Rect, SceneOp } from "../src/window/canvas/contract";
import { installReachPreview, type ReachPreviewEngine, type ReachPreviewHost } from "../src/window/canvas/shell/reach-live";

const id = asNodeId;

const row = (raw: string, kind: string, x: number, y: number, width: number, height: number) => ({
  id: id(raw),
  kind,
  x,
  y,
  width,
  height,
});

// A holds S (a seat) and TA; the sibling B holds TB. Two regions that are not
// on one line: S in A reaches TA and not TB. The root is on a line with
// everything, so a card that falls out of a region comes into reach of it.
const canvas = {
  name: asCanvasName("factory"),
  seq: 1,
  nodes: new Map([
    [id("A"), row("A", "region", 0, 0, 400, 400)],
    [id("B"), row("B", "region", 500, 0, 400, 400)],
    [id("S"), row("S", "agent", 20, 20, 40, 40)],
    [id("TA"), row("TA", "task", 100, 20, 40, 40)],
    [id("TB"), row("TB", "task", 520, 20, 40, 40)],
  ]),
  wires: new Map(),
} as unknown as Canvas;

type Rig = {
  readonly engine: ReachPreviewEngine;
  readonly frames: () => void;
  readonly gesture: (gesture: Intent extends never ? never : "drag" | "resize" | null, nodeIds?: ReadonlyArray<string>) => void;
  readonly setRect: (raw: string, rect: Rect | null) => void;
  readonly ops: ReadonlyArray<SceneOp>;
  readonly marks: () => ReadonlyArray<ReachMark> | null;
  readonly dispose: () => void;
};

const rig = (overrides: Partial<ReachPreviewHost> = {}): Rig => {
  const rects = new Map<string, Rect>();
  const ops: SceneOp[] = [];
  const intentListeners = new Set<(intent: Intent) => void>();
  const frameListeners = new Set<(facts: FrameFacts) => void>();
  const engine: ReachPreviewEngine = {
    apply: (incoming) => {
      ops.push(...incoming);
    },
    onIntent: (listener) => {
      intentListeners.add(listener);
      return () => intentListeners.delete(listener);
    },
    onFrame: (listener) => {
      frameListeners.add(listener);
      return () => frameListeners.delete(listener);
    },
    rectOf: (nodeId) => rects.get(nodeId),
  };
  const host: ReachPreviewHost = {
    canvas: () => canvas,
    bySeat: () => ({}),
    ...overrides,
  };
  const off = installReachPreview(engine, host);
  const marks = (): ReadonlyArray<ReachMark> | null => {
    const last = [...ops].reverse().find((op) => op.kind === "reachMarks");
    return last?.kind === "reachMarks" ? last.marks : null;
  };
  return {
    engine,
    frames: () => {
      for (const listener of [...frameListeners]) listener({} as FrameFacts);
    },
    gesture: (gesture, nodeIds = []) => {
      for (const listener of [...intentListeners]) listener({ kind: "gesture", gesture, nodeIds });
    },
    setRect: (raw, rect) => {
      if (rect === null) rects.delete(raw);
      else rects.set(raw, rect);
    },
    ops,
    marks,
    dispose: off,
  };
};

describe("the GPU canvas's reach preview", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("paints nothing before anything moves, and nothing on a still frame", () => {
    const r = rig();
    r.gesture("drag", ["S"]);
    expect(r.ops).toEqual([]);
    r.frames();
    expect(r.ops).toEqual([]);
    r.dispose();
  });

  it("a seat dragged to a sibling region shows what it gains and loses, with the words on the grabbed card", () => {
    const r = rig();
    r.gesture("drag", ["S"]);
    r.setRect("S", { x: 520, y: 120, width: 40, height: 40 });
    r.frames();
    const marks = r.marks();
    expect(marks).not.toBeNull();
    expect(marks).toEqual(
      expect.arrayContaining([
        { id: id("S"), effect: "both", summary: "1 comes into reach, 1 leaves" },
        { id: id("TA"), effect: "loses" },
        { id: id("TB"), effect: "gains" },
      ]),
    );
    r.dispose();
  });

  it("a region resize shows the resource falling out of the region and into reach", () => {
    const r = rig();
    r.gesture("resize", ["B"]);
    // B shrinks away from TB, which falls to the root, on a line with S in A.
    r.setRect("B", { x: 500, y: 0, width: 10, height: 10 });
    r.frames();
    const marks = r.marks();
    expect(marks).toEqual(
      expect.arrayContaining([
        { id: id("B"), summary: "1 comes into reach" },
        { id: id("S"), effect: "gains" },
        { id: id("TB"), effect: "gains" },
      ]),
    );
    r.dispose();
  });

  it("paints one op per change, not one per frame", () => {
    const r = rig();
    r.gesture("drag", ["S"]);
    r.setRect("S", { x: 520, y: 120, width: 40, height: 40 });
    r.frames();
    const painted = r.ops.length;
    r.frames();
    r.frames();
    expect(r.ops.length).toBe(painted);
    r.dispose();
  });

  it("a drag back onto the row clears the marks and the next step paints again", () => {
    const r = rig();
    r.gesture("drag", ["S"]);
    r.setRect("S", { x: 520, y: 120, width: 40, height: 40 });
    r.frames();
    r.setRect("S", null);
    r.frames();
    expect(r.marks()).toBeNull();
    r.setRect("S", { x: 520, y: 120, width: 40, height: 40 });
    r.frames();
    expect(r.marks()).not.toBeNull();
    r.dispose();
  });

  it("clears the marks on the drop, and only when something was painted", () => {
    const r = rig();
    r.gesture("drag", ["S"]);
    r.gesture(null);
    expect(r.ops).toEqual([]);
    // A gesture with nothing painted to clear costs nothing; this one paints.
    r.gesture("drag", ["S"]);
    r.setRect("S", { x: 520, y: 120, width: 40, height: 40 });
    r.frames();
    const painted = r.ops.length;
    r.gesture(null);
    expect(r.ops.length).toBe(painted + 1);
    expect(r.marks()).toBeNull();
    r.dispose();
  });

  it("a region dragged across another's boundary gains what it now encloses", () => {
    const r = rig();
    r.gesture("drag", ["B"]);
    // B is dragged wholly inside A, so TB sits below S's region: in reach.
    r.setRect("B", { x: 100, y: 100, width: 200, height: 200 });
    r.frames();
    const marks = r.marks();
    expect(marks).toEqual(
      expect.arrayContaining([
        { id: id("B"), summary: "1 comes into reach" },
        { id: id("S"), effect: "gains" },
        { id: id("TB"), effect: "gains" },
      ]),
    );
    r.dispose();
  });
});
