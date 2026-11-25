// The GPU holds what the scene says: after a camera jump into the far tiers
// that builds many region badges at once, every quad and every owner row the
// scene wrote has reached the GPU, and every slot the draw list names carries
// the scene's bytes. The mirror below applies a frame's dirty ranges as
// `renderer.upload` does and nothing else, so a badge the scene built but never
// marked for upload shows here as bytes the GPU does not have (the gate's five
// badges that drew nothing until the camera moved).

import { describe, expect, it } from "vitest";
import { asCanvasName } from "@shared/model";
import { ringState } from "@shared/wire/rings";
import type { CardFact, SeatLive } from "../src/window/canvas/contract";
import { ALL_TIERS, TIER_BIT } from "../src/window/canvas/contract";
import { createScene } from "../src/window/canvas/engine/scene";
import { QUAD_BYTES } from "../src/window/canvas/engine/quad";
import { agentFact } from "./canvas-paint-fixtures";

const oneQuad = () => ({
  quads: [{ key: "body", kind: "shape" as const, band: "cards" as const, z: 1, rect: { x: 0, y: 0, width: 216, height: 56 }, tiers: ALL_TIERS, scale: { kind: "board" as const }, style: {} }],
  dim: { opacity: 1, saturate: 1 },
  lift: 0,
});

const live = (): SeatLive => ({
  ring: ringState({ glyph: "work", tone: "cyan" }),
  line: "running",
  mark: { tone: "cyan", label: "working" },
  urgency: 0,
  running: true,
  overseer: false,
  ringSince: 1_000,
});

/** 60 regions of 1 to 6 seats each, spread over a 12 x 5 grid of 1800 unit cells. */
const board = (): CardFact[] => {
  const cards: CardFact[] = [];
  for (let region = 0; region < 60; region += 1) {
    const cx = (region % 12) * 1800 + 900;
    const cy = Math.floor(region / 12) * 1800 + 900;
    const count = (region % 6) + 1;
    for (let i = 0; i < count; i += 1) {
      const id = `r${String(region).padStart(2, "0")}-s${String(i)}`;
      cards.push({ ...agentFact(), id, row: { ...agentFact().row, id, x: cx + (i % 3) * 240, y: cy + Math.floor(i / 3) * 100 }, derived: { ...agentFact().derived, regionId: `r${String(region).padStart(2, "0")}` } } as CardFact);
    }
  }
  return cards;
};

type Mirror = { quads: Uint8Array; owners: Float32Array; order: Uint32Array };

describe("the GPU copy of the scene after a jump into the far tiers", () => {
  it("holds every quad and owner row the scene wrote, and the draw list's bytes", () => {
    let zoom = 1;
    const scene = createScene({ painter: oneQuad, zoom: () => zoom });
    const cards = board();
    scene.apply({ kind: "load", canvas: asCanvasName("factory"), cards, wires: [] });
    for (const card of cards) scene.apply({ kind: "seat", id: card.id, live: live() });
    const gpu: Mirror = { quads: new Uint8Array(0), owners: new Float32Array(0), order: new Uint32Array(0) };
    const upload = (orderChanged: boolean): void => {
      // As renderer.upload: grown buffers are written whole, dirty slots otherwise.
      const quadDirty = scene.takeQuadDirty();
      const quadBytes = new Uint8Array(scene.quadBuffer.bytes);
      if (gpu.quads.length < scene.quadCapacity * QUAD_BYTES) {
        const next = new Uint8Array(scene.quadCapacity * QUAD_BYTES);
        next.set(gpu.quads);
        gpu.quads = next;
        gpu.quads.set(quadBytes.subarray(0, scene.quadCount * QUAD_BYTES));
      } else if (quadDirty.all) gpu.quads.set(quadBytes.subarray(0, scene.quadCount * QUAD_BYTES));
      else for (const slot of quadDirty.slots) gpu.quads.set(quadBytes.subarray(slot * QUAD_BYTES, (slot + 1) * QUAD_BYTES), slot * QUAD_BYTES);
      const ownerDirty = scene.takeOwnerDirty();
      if (gpu.owners.length < scene.ownerCapacity * 8) {
        const next = new Float32Array(scene.ownerCapacity * 8);
        next.set(gpu.owners);
        gpu.owners = next;
        gpu.owners.set(scene.ownerBuffer.subarray(0, scene.ownerCapacity * 8));
      } else if (ownerDirty.all) gpu.owners.set(scene.ownerBuffer.subarray(0, scene.ownerCapacity * 8));
      else for (const slot of ownerDirty.slots) gpu.owners.set(scene.ownerBuffer.subarray(slot * 8, slot * 8 + 8), slot * 8);
      if (orderChanged) {
        if (gpu.order.length < scene.orderBuffer.length) gpu.order = new Uint32Array(scene.orderBuffer.length);
        gpu.order.set(scene.orderBuffer.subarray(0, scene.orderCount));
      }
    };
    const frame = (view: { x: number; y: number; width: number; height: number }, tier: "near" | "mid" | "overview" | "far", z: number): void => {
      zoom = z;
      const prepared = scene.prepare(view, tier);
      upload(prepared.orderChanged);
    };
    const check = (label: string): void => {
      // Every slot the draw list names, and the owner row it draws under.
      const sceneBytes = new Uint8Array(scene.quadBuffer.bytes);
      expect(scene.orderCount, label).toBeGreaterThan(0);
      for (let index = 0; index < scene.orderCount; index += 1) {
        expect(gpu.order[index], `${label}: order[${String(index)}]`).toBe(scene.orderBuffer[index]);
        const slot = scene.orderBuffer[index]!;
        const sceneQuad = sceneBytes.subarray(slot * QUAD_BYTES, (slot + 1) * QUAD_BYTES);
        const gpuQuad = gpu.quads.subarray(slot * QUAD_BYTES, (slot + 1) * QUAD_BYTES);
        if (!sceneQuad.every((byte: number, at: number) => byte === gpuQuad[at])) throw new Error(`${label}: quad slot ${String(slot)} (order ${String(index)} of ${String(scene.orderCount)}) is not what the GPU holds`);
      }
      for (let at = 0; at < scene.ownerCapacity * 8; at += 1) {
        if (gpu.owners[at] !== scene.ownerBuffer[at]) throw new Error(`${label}: owner row ${String(Math.floor(at / 8))} word ${String(at % 8)} differs (scene ${String(scene.ownerBuffer[at])}, gpu ${String(gpu.owners[at])})`);
      }
    };

    /** The draw list holds exactly what is drawable: every drawn card part and every drawn badge part, once. */
    const countCheck = (label: string, tierBit: number): void => {
      let expected = 0;
      for (const card of cards) expected += scene.partsOf(card.id).filter((part) => part.drawn).length;
      for (const badge of scene.clusters()) if (badge.drawn) expected += scene.badgePartsOf(badge.key).filter((part) => (part.tiers & tierBit) !== 0).length;
      expect(scene.orderCount, `${label}: draw list length against the drawable parts`).toBe(expected);
    };
    // Near on the first cell, as a boot does.
    frame({ x: 0, y: 0, width: 800, height: 600 }, "near", 1);
    frame({ x: 0, y: 0, width: 800, height: 600 }, "near", 1);
    check("near");
    // The jump: the overview over the middle of the board, at one camera, two frames.
    const overview = { x: 3000, y: 1200, width: 1726 / 0.15, height: 959 / 0.15 };
    frame(overview, "overview", 0.15);
    check("overview, first frame");
    frame(overview, "overview", 0.15);
    check("overview, second frame");
    countCheck("overview", TIER_BIT.overview);
    // Seat reports after the jump repaint many gathered seats: each takes the splice path.
    for (let round = 0; round < 3; round += 1) {
      for (const [index, card] of cards.entries()) {
        if (index % 2 === round % 2) continue;
        scene.apply({ kind: "seat", id: card.id, live: { ...live(), ringSince: 2_000 + round * 100 + index, ring: ringState({ glyph: round % 2 === 0 ? "work" : "rest", tone: round % 2 === 0 ? "cyan" : "steel" }) } });
      }
      frame(overview, "overview", 0.15);
      check(`overview, seat reports round ${String(round)}`);
      countCheck(`overview, seat reports round ${String(round)}`, TIER_BIT.overview);
    }
    // Far on another cell, then back to overview at the same camera.
    const far = { x: 9000, y: 4000, width: 1726 / 0.3, height: 959 / 0.3 };
    frame(far, "far", 0.3);
    check("far");
    frame(overview, "overview", 0.15);
    check("overview again");
  });
});
