// @vitest-environment jsdom
/**
 * A burst of seat reports wakes the ring, the terminal card and the atlas once.
 *
 * A report replaces the seat's event object. The card and its shell were fixed
 * first (1c3e3537b); the ring and the terminal card read the same object, and
 * their read is what the atlas is asked for: a seat's portrait content key is
 * its expression, which comes from the seat's activity, health and signal. A
 * report that changes neither the state nor the reason must therefore draw the
 * same picture, ask for the same portrait key, and re-raster nothing. A report
 * that moves the state must draw the new face, and the atlas must be asked for
 * one new key.
 *
 * Motion law: the rings still turn and pulse every frame; what these count is
 * the per-report React work and the atlas requests behind it, not motion.
 */
import { act, Profiler } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import type { Quad, SpriteRef } from "../src/window/canvas/contract";
import { createGpuAtlas } from "../src/window/canvas/engine/gpu-atlas";
import { portraitSprite } from "../src/window/canvas/paint/images";
import { portraitExpression } from "@shared/portrait-expression";
import { portraitCharacter } from "@shared/agent-portrait";
import type { AgentSeatStateEvent } from "@shared/agent-seat-state";
import { decodeNode, type Node, type Seat } from "../src/shared/model";
import { SeatRingView, useSeatGlanceOf, type SeatGlance } from "../src/window/components/SeatRing";
import { TerminalCard } from "../src/window/components/terminal/TerminalCard";
import { applyAgentSeatStateEvent, resetAgentSeatState } from "../src/window/lib/agent-seat-state";
import { seatPortraitMood } from "../src/window/lib/portrait-mood";
import { seatCacheWindow$, seatNextTurn$ } from "../src/window/lib/seat-next-launch";
import { state$ } from "../src/window/lib/state";
import { fakeAtlasDevice } from "./gpu-canvas-fakes";
import { holdModelCanvas } from "./support/hold-canvas";
import { THIS_MACHINE } from "./support/machines";

vi.hoisted(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  };
});

const T0 = 1_700_000_000_000;
const BINDING = "binding-lead";

const report = (state: AgentSeatStateEvent["state"], at: number): AgentSeatStateEvent => ({
  bindingId: BINDING,
  epoch: "e1",
  state,
  reason: state,
  confidence: "high",
  at,
});

const seatNode = (): Node =>
  Effect.runSync(decodeNode({
    kind: "agent", id: "lead", label: "lead", x: 0, y: 0, width: 216, height: 96, z: 0,
    agentKey: `${THIS_MACHINE}:lead`, host: THIS_MACHINE, overseer: false,
    bindingId: BINDING, harness: "claude",
  }));

const terminalNode = (): Node =>
  Effect.runSync(decodeNode({
    kind: "terminal", id: "term", label: "term", x: 0, y: 0, width: 220, height: 90, z: 0,
    host: THIS_MACHINE, bindingId: BINDING,
  }));

const settle = async (): Promise<void> => {
  for (let i = 0; i < 4; i += 1) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

type ImageSprite = Extract<SpriteRef, { readonly atlas: "image" }>;

/** The portrait the atlas is asked for, from the ring's own glance. */
const portraitOf = (glance: SeatGlance, seed: string, px: number): ImageSprite =>
  portraitSprite(
    seed,
    "dark",
    px,
    portraitExpression({
      ...seatPortraitMood(
        glance.activity,
        { value: glance.health.value, healthStale: glance.health.healthStale },
        glance.signal?.kind,
      ),
      temperament: portraitCharacter(seed).temperament,
    }),
  ) as ImageSprite;

const spriteQuad = (sprite: ImageSprite): Quad => ({
  key: `lead-portrait-${sprite.key}`,
  kind: "sprite",
  band: "cards",
  z: 0,
  rect: { x: 0, y: 0, width: 28, height: 28 },
  tiers: 0,
  scale: { kind: "board" },
  style: {},
  sprite,
});

describe("a burst of seat reports", () => {
  let host: HTMLDivElement;
  let root: Root | undefined;
  let stop: (() => void) | undefined;
  let glimpses: SeatGlance[] = [];
  let ringRenders = 0;

  /** The ring as the canvas mounts it, with its glance kept for the atlas check. */
  function Ring({ node }: { readonly node: Seat }) {
    ringRenders += 1;
    const glance = useSeatGlanceOf(node);
    glimpses.push(glance);
    return <SeatRingView node={node} px={28} glance={glance} />;
  }

  beforeEach(() => {
    resetAgentSeatState();
    glimpses = [];
    ringRenders = 0;
    host = document.createElement("div");
    document.body.append(host);
    state$.settings.machine.name.set(THIS_MACHINE);
  });

  afterEach(async () => {
    await act(async () => { root?.unmount(); });
    root = undefined;
    stop?.();
    stop = undefined;
    host.remove();
    // A shared-lane worker keeps these stores between files: leave nothing of
    // this one behind for the next file to inherit.
    state$.machines.set([]);
    state$.machineFacts.set({});
    state$.settings.machine.name.set("");
    seatNextTurn$.set({});
    seatCacheWindow$.set({});
    resetAgentSeatState();
  });

  it("renders the ring once for a burst and asks the atlas for one portrait key", async () => {
    const node = seatNode() as Seat;
    stop = holdModelCanvas("factory", [node]);
    const { device, copies } = fakeAtlasDevice();
    const failures: string[] = [];
    const atlas = createGpuAtlas({ size: 64, rasterizeText: async () => ({ width: 8, height: 8, close: () => undefined }) as never, rasterizeSprite: async () => ({ width: 28, height: 28, close: () => undefined }) as never, onDirty: () => undefined, onFailure: (message) => { failures.push(message); } });
    atlas.attach(device);
    const keys = new Set<number>();

    root = createRoot(host);
    await act(async () => { root!.render(<Ring node={node} />); });
    await settle();
    const before = ringRenders;

    for (let i = 0; i < 20; i += 1) {
      applyAgentSeatStateEvent(report("working", T0 + i));
      await settle();
      const glance = glimpses[glimpses.length - 1]!;
      keys.add(atlas.acquire(spriteQuad(portraitOf(glance, "lead", 28)), 1));
    }
    await settle();

    expect(ringRenders - before).toBe(1);
    expect(keys.size).toBe(1);
    expect(atlas.stats().requests).toBe(1);
    expect(atlas.stats().landed).toBe(1);
    expect(atlas.stats().failures).toBe(0);
    expect(atlas.stats().rerasters).toBe(0);
    expect(copies.length).toBe(1);
    expect(failures).toEqual([]);

    // A report that moves the state draws the new face: one more render, one new key.
    applyAgentSeatStateEvent(report("attention", T0 + 100));
    const glance = (() => {
      let seen: SeatGlance | undefined;
      act(() => { root!.render(<Ring node={node} />); });
      seen = glimpses[glimpses.length - 1];
      return seen!;
    })();
    await settle();
    expect(ringRenders - before).toBe(2);
    const changed = atlas.acquire(spriteQuad(portraitOf(glance, "lead", 28)), 1);
    await settle();
    expect(keys.has(changed)).toBe(false);
    expect(atlas.stats().requests).toBe(2);
    expect(atlas.stats().failures).toBe(0);
    expect(atlas.stats().rerasters).toBe(0);
  });

  it("holds a mounted ring's portrait through churn, and finds it cached after a release", async () => {
    // Rule 5: a picture on screen is held by reference until its replacement
    // lands, and a landed by-key cell is still cached when the reference is
    // given up. The fault this locks against is a quad losing its own pixels at
    // an unchanged raster scale, so the churn below asks for other content and
    // lets it go while this ring stays up: the held cell may not be what pays
    // for it. The fake grows pages rather than wipe a held plot, which is why
    // this case asserts the rule and never a count of evictions.
    const node = seatNode() as Seat;
    stop = holdModelCanvas("factory", [node]);
    const { device } = fakeAtlasDevice();
    const atlas = createGpuAtlas({
      size: 64,
      rasterizeText: async () => ({ width: 8, height: 8, close: () => undefined }) as never,
      rasterizeSprite: async () => ({ width: 40, height: 40, close: () => undefined }) as never,
      onDirty: () => undefined,
      onFailure: () => undefined,
    });
    atlas.attach(device);

    root = createRoot(host);
    await act(async () => { root!.render(<Ring node={node} />); });
    await settle();
    applyAgentSeatStateEvent(report("working", T0));
    await settle();
    const glance = glimpses[glimpses.length - 1]!;
    const portrait = spriteQuad(portraitOf(glance, "lead", 40));
    const held = atlas.acquire(portrait, 1);
    await settle();
    expect(atlas.hasImage(held)).toBe(true);
    const ownKey = atlas.recordOf(held)?.contentKey;
    expect(ownKey).toBeDefined();

    // Churn while the ring is up: a gesture asks for a batch of other content,
    // the batch lands and takes plots, then lets go. The held portrait keeps
    // its cell and its own pixels throughout. Nothing here asserts an eviction
    // count: the atlas grows pages rather than wipe a held plot, so what this
    // asserts is the rule, not a number.
    const batch = Array.from({ length: 12 }, (_, i) =>
      atlas.acquire(spriteQuad(portraitSprite(`churn-${String(i)}`, "dark", 40, "resting") as ImageSprite), 1));
    await settle();
    for (const cell of batch) atlas.release(cell);
    await settle();
    expect(atlas.hasImage(held)).toBe(true);
    expect(atlas.recordOf(held)?.contentKey).toBe(ownKey);

    // Released and asked again with no report in between. No previous is
    // passed: a released cell is not one this caller still holds, and the
    // engine asks afresh when the quad comes back. A landed by-key cell stays
    // cached at release, so this is the cache hit: the same cell, its own
    // pixels, and no raster. The branch where the cell was gone instead would
    // need an eviction this fake cannot force (the atlas grows pages), and a
    // test that cannot reach a branch should not pretend to.
    atlas.release(held);
    const requestsBefore = atlas.stats().requests;
    const again = atlas.acquire(portrait, 1);
    await settle();
    expect(again).toBe(held);
    expect(atlas.stats().requests).toBe(requestsBefore);
    expect(atlas.recordOf(again)?.contentKey).toBe(ownKey);
    expect(atlas.recordOf(again)?.shows).toBe("own");
  });

  it("renders the terminal card once for a burst, and again when the seat's state moves", async () => {
    const node = terminalNode();
    stop = holdModelCanvas("factory", [node]);
    let commits = 0;
    root = createRoot(host);
    await act(async () => {
      root!.render(
        <Profiler id="terminal-card" onRender={() => { commits += 1; }}>
          <TerminalCard canvas="factory" id="term" />
        </Profiler>,
      );
    });
    await settle();
    const before = commits;
    for (let i = 0; i < 20; i += 1) {
      applyAgentSeatStateEvent(report("working", T0 + i));
      await settle();
    }
    expect(commits - before).toBe(1);
    applyAgentSeatStateEvent(report("attention", T0 + 100));
    await settle();
    expect(commits - before).toBe(2);
  });
});
