import { describe, expect, it } from "vitest";
import { evenRingCaps, RING_FOOTPRINT, RING_GAP, RING_SCALE_MAX, seatRingCaps, type RoomNode } from "../src/window/lib/seat-ring-room";
import { FAR_RING_SCREEN_PX, farSeatScale } from "../src/window/lib/canvas-tier";

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

  it("keeps the halo a seat may wear clear of its neighbour too", () => {
    const nodes = [seat("a", 0, 0), seat("b", 0, 140)];
    const caps = seatRingCaps(nodes);
    const reach = ((caps.get("a")! + caps.get("b")!) * 52 * RING_FOOTPRINT) / 2;
    expect(reach).toBeLessThanOrEqual(140 - RING_GAP + 1);
  });

  it("gives the seats of one region one size: the region's smallest", () => {
    const caps = new Map([["a", 3], ["b", 2], ["c", 4], ["lone", 4]]);
    const even = evenRingCaps(caps, (id) => ({ a: "r", b: "r", c: "s" })[id]);
    expect(even.get("a")).toBe(2);
    expect(even.get("b")).toBe(2);
    expect(even.get("c")).toBe(4);
    expect(even.get("lone")).toBe(4);
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

  it("rests at 1.75 once the floor no longer bites, and tops out at the minimum zoom's", () => {
    expect(farSeatScale(0.8)).toBe(1.75);
    expect(52 * farSeatScale(0.15) * 0.15).toBeGreaterThanOrEqual(FAR_RING_SCREEN_PX);
    expect(farSeatScale(0.05)).toBe(5.2);
    expect(farSeatScale(Number.NaN)).toBe(1.75);
  });
});

describe("ring caps on a large board (issue 912)", () => {
  /** The plain pass over every pair, the rule as written. */
  const everyPair = (nodes: ReadonlyArray<RoomNode>): Map<string, number> => {
    const caps = new Map<string, number>();
    for (const [index, node] of nodes.entries()) {
      if (node.ringPx === undefined) continue;
      const x = node.x + node.width / 2;
      const y = node.y + node.height / 2;
      const footprint = node.ringPx * RING_FOOTPRINT;
      let radius = (RING_SCALE_MAX * footprint) / 2;
      for (const [otherIndex, other] of nodes.entries()) {
        if (otherIndex === index) continue;
        const room =
          other.ringPx !== undefined
            ? Math.hypot(other.x + other.width / 2 - x, other.y + other.height / 2 - y) / 2 - RING_GAP / 2
            : Math.hypot(Math.max(other.x - x, 0, x - (other.x + other.width)), Math.max(other.y - y, 0, y - (other.y + other.height))) - RING_GAP;
        if (room < radius) radius = room;
      }
      caps.set(node.id, Math.round(Math.min(RING_SCALE_MAX, Math.max(1, (radius * 2) / footprint)) * 100) / 100);
    }
    return caps;
  };

  it("gives every seat the cap the pass over every pair gives it", () => {
    let seed = 912;
    const next = (): number => {
      seed = (Math.imul(seed, 1_103_515_245) + 12_345) >>> 0;
      return seed / 2 ** 32;
    };
    const nodes: RoomNode[] = [{ id: "huge", x: -40_000, y: -40_000, width: 80_000, height: 120 }];
    for (let i = 0; i < 600; i += 1) {
      const x = (next() - 0.5) * 9_000;
      const y = (next() - 0.5) * 6_000;
      nodes.push(
        next() < 0.6
          ? { id: `s${String(i)}`, x, y, width: 216, height: 56, ringPx: next() < 0.5 ? 52 : 40 }
          : { id: `c${String(i)}`, x, y, width: 100 + next() * 900, height: 60 + next() * 400 },
      );
    }
    const caps = seatRingCaps(nodes);
    expect(caps).toEqual(everyPair(nodes));
    // Dense enough that most rings are held by a neighbour, not the ceiling.
    expect([...caps.values()].filter((cap) => cap < RING_SCALE_MAX).length).toBeGreaterThan(caps.size / 2);
  });
});
