/**
 * The engine's wire scene (track D), on the CPU: strips in a pool, one record
 * per wire, routes from the loom's facts or the fallback elbow, modes,
 * selection, glow, pulses, tracks and picking, all at a frozen clock.
 */
import { describe, expect, it } from "vitest";
import { createWireScene, RECORD_FLOATS, PREVIEW_ID, type WireFrame } from "../src/window/canvas/engine/wires/scene";
import type { NodeId, Rect, SceneOp, WireFact, WireRouteFact } from "../src/window/canvas/contract";
import { STRIP_FLOATS, WIRE_HALF_WIDTH } from "../src/window/canvas/paint/wires";
import { WIRE_PULSE_MS } from "../src/window/lib/wire-pulse";

const T0 = 1_700_000_000_000;

const wire = (id: string, from: string, to: string, verb: "messages" | "flows" | "derives" | "navigates" = "messages"): WireFact =>
  ({ id, row: { id, from, to, verb } }) as unknown as WireFact;

type TestGathering = { readonly key: string; readonly rect: Rect };

const makeScene = (cards: Map<string, Rect>, reducedMotion = false, surfaces?: Map<string, Rect>, gatherings: Map<string, TestGathering> = new Map()) => {
  let tierNow: WireFrame["tier"] = "near";
  const gatheringWas = new Map<string, TestGathering>();
  const gatheringNow = (): ReadonlyMap<string, TestGathering> => (tierNow === "far" || tierNow === "overview" ? gatherings : new Map());
  const drainGathering = (): string[] => {
    const now = gatheringNow();
    const changed: string[] = [];
    for (const [id, gathering] of now) {
      const before = gatheringWas.get(id);
      if (before === undefined || before.key !== gathering.key || before.rect.x !== gathering.rect.x || before.rect.y !== gathering.rect.y) changed.push(id);
    }
    for (const id of gatheringWas.keys()) if (!now.has(id)) changed.push(id);
    gatheringWas.clear();
    for (const [id, gathering] of now) gatheringWas.set(id, gathering);
    return changed;
  };
  const scene = createWireScene({
    rectOf: (id: NodeId) => cards.get(id),
    ...(surfaces === undefined ? {} : { surfaceOf: (id: NodeId) => surfaces.get(id) }),
    gatheredInto: (id: NodeId) => gatheringNow().get(id),
    gatheringChanged: drainGathering,
    reducedMotion: () => reducedMotion,
  });
  const frame = (at: number, tier: WireFrame["tier"] = "near", live?: ReadonlySet<string>): boolean => {
    tierNow = tier;
    return scene.frame({ camera: { x: 0, y: 0, zoom: 1 }, width: 1600, height: 1000, pixelRatio: 2, tier, wall: at, ...(live === undefined ? {} : { live }) });
  };
  /** A card op, as a model change arrives: the wire layer rebuilds that card's wires. */
  const card = (id: string): void => {
    scene.apply({ kind: "card", fact: { id } } as unknown as SceneOp);
  };
  /** A seat joins or leaves a badge, as the model scene reports it. */
  const gather = (id: string, gathering: TestGathering | undefined): void => {
    if (gathering === undefined) gatherings.delete(id);
    else gatherings.set(id, gathering);
  };
  return { scene, frame, card, gather };
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

const badge = (key: string, x: number, y: number): TestGathering => ({ key, rect: rect(x, y, 40, 40) });

const maxStripAcross = (scene: ReturnType<typeof createWireScene>): number => {
  const vertices = scene.pool.vertices();
  let widest = 0;
  for (let at = 0; at < scene.pool.extent() * STRIP_FLOATS; at += STRIP_FLOATS) widest = Math.max(widest, Math.abs(vertices[at + 5] ?? 0));
  return widest;
};

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
    const { scene, frame, card } = makeScene(cards);
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
    frame(T0 + 16, "near", new Set(["b"]));
    expect(scene.inspect("w")!.kind).toBe("elbow");
    // The model takes the move and the loom answers: the route returns.
    cards.set("b", rect(600, 0));
    card("b");
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
    frame(T0 + 16, "near", new Set(["b"]));
    expect(scene.labelsRevision()).toBeGreaterThan(revision);
    expect(scene.labelsInView()[0]!.at).toEqual(scene.labelOf("w"));
  });

  it("hands a pan the same labels and draw list it built, allocating no label per frame (issue 912)", () => {
    const cards = new Map<string, Rect>([
      ["a", rect(0, 0)],
      ["b", rect(600, 0)],
      ["c", rect(0, 400)],
    ]);
    const { scene } = makeScene(cards);
    scene.apply(load([wire("w", "a", "b"), wire("v", "a", "c")]));
    const at = (x: number): boolean =>
      scene.frame({ camera: { x, y: 0, zoom: 1 }, width: 1600, height: 1000, pixelRatio: 2, tier: "near", wall: T0 });
    at(0);
    const list = scene.labelsInView();
    const first = [...list];
    const drawn = (): number[] => {
      const v = scene.visibleIndices();
      return Array.from(v.main.subarray(0, v.mainCount));
    };
    const indices = drawn();
    at(-5);
    expect(scene.labelsInView()).toBe(list);
    expect(scene.labelsInView()).toHaveLength(first.length);
    scene.labelsInView().forEach((label, index) => expect(label).toBe(first[index]));
    expect(drawn()).toEqual(indices);
    expect(indices.length).toBeGreaterThan(0);
    // A pan that hides a label drops it, and one that shows it again hands back the same label.
    at(-5000);
    expect(scene.labelsInView()).toHaveLength(0);
    at(0);
    scene.labelsInView().forEach((label, index) => expect(label).toBe(first[index]));
  });

  it("attaches a wire end to the body the seat draws, and moves it when that body changes", () => {
    const cards = board();
    const surfaces = new Map<string, Rect>([["a", rect(0, 0, 150, 96)]]);
    const { scene, frame, card } = makeScene(cards, false, surfaces);
    scene.apply(load([wire("w", "a", "b")]));
    const planned = [
      { x: 260, y: 48 },
      { x: 430, y: 48 },
      { x: 430, y: 200 },
      { x: 600, y: 200 },
      { x: 600, y: 48 },
    ];
    const fact: WireRouteFact = {
      id: "w",
      sourceSide: "right",
      targetSide: "left",
      source: { x: 260, y: 48 },
      target: { x: 600, y: 48 },
      lane: { source: { x: 0, y: 0 }, target: { x: 0, y: 0 } },
      points: planned,
      cable: false,
    };
    scene.apply({ kind: "routes", set: [fact], remove: [] });
    frame(T0, "mid");
    // The pill's right edge is at 150; the plan's own end at 260 is outside it.
    const points = scene.inspect("w")!.points;
    expect(points.slice(0, 2)).toEqual([{ x: 150, y: 48 }, { x: 260, y: 48 }]);
    // Everything after the plan's own end is the router's geometry, unchanged.
    expect(points.slice(2)).toEqual(planned.slice(1));
    // The far end (a left side) needs no move: the pill's left edge is the card's.
    expect(points[points.length - 1]).toEqual({ x: 600, y: 48 });

    // A wider pill (a longer name) re-attaches when the card changes.
    surfaces.set("a", rect(0, 0, 170, 96));
    card("a");
    frame(T0 + 16, "mid");
    expect(scene.inspect("w")!.points[0]).toEqual({ x: 170, y: 48 });
  });

  it("attaches a fallback elbow's end to the drawn body too", () => {
    const cards = board();
    const surfaces = new Map<string, Rect>([["a", rect(0, 0, 150, 96)]]);
    const { scene, frame } = makeScene(cards, false, surfaces);
    scene.apply(load([wire("w", "a", "b")]));
    frame(T0, "mid");
    const points = scene.inspect("w")!.points;
    // The elbow's source sits 2 units out of the card's right edge; it now
    // starts on the pill and runs straight out.
    expect(points[0]).toEqual({ x: 150, y: 48 });
    expect(points[1]!.y).toBe(48);
    expect(points[1]!.x).toBeGreaterThan(150);
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

  it("steps back at far and hides at overview by uniform, but keeps a track", () => {
    const { scene, frame } = makeScene(board());
    scene.apply(load([wire("w", "a", "b"), wire("f", "a", "c", "flows")]));
    frame(T0, "far");
    frame(T0 + 5000, "far");
    // The wire keeps its base opacity; the tier's scale is a uniform.
    expect(record(scene, 1)[4]).toBeCloseTo(0.07, 5);
    expect(scene.uniforms().tier).toEqual([0.4, 0]);
    frame(T0 + 6000, "overview");
    frame(T0 + 11000, "overview");
    expect(record(scene, 1)[4]).toBeCloseTo(0.07, 5);
    expect(scene.uniforms().tier).toEqual([1, 1]);
    // The flows wire's hairline is never painted, its track always is.
    expect(record(scene, 2)[4]).toBe(0);
    expect(record(scene, 2)[6]).toBe(1);
    expect(record(scene, 2)[7]).toBe(1);
    expect(scene.trackPool.extent()).toBeGreaterThan(0);
  });

  it("breaks the visible index list between wires, so no triangle spans two of them", () => {
    const { scene, frame } = makeScene(board());
    scene.apply(load([wire("w", "a", "b"), wire("x", "a", "c")]));
    frame(T0);
    const v = scene.visibleIndices();
    const drawn = v.main.subarray(0, v.mainCount);
    // One restart per strip, and the strips' own indices between them.
    expect([...drawn].filter((index) => index === 0xffffffff)).toHaveLength(2);
    // Each run between restarts is the strip's own consecutive vertices.
    for (let i = 1; i < drawn.length; i += 1) {
      if (drawn[i] === 0xffffffff || drawn[i - 1] === 0xffffffff) continue;
      expect(drawn[i]).toBe(drawn[i - 1]! + 1);
    }
  });

  it("re-attaches only when a tier changes the body a card draws, not on every crossing", () => {
    const cards = board();
    const surfaces = new Map<string, Rect>();
    const { scene, card } = makeScene(cards, false, surfaces);
    scene.apply(load([wire("w", "a", "b")]));
    const frame = (at: number, tier: WireFrame["tier"]): boolean =>
      scene.frame({ camera: { x: 0, y: 0, zoom: 1 }, width: 1600, height: 1000, pixelRatio: 2, tier, wall: at });
    frame(T0, "near");
    const near = scene.builds();
    // Near to far to overview changes only the paint: the plan and the strips stay.
    frame(T0 + 16, "far");
    expect(scene.builds()).toBe(near);
    frame(T0 + 24, "overview");
    expect(scene.builds()).toBe(near);
    // Mid draws a pill where the card was: every wire re-attaches once.
    surfaces.set("a", rect(0, 0, 150, 96));
    frame(T0 + 40, "mid");
    expect(scene.builds()).toBeGreaterThan(near);
    const mid = scene.builds();
    // The near strip was kept: leaving mid swaps it in, with no rebuild.
    surfaces.clear();
    frame(T0 + 48, "near");
    expect(scene.builds()).toBe(mid);
    // The pill strip is kept too: a second crossing to mid swaps it in.
    surfaces.set("a", rect(0, 0, 150, 96));
    frame(T0 + 56, "mid");
    expect(scene.builds()).toBe(mid);
    // A card move invalidates both bodies: the next mid crossing rebuilds.
    card("b");
    frame(T0 + 64, "mid");
    expect(scene.builds()).toBeGreaterThan(mid);
    const moved = scene.builds();
    surfaces.clear();
    frame(T0 + 80, "near");
    expect(scene.builds()).toBeGreaterThan(moved);
  });

  it("re-lays a track when a later run moves even though the first run and path length do not", () => {
    const { scene, frame } = makeScene(board());
    scene.apply(load([wire("f", "a", "b", "flows")]));
    const plan = (x: number): WireRouteFact => ({
      id: "f",
      sourceSide: "right",
      targetSide: "left",
      source: { x: 260, y: 48 },
      target: { x: 600, y: 48 },
      lane: { source: { x: 0, y: 0 }, target: { x: 0, y: 0 } },
      points: [
        { x: 260, y: 48 },
        { x, y: 48 },
        { x, y: 200 },
        { x: 600, y: 200 },
        { x: 600, y: 48 },
      ],
      cable: false,
    });
    scene.apply({ kind: "routes", set: [plan(430)], remove: [] });
    frame(T0);
    const before = scene.trackPool.vertices().slice();
    expect(before.length).toBeGreaterThan(0);
    // 430 to 420 keeps every coordinate the same width, so the path string is
    // as long as before while the second horizontal run grows ten units.
    scene.apply({ kind: "routes", set: [plan(420)], remove: [] });
    frame(T0 + 16);
    expect(scene.trackPool.vertices().slice()).not.toEqual(before);
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
      cards.set(`s${i}`, rect(0, i * 20));
      cards.set(`t${i}`, rect(600, i * 20));
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

  it("steps no motion for a wire no one can see, and rejoins at the clock", () => {
    const cards = new Map<string, Rect>([
      ["a", rect(0, 4000)],
      ["b", rect(600, 4000)],
    ]);
    const { scene, frame } = makeScene(cards);
    scene.apply(load([wire("w", "a", "b")]));
    frame(T0);
    scene.apply({ kind: "pulse", wireId: "w", at: T0 });
    // Off screen: no step, no draw, and the frame is not busy for it.
    expect(frame(T0 + 1)).toBe(false);
    expect(scene.pulses()).toEqual([]);
    // On screen: the same pulse is mid-flight at the clock's phase, not restarted.
    cards.set("a", rect(0, 0));
    cards.set("b", rect(600, 0));
    scene.apply({ kind: "card", fact: { id: "a" } } as unknown as SceneOp);
    scene.apply({ kind: "card", fact: { id: "b" } } as unknown as SceneOp);
    expect(frame(T0 + 2)).toBe(true);
    expect(scene.pulses().length).toBe(1);
  });

  it("builds a cold tier crossing for the wires in view, and the rest when the view reaches them", () => {
    const cards = new Map<string, Rect>();
    const wires: WireFact[] = [];
    for (let i = 0; i < 20; i += 1) {
      // Two wires on screen; eighteen far below it.
      const y = i < 2 ? i * 200 : 4000 + i * 20;
      cards.set(`s${i}`, rect(0, y));
      cards.set(`t${i}`, rect(600, y));
      wires.push(wire(`w${i}`, `s${i}`, `t${i}`));
    }
    const { scene } = makeScene(cards);
    const frameAt = (at: number, tier: WireFrame["tier"], camera: WireFrame["camera"]) =>
      scene.frame({ camera, width: 1600, height: 1000, pixelRatio: 2, tier, wall: at });
    const still = { x: 0, y: 0, zoom: 1 };
    scene.apply(load(wires));
    frameAt(T0, "near", still);
    const before = scene.builds();
    frameAt(T0 + 16, "mid", still);
    const builtAtCrossing = scene.builds() - before;
    expect(builtAtCrossing).toBeGreaterThan(0);
    expect(builtAtCrossing).toBeLessThan(wires.length);
    // The view reaching the rest builds them then.
    frameAt(T0 + 32, "mid", { x: 0, y: -4000, zoom: 1 });
    expect(scene.builds()).toBeGreaterThan(before + builtAtCrossing);
  });

  it("gives an off-screen pulse no slot, so in-view traffic still lights", () => {
    const cards = new Map<string, Rect>();
    const wires: WireFact[] = [];
    for (let i = 0; i < 30; i += 1) {
      cards.set(`off-s${i}`, rect(0, 4000 + i * 20));
      cards.set(`off-t${i}`, rect(600, 4000 + i * 20));
      wires.push(wire(`off-${i}`, `off-s${i}`, `off-t${i}`));
      cards.set(`on-s${i}`, rect(0, i * 20));
      cards.set(`on-t${i}`, rect(600, i * 20));
      wires.push(wire(`on-${i}`, `on-s${i}`, `on-t${i}`));
    }
    const { scene, frame } = makeScene(cards);
    scene.apply(load(wires));
    frame(T0);
    for (let i = 0; i < 30; i += 1) {
      scene.apply({ kind: "pulse", wireId: `off-${i}`, at: T0 });
      frame(T0 + 1);
    }
    // None of the off-screen pulses took a slot.
    expect(scene.pulses()).toEqual([]);
    for (let i = 0; i < 30; i += 1) {
      scene.apply({ kind: "pulse", wireId: `on-${i}`, at: T0 + 2 });
      frame(T0 + 2 + i);
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

  it("follows a rewired wire's new card, not only the card it used to end on", () => {
    const cards = board();
    cards.set("d", rect(0, 600));
    const { scene, frame, card } = makeScene(cards);
    scene.apply(load([wire("w", "a", "b")]));
    frame(T0);
    // The same wire now ends on d: a card op for d must rebuild it.
    scene.apply({ kind: "wire", fact: wire("w", "a", "d") } as unknown as SceneOp);
    frame(T0 + 16);
    const before = scene.inspect("w")!.points[scene.inspect("w")!.points.length - 1]!;
    cards.set("d", rect(300, 600));
    card("d");
    frame(T0 + 32);
    const after = scene.inspect("w")!.points[scene.inspect("w")!.points.length - 1]!;
    expect(after).not.toEqual(before);
    expect(after.y).toBe(648);
    expect(after.x).toBeGreaterThanOrEqual(297);
    expect(after.x).toBeLessThanOrEqual(302);
  });

  it("does not draw a wire whose card is not on the board yet, then draws it when it arrives", () => {
    const cards = new Map<string, Rect>([["a", rect(0, 0)]]);
    const { scene, frame, card } = makeScene(cards);
    scene.apply(load([wire("w", "a", "b")]));
    frame(T0);
    expect(scene.inspect("w")).toBeUndefined();
    cards.set("b", rect(600, 0));
    card("b");
    frame(T0 + 16);
    expect(scene.inspect("w")!.kind).toBe("elbow");
  });


  it("ends a gathered seat's wire on its badge disc, not on the seat's card", () => {
    const cards = board();
    const gatherings = new Map<string, TestGathering>([["a", badge("k1", 100, 0)]]);
    const { scene, frame } = makeScene(cards, false, undefined, gatherings);
    scene.apply(load([wire("w", "a", "b")]));
    frame(T0, "far");
    const points = scene.inspect("w")!.points;
    expect(points[0]!.x).toBeLessThan(200);
    expect(points[0]!.x).toBeGreaterThan(130);
    expect(points[0]!.y).toBe(20);
    expect(points[points.length - 1]!.x).toBeGreaterThan(590);
  });

  it("draws and picks nothing for a wire whose ends are inside one badge", () => {
    const cards = board();
    const gatherings = new Map<string, TestGathering>([
      ["a", badge("k1", 100, 0)],
      ["b", badge("k1", 100, 0)],
    ]);
    const { scene, frame } = makeScene(cards, false, undefined, gatherings);
    scene.apply(load([wire("w", "a", "b")]));
    frame(T0, "far");
    expect(scene.inspect("w")).toBeUndefined();
    expect(scene.folds()).toHaveLength(0);
    expect(scene.foldOf("w")).toEqual(["w"]);
    expect(scene.pick({ x: 120, y: 20 })).toBeUndefined();
  });

  it("folds wires between two badges into one widening strip, led by the tracked wire and picked as that wire", () => {
    const cards = board();
    cards.set("d", rect(600, 300));
    const gatherings = new Map<string, TestGathering>([
      ["a", badge("k1", 100, 0)],
      ["b", badge("k1", 100, 0)],
      ["c", badge("k2", 600, 0)],
      ["d", badge("k2", 600, 0)],
    ]);
    const { scene, frame } = makeScene(cards, false, undefined, gatherings);
    scene.apply(load([wire("lead", "a", "c", "flows")]));
    frame(T0, "far");
    const single = maxStripAcross(scene);
    expect(single).toBeCloseTo(WIRE_HALF_WIDTH, 4);
    scene.apply({ kind: "wire", fact: wire("same", "b", "c") } as unknown as SceneOp);
    scene.apply({ kind: "wire", fact: wire("reverse", "d", "a") } as unknown as SceneOp);
    frame(T0 + 16, "far");
    const folds = scene.folds();
    expect(folds).toHaveLength(1);
    expect(folds[0]!.lead).toBe("lead");
    expect(folds[0]!.members).toEqual(["lead", "reverse", "same"]);
    expect(scene.foldOf("reverse")).toEqual(["lead", "reverse", "same"]);
    expect(maxStripAcross(scene)).toBeCloseTo(WIRE_HALF_WIDTH * (1 + Math.log2(3)), 4);
    scene.apply({ kind: "wireMode", mode: "loupe" });
    const at = folds[0]!.points[Math.floor(folds[0]!.points.length / 2)]!;
    expect(scene.pick(at)).toBe("lead");
    expect(scene.inspect("reverse")).toMatchObject({ kind: "elbow", pickable: true });
  });

  it("moves only the changed seat's wires when a regroup drains", () => {
    const cards = board();
    cards.set("d", rect(600, 300));
    const gatherings = new Map<string, TestGathering>([
      ["a", badge("k1", 100, 0)],
      ["b", badge("k1", 100, 0)],
      ["c", badge("k2", 600, 0)],
      ["d", badge("k2", 600, 0)],
    ]);
    const { scene, frame, gather } = makeScene(cards, false, undefined, gatherings);
    scene.apply(load([wire("changed", "a", "c"), wire("kept", "b", "d")]));
    frame(T0, "far");
    expect(scene.folds()).toHaveLength(1);
    gather("a", badge("k3", 0, 300));
    frame(T0 + 16, "far");
    const folds = scene.folds();
    expect(folds).toHaveLength(2);
    expect(folds.find((fold) => fold.members.includes("changed"))!.members).toEqual(["changed"]);
    expect(folds.find((fold) => fold.members.includes("kept"))!.members).toEqual(["kept"]);
  });

  it("unfolds at mid with no strip rebuild once both tier strips are warm", () => {
    const cards = board();
    const { scene, frame, gather } = makeScene(cards);
    scene.apply(load([wire("w", "a", "b")]));
    frame(T0, "mid");
    frame(T0 + 16, "far");
    gather("a", badge("k1", 100, 0));
    frame(T0 + 32, "far");
    expect(scene.folds()).toHaveLength(1);
    const builds = scene.builds();
    frame(T0 + 48, "mid");
    expect(scene.builds()).toBe(builds);
    expect(scene.folds()).toHaveLength(0);
    expect(scene.inspect("w")).toMatchObject({ kind: "elbow" });
  });

  it("plays a member's pulse on its fold and drops one wholly inside a badge", () => {
    const cards = board();
    const gatherings = new Map<string, TestGathering>([
      ["a", badge("k1", 100, 0)],
      ["c", badge("k2", 600, 400)],
    ]);
    const { scene, frame, gather } = makeScene(cards, false, undefined, gatherings);
    scene.apply(load([wire("w", "a", "c")]));
    frame(T0, "far");
    scene.apply({ kind: "pulse", wireId: "w", at: T0 + 100, pulse: "notice" } as unknown as SceneOp);
    expect(scene.busy(T0 + 100)).toBe(true);
    gather("c", badge("k1", 100, 0));
    frame(T0 + 200, "far");
    scene.apply({ kind: "pulse", wireId: "w", at: T0 + 200, pulse: "notice" } as unknown as SceneOp);
    expect(scene.busy(T0 + 200)).toBe(false);
    expect(WIRE_PULSE_MS).toBeGreaterThan(0);
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
