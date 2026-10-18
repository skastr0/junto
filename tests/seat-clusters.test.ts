import { describe, expect, it } from "vitest";
import {
  buildClusterIndex,
  clusterSpan,
  clustersOf,
  linksHeldAt,
  linksHeldFor,
  RINGS_PER_SCREEN,
  SEAT_FLOOR_SCREEN_PX,
  screensAt,
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

describe("seat clusters: the ring budget", () => {
  const view = { width: 1440, height: 900 };
  /** Rings the board draws: apart seats, ungathered seats and one per cluster. */
  const drawn = (seats: ReadonlyArray<ClusterSeat>, zoom: number, apart: ReadonlySet<string> = new Set()): number => {
    const index = buildClusterIndex(seats, apart);
    const clusters = clustersOf(index, linksHeldFor(index, zoom, view));
    const gathered = clusters.reduce((n, cluster) => n + cluster.members.length, 0);
    return seats.length - gathered + clusters.length;
  };
  /** A grid of seats `gap` flow units apart, one region a row. */
  const grid = (cols: number, rows: number, gap: number): ClusterSeat[] =>
    Array.from({ length: rows }, (_, r) => row(cols, gap, `g${String(r)}`, r * gap)).flat();

  it("a board on one screen draws no more than the budget, though every ring fits", () => {
    const seats = grid(10, 10, 300);
    // 300 units at 0.3 is 90px apart: room for every ring, and 810px square.
    expect(screensAt(buildClusterIndex(seats), 0.3, view)).toBe(1);
    expect(at(seats, 0.3)).toEqual([]);
    expect(drawn(seats, 0.3)).toBeLessThanOrEqual(RINGS_PER_SCREEN);
  });

  it("a board several screens wide keeps the budget per screen", () => {
    const seats = grid(40, 4, 400);
    const index = buildClusterIndex(seats);
    const screens = screensAt(index, 0.3, view);
    expect(screens).toBeGreaterThan(3);
    expect(drawn(seats, 0.3)).toBeLessThanOrEqual(Math.floor(RINGS_PER_SCREEN * screens));
    expect(drawn(seats, 0.3)).toBeGreaterThan(RINGS_PER_SCREEN);
  });

  it("leaves a small board alone", () => {
    const seats = row(RINGS_PER_SCREEN, 400);
    expect(drawn(seats, 0.3)).toBe(RINGS_PER_SCREEN);
  });

  it("gathers the closest seats first", () => {
    const tight = row(3, 100, "t");
    // Two seats over budget, on one screen: the two tight links go.
    const loose = row(RINGS_PER_SCREEN - 1, 300, "l", 2000);
    const index = buildClusterIndex([...tight, ...loose]);
    const [cluster, ...rest] = clustersOf(index, linksHeldFor(index, 0.3, view));
    expect(rest).toEqual([]);
    expect(cluster!.members).toEqual(["t-0", "t-1", "t-2"]);
  });

  it("never gathers a seat that needs the operator, even over budget", () => {
    const seats = grid(10, 10, 400);
    const apart = new Set(seats.slice(0, 20).map((seat) => seat.id));
    const index = buildClusterIndex(seats, apart);
    const gathered = clustersOf(index, linksHeldFor(index, 0.3, view)).flatMap((cluster) => cluster.members);
    for (const id of apart) expect(gathered).not.toContain(id);
  });

  it("gathers by spacing where that holds more than the budget", () => {
    const index = buildClusterIndex(row(6, 150));
    expect(linksHeldFor(index, 0.15, view)).toBe(linksHeldAt(index, 0.15));
  });
});
