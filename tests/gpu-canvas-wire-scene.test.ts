/**
 * The engine's wire scene (track D), on the CPU: strips in a pool, one record
 * per wire, routes from the loom's facts or the fallback elbow, modes,
 * selection, glow, pulses, tracks and picking, all at a frozen clock.
 */
import { describe, expect, it } from "vitest";
import { createWireScene, RECORD_FLOATS, PREVIEW_ID, type WireFrame } from "../src/window/canvas/engine/wires/scene";
import type { NodeId, Rect, SceneOp, WireFact, WireRouteFact } from "../src/window/canvas/contract";
import { STRIP_FLOATS } from "../src/window/canvas/paint/wires";
import { WIRE_PULSE_MS } from "../src/window/lib/wire-pulse";

const T0 = 1_700_000_000_000;

const wire = (id: string, from: string, to: string, verb: "messages" | "flows" | "derives" | "navigates" = "messages"): WireFact =>
  ({ id, row: { id, from, to, verb } }) as unknown as WireFact;

const makeScene = (cards: Map<string, Rect>, reducedMotion = false) => {
  const scene = createWireScene({ rectOf: (id: NodeId) => cards.get(id), reducedMotion: () => reducedMotion });
  const frame = (at: number, tier: WireFrame["tier"] = "near"): boolean =>
    scene.frame({ camera: { x: 0, y: 0, zoom: 1 }, width: 1600, height: 1000, pixelRatio: 2, tier, wall: at });
  return { scene, frame };
};

const rect = (x: number, y: number, width = 260, height = 96): Rect => ({ x, y, width, height });

const record = (scene: ReturnType<typeof createWireScene>, slot: number): Float32Array =>
  scene.records().subarray(slot * RECORD_FLOATS, (slot + 1) * RECORD_FLOATS);

const board = () =>
  new Map<string, Rect>([
    ["a", rect(0, 0)],
    ["b", rect(600, 0)],
    ["c", rect(0, 400)],
  ]);

const load = (wires: WireFact[]): SceneOp => ({ kind: "load", canvas: "t" as never, cards: [], wires });

describe("the wire scene", () => {
  it("draws a wire at rest as one strip and a record at 7% opacity", () => {
    const { scene, frame } = makeScene(board());
    scene.apply(load([wire("w", "a", "b")]));
    frame(T0);
    expect(scene.inspect("w")).toMatchObject({ kind: "elbow", opacity: 0.07, pickable: false });
    expect(scene.pool.extent()).toBeGreaterThan(0);
    const r = record(scene, 1);
    expect(r[4]).toBeCloseTo(0.07);
    expect(r[5]).toBeGreaterThan(300);
    // Every vertex of the strip names the wire's record.
    const v = scene.pool.vertices();
    expect(v[6]).toBe(1);
  });

  it("draws the loom's points while the ends sit where the plan put them, and the elbow once a card moves", () => {
    const cards = board();
    const { scene, frame } = makeScene(cards);
    scene.apply(load([wire("w", "a", "b")]));
    const fact: WireRouteFact = {
      id: "w",
      sourceSide: "right",
      targetSide: "left",
      source: { x: 260, y: 48 },
      target: { x: 600, y: 48 },
      lane: { source: { x: 0, y: 0 }, target: { x: 0, y: 0 } },
      points: [
        { x: 260, y: 48 },
        { x: 430, y: 48 },
        { x: 430, y: 200 },
        { x: 600, y: 200 },
        { x: 600, y: 48 },
      ],
      cable: false,
    };
    scene.apply({ kind: "routes", set: [fact], remove: [] });
    frame(T0);
    expect(scene.inspect("w")!.kind).toBe("route");
    // A drag moves card b: the plan is stale, so the wire is the elbow on live ends.
    cards.set("b", rect(640, 30));
    frame(T0 + 16);
    expect(scene.inspect("w")!.kind).toBe("elbow");
    // The model takes the move and the loom answers: the route returns.
    cards.set("b", rect(600, 0));
    frame(T0 + 32);
    expect(scene.inspect("w")!.kind).toBe("route");
  });

  it("gives each wire the camera can see one label at its midpoint, and tells the shell when that moves", () => {
    const cards = new Map<string, Rect>([
      ["a", rect(0, 0)],
      ["b", rect(600, 0)],
      ["far", rect(4000, 0)],
    ]);
    const { scene, frame } = makeScene(cards);
    scene.apply(load([wire("w", "a", "b"), wire("f", "a", "far")]));
    frame(T0);
    const labels = scene.labelsInView();
    expect(labels.map((label) => label.id)).toEqual(["w"]);
    expect(labels[0]!.at).toEqual(scene.labelOf("w"));
    expect(labels[0]!.verb).toBe("messages");
    // The label sits on the run, between the two cards.
    expect(labels[0]!.at.x).toBeGreaterThan(260);
    expect(labels[0]!.at.x).toBeLessThan(600);

    const revision = scene.labelsRevision();
    cards.set("b", rect(600, 300));
    frame(T0 + 16);
    expect(scene.labelsRevision()).toBeGreaterThan(revision);
    expect(scene.labelsInView()[0]!.at).toEqual(scene.labelOf("w"));
  });

  it("marks a cable member by its narrow hit width", () => {
    const { scene, frame } = makeScene(board());
    scene.apply(load([wire("w", "a", "b")]));
    scene.apply({
      kind: "routes",
      remove: [],
      set: [
        {
          id: "w",
          sourceSide: "right",
          targetSide: "left",
          source: { x: 260, y: 48 },
          target: { x: 600, y: 48 },
          lane: { source: { x: 0, y: 0 }, target: { x: 0, y: 0 } },
          points: [
            { x: 266.5, y: 48 },
            { x: 598.5, y: 48 },
          ],
          cable: true,
        },
      ],
    });
    scene.apply({ kind: "wireMode", mode: "loupe" });
    frame(T0 + 1000);
    expect(scene.inspect("w")!.kind).toBe("strand");
    expect(scene.pick({ x: 400, y: 48 + 1 })).toBe("w");
    expect(scene.pick({ x: 400, y: 48 + 2 })).toBeUndefined();
  });

  it("eases to 90% in the loupe, to full in a cone, and back, on the frozen clock", () => {
    const { scene, frame } = makeScene(board());
    scene.apply(load([wire("w", "a", "b")]));
    frame(T0);
    scene.apply({ kind: "wireMode", mode: "loupe" });
    frame(T0);
    expect(record(scene, 1)[4]).toBeCloseTo(0.07, 3);
    // Mid-transition the value is between; the frame reports motion.
    expect(frame(T0 + 60)).toBe(true);
    const mid = record(scene, 1)[4]!;
    expect(mid).toBeGreaterThan(0.07);
    expect(mid).toBeLessThan(0.9);
    frame(T0 + 5000);
    expect(record(scene, 1)[4]).toBeCloseTo(0.9, 5);
    expect(frame(T0 + 5016)).toBe(false);
    scene.apply({ kind: "wireMode", mode: "rest" });
    frame(T0 + 6000);
    expect(record(scene, 1)[4]).toBeCloseTo(0.07, 5);
  });

  it("steps back at far and hides at overview, but keeps a track", () => {
    const { scene, frame } = makeScene(board());
    scene.apply(load([wire("w", "a", "b"), wire("f", "a", "c", "flows")]));
    frame(T0, "far");
    frame(T0 + 5000, "far");
    expect(record(scene, 1)[4]).toBeCloseTo(0.07 * 0.4, 5);
    frame(T0 + 6000, "overview");
    frame(T0 + 11000, "overview");
    expect(record(scene, 1)[4]).toBe(0);
    // The flows wire's hairline is never painted, its track always is.
    expect(record(scene, 2)[4]).toBe(0);
    expect(record(scene, 2)[6]).toBe(1);
    expect(record(scene, 2)[7]).toBe(1);
    expect(scene.trackPool.extent()).toBeGreaterThan(0);
  });

  it("selects a wire to full opacity with a glow strip, and lets the glow go when it is released", () => {
    const { scene, frame } = makeScene(board());
    scene.apply(load([wire("w", "a", "b")]));
    scene.apply({ kind: "selection", fact: { nodeIds: [], wireId: "w" } });
    frame(T0 + 5000);
    const r = record(scene, 1);
    expect(r[4]).toBe(1);
    expect(r[16]).toBeGreaterThan(0);
    expect(r[17]).toBeGreaterThan(0);
    expect(scene.glowPool.extent()).toBeGreaterThan(0);
    scene.apply({ kind: "selection", fact: { nodeIds: [] } });
    frame(T0 + 6000);
    frame(T0 + 9000);
    expect(record(scene, 1)[17]).toBe(0);
  });

  it("glows a hovered wire only where it can be picked", () => {
    const { scene, frame } = makeScene(board());
    scene.apply(load([wire("w", "a", "b")]));
    scene.setHover("w");
    frame(T0 + 5000);
    expect(record(scene, 1)[17]).toBe(0);
    scene.apply({ kind: "wireMode", mode: "loupe" });
    frame(T0 + 6000);
    frame(T0 + 9000);
    expect(record(scene, 1)[17]).toBeGreaterThan(0);
  });

  it("runs a pulse across the wire in 900 ms and then lets it go", () => {
    const { scene, frame } = makeScene(board());
    scene.apply(load([wire("w", "a", "b")]));
    frame(T0);
    scene.apply({ kind: "pulse", wireId: "w", at: T0 + 100, pulse: "prompt" });
    expect(frame(T0 + 100 + WIRE_PULSE_MS / 2)).toBe(true);
    let r = record(scene, 1);
    const length = r[5]!;
    expect(r[9]! - r[8]!).toBeCloseTo(0.16 * length, 3);
    // Halfway through its 900 ms the eased dash is mid wire.
    expect((r[8]! + r[9]!) / 2).toBeCloseTo((length * 1.16) / 2 - 0.08 * length, 0);
    expect(r[15]).toBe(1);
    expect(scene.pulses()).toHaveLength(1);
    frame(T0 + 100 + WIRE_PULSE_MS + 10);
    r = record(scene, 1);
    expect(r[9]).toBe(r[8]);
    expect(scene.pulses()).toHaveLength(0);
    expect(frame(T0 + 100 + WIRE_PULSE_MS + 26)).toBe(false);
  });

  it("runs a reverse pulse from the target end", () => {
    const { scene, frame } = makeScene(board());
    scene.apply(load([wire("w", "a", "b")]));
    scene.apply({ kind: "pulse", wireId: "w", at: T0, reverse: true });
    frame(T0 + 20);
    const r = record(scene, 1);
    expect(r[9]!).toBeGreaterThan(r[5]! * 0.9);
  });

  it("holds a pulse on the whole wire under reduced motion", () => {
    const { scene, frame } = makeScene(board(), true);
    scene.apply(load([wire("w", "a", "b")]));
    scene.apply({ kind: "pulse", wireId: "w", at: T0 });
    frame(T0 + 100);
    const r = record(scene, 1);
    expect(r[8]).toBe(-1);
    expect(r[9]).toBeGreaterThan(r[5]!);
    expect(r[15]).toBeCloseTo(0.85);
  });

  it("drops a pulse past the cap of 24 at once", () => {
    const cards = new Map<string, Rect>();
    const wires: WireFact[] = [];
    for (let i = 0; i < 30; i += 1) {
      cards.set(`s${i}`, rect(0, i * 200));
      cards.set(`t${i}`, rect(600, i * 200));
      wires.push(wire(`w${i}`, `s${i}`, `t${i}`));
    }
    const { scene, frame } = makeScene(cards);
    scene.apply(load(wires));
    frame(T0);
    for (let i = 0; i < 30; i += 1) {
      scene.apply({ kind: "pulse", wireId: `w${i}`, at: T0 });
      frame(T0 + 1);
    }
    expect(scene.pulses().length).toBe(24);
  });

  it("picks only in the loupe or the cone, within 10 units, on the wire and not past its end", () => {
    const { scene, frame } = makeScene(board());
    scene.apply(load([wire("w", "a", "b")]));
    frame(T0);
    expect(scene.pick({ x: 430, y: 48 })).toBeUndefined();
    scene.apply({ kind: "wireMode", mode: "loupe" });
    frame(T0 + 1000);
    expect(scene.pick({ x: 430, y: 48 })).toBe("w");
    expect(scene.pick({ x: 430, y: 48 + 9 })).toBe("w");
    expect(scene.pick({ x: 430, y: 48 + 12 })).toBeUndefined();
    expect(scene.pick({ x: 100, y: 48 })).toBeUndefined();
  });

  it("picks the wire drawn last when two hit strokes overlap, even after a freed strip is reused", () => {
    const { scene, frame } = makeScene(board());
    scene.apply(load([wire("a", "a", "b"), wire("b", "a", "b")]));
    frame(T0);
    // Free a's run, then add c: it takes a's lower start, so b is painted over it.
    scene.apply({ kind: "removeWire", id: "a" });
    scene.apply({ kind: "wire", fact: wire("c", "a", "b") });
    scene.apply({ kind: "wireMode", mode: "loupe" });
    frame(T0 + 1000);
    expect(scene.pick({ x: 430, y: 48 })).toBe("b");
  });

  it("lights the wires in a cone and dims the rest", () => {
    const { scene, frame } = makeScene(board());
    scene.apply(load([wire("in", "a", "b"), wire("out", "a", "c")]));
    scene.apply({
      kind: "selection",
      fact: {
        nodeIds: [],
        focusMode: { kind: "connection", rootId: "a", memberIds: ["a", "b"], leadIds: [], wireIds: ["in"] },
      },
    });
    frame(T0 + 5000);
    expect(record(scene, 1)[4]).toBe(1);
    expect(record(scene, 2)[4]).toBeCloseTo(0.07 * 0.12, 5);
  });

  it("falls back to both ends for the cone when no wire ids are named", () => {
    const { scene, frame } = makeScene(board());
    scene.apply(load([wire("in", "a", "b"), wire("out", "a", "c")]));
    scene.apply({
      kind: "selection",
      fact: { nodeIds: [], focusMode: { kind: "impact", rootId: "a", memberIds: ["b"], leadIds: [] } },
    });
    frame(T0 + 5000);
    expect(record(scene, 1)[4]).toBe(1);
    expect(record(scene, 2)[4]).toBeCloseTo(0.07 * 0.12, 5);
  });

  it("draws the connection preview as a strip in the first record, in a token's colour", () => {
    const { scene, frame } = makeScene(board());
    scene.apply({ kind: "preview", preview: { from: { x: 260, y: 48 }, fromSide: "right", to: { x: 500, y: 300 } } });
    frame(T0);
    const r = record(scene, 0);
    expect(r[4]).toBe(1);
    expect(r[5]).toBeGreaterThan(250);
    expect(r[3]).toBe(1);
    expect(scene.pool.extent()).toBeGreaterThan(0);
    scene.apply({ kind: "preview", preview: null });
    expect(record(scene, 0)[4]).toBe(0);
    expect(PREVIEW_ID).toBeTruthy();
  });

  it("shows every wire at 90% while a connection is drawn", () => {
    const { scene, frame } = makeScene(board());
    scene.apply(load([wire("w", "a", "b")]));
    scene.apply({ kind: "preview", preview: { from: { x: 260, y: 48 }, fromSide: "right", to: { x: 500, y: 300 } } });
    frame(T0 + 5000);
    expect(record(scene, 1)[4]).toBeCloseTo(0.9, 5);
  });

  it("frees a removed wire's strip and zeroes its record, and reuses the slot", () => {
    const { scene, frame } = makeScene(board());
    scene.apply(load([wire("w", "a", "b")]));
    frame(T0);
    scene.apply({ kind: "removeWire", id: "w" });
    expect(record(scene, 1).every((x) => x === 0)).toBe(true);
    scene.apply({ kind: "wire", fact: wire("x", "a", "c") });
    frame(T0 + 1);
    expect(record(scene, 1)[4]).toBeCloseTo(0.07);
  });

  it("does not draw a wire whose card is not on the board yet, then draws it when it arrives", () => {
    const cards = new Map<string, Rect>([["a", rect(0, 0)]]);
    const { scene, frame } = makeScene(cards);
    scene.apply(load([wire("w", "a", "b")]));
    frame(T0);
    expect(scene.inspect("w")).toBeUndefined();
    cards.set("b", rect(600, 0));
    frame(T0 + 16);
    expect(scene.inspect("w")!.kind).toBe("elbow");
  });

  it("rewrites only the changed span: a selection touches records, not strips", () => {
    const { scene, frame } = makeScene(board());
    scene.apply(load([wire("w", "a", "b"), wire("x", "a", "c")]));
    frame(T0);
    scene.dirtyRecords.take();
    scene.pool.dirtyVertices.take();
    scene.pool.dirtyIndices.take();
    scene.apply({ kind: "wireMode", mode: "loupe" });
    expect(scene.pool.dirtyVertices.any()).toBe(false);
    expect(scene.pool.dirtyIndices.any()).toBe(false);
    expect(scene.dirtyRecords.any()).toBe(true);
    expect(STRIP_FLOATS).toBe(7);
  });
});
