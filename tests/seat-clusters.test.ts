import { describe, expect, it } from "vitest";
import {
  buildClusterIndex,
  clusterSpan,
  clustersOf,
  linksHeldAt,
  SEAT_FLOOR_SCREEN_PX,
  type ClusterSeat,
} from "../src/renderer/lib/seat-clusters";

const seat = (id: string, x: number, y: number, region = "r"): ClusterSeat => ({ id, x, y, region });

/** A row of seats `gap` flow units apart. */
const row = (count: number, gap: number, region = "r", y = 0): ClusterSeat[] =>
  Array.from({ length: count }, (_, i) => seat(`${region}-${String(i)}`, i * gap, y, region));

const at = (seats: ReadonlyArray<ClusterSeat>, zoom: number, apart: ReadonlySet<string> = new Set()) => {
  const index = buildClusterIndex(seats, apart);
  return clustersOf(index, linksHeldAt(index, zoom));
};

describe("seat clusters", () => {
  it("leaves seats apart while a floor ring fits between them", () => {
    // 290 units apart at 0.15 is 43px on screen: room for a 22px ring.
    expect(at(row(4, 290), 0.15)).toEqual([]);
  });

  it("gathers seats closer than a floor ring, and parts them as the camera comes in", () => {
    const seats = row(4, 140);
    const far = at(seats, 0.15);
    expect(far).toHaveLength(1);
    expect(far[0]!.members).toHaveLength(4);
    // The cluster says where it parts, and at that zoom it has.
    expect(140 * far[0]!.partsAt).toBeGreaterThanOrEqual(SEAT_FLOOR_SCREEN_PX);
    expect(at(seats, far[0]!.partsAt * 1.01)).toEqual([]);
  });

  it("never gathers a seat that needs the operator", () => {
    const seats = row(5, 100);
    const clusters = at(seats, 0.15, new Set(["r-2"]));
    const gathered = clusters.flatMap((cluster) => cluster.members);
    expect(gathered).not.toContain("r-2");
    expect(gathered).toHaveLength(4);
  });

  it("gathers only within a region", () => {
    const seats = [...row(2, 60, "a"), ...row(2, 60, "b", 40)];
    const clusters = at(seats, 0.15);
    expect(clusters).toHaveLength(2);
    for (const cluster of clusters) expect(new Set(cluster.members.map((id) => id[0])).size).toBe(1);
  });

  it("sits a cluster at its seats' centroid, keyed by its first member", () => {
    const [cluster] = at([seat("b", 0, 0), seat("a", 100, 0)], 0.15);
    expect(cluster).toMatchObject({ key: "a", x: 50, y: 0 });
  });

  it("holds more links as the camera pulls back", () => {
    const index = buildClusterIndex(row(6, 150));
    expect(linksHeldAt(index, 0.3)).toBe(0);
    expect(linksHeldAt(index, 0.15)).toBe(5);
    expect(clusterSpan(0.2)).toBeCloseTo(130);
  });
});
