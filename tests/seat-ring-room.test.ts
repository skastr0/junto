import { describe, expect, it } from "vitest";
import { RING_GAP, RING_SCALE_MAX, seatRingCaps, type RoomNode } from "../src/renderer/lib/seat-ring-room";
import { FAR_RING_SCREEN_PX, farSeatScale } from "../src/renderer/lib/canvas-tier";

const seat = (id: string, x: number, y: number): RoomNode => ({ id, x, y, width: 184, height: 56, ringPx: 52 });
const card = (id: string, x: number, y: number, width = 220, height = 84): RoomNode => ({ id, x, y, width, height });

const centre = (node: RoomNode): readonly [number, number] => [node.x + node.width / 2, node.y + node.height / 2];

describe("seatRingCaps", () => {
  it("lets a lone seat's ring grow to the ceiling", () => {
    expect(seatRingCaps([seat("a", 0, 0)]).get("a")).toBe(RING_SCALE_MAX);
  });

  it("stops two neighbouring rings a gap apart", () => {
    const nodes = [seat("a", 0, 0), seat("b", 0, 140)];
    const caps = seatRingCaps(nodes);
    const [ax, ay] = centre(nodes[0]!);
    const [bx, by] = centre(nodes[1]!);
    const reach = ((caps.get("a")! + caps.get("b")!) * 52) / 2;
    expect(reach).toBeLessThanOrEqual(Math.hypot(bx - ax, by - ay) - RING_GAP + 1);
    expect(caps.get("a")).toBeGreaterThan(2);
  });

  it("stops a ring at a card's edge, and caps only ringed seats", () => {
    const nodes = [seat("a", 0, 0), card("n", 0, 100)];
    const caps = seatRingCaps(nodes);
    // Centre at y 28, card edge at y 100: 72 units, less the gap.
    expect((caps.get("a")! * 52) / 2).toBeLessThanOrEqual(72 - RING_GAP + 0.5);
    expect(caps.has("n")).toBe(false);
  });

  it("never shrinks a ring below its own size", () => {
    expect(seatRingCaps([seat("a", 0, 0), seat("b", 10, 10)]).get("a")).toBe(1);
  });
});

describe("farSeatScale", () => {
  it("holds a seat ring at the screen floor across the far tier", () => {
    for (const zoom of [0.2, 0.24, 0.3, 0.34]) {
      const onScreen = 52 * farSeatScale(zoom) * zoom;
      expect(onScreen).toBeGreaterThanOrEqual(FAR_RING_SCREEN_PX);
      expect(onScreen).toBeLessThan(FAR_RING_SCREEN_PX + 2);
    }
  });

  it("rests at 1.75 once the floor no longer bites, and tops out at 4.6", () => {
    expect(farSeatScale(0.8)).toBe(1.75);
    expect(farSeatScale(0.05)).toBe(4.6);
    expect(farSeatScale(Number.NaN)).toBe(1.75);
  });
});
