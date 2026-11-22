import type { RingForm } from "@shared/wire/rings";
import { Level, levelOfRing, worstOf } from "@shared/wire/urgency";

// Seat clusters at the far and overview tiers.
//
// Pulled back, a seat is still its portrait in its turning ring, held at a
// screen size (canvas-tier.ts). Two things gather seats into one stacked
// badge with a count and a turning ring of its own, which parts again as the
// camera comes in. Where seats sit closer than a ring at the floor size,
// they cannot all be drawn. And a screenful of the board draws at most
// RINGS_PER_SCREEN rings: every turning ring is a compositor layer the pan
// pays for each frame, and from this far a hundred of them read as noise,
// so past the budget the closest seats gather first. Seats that need the
// operator and seats the operator selected are never gathered.
//
// Single linkage per region: two seats of the same innermost region share a
// cluster when a chain of seats joins them, each link closer on screen than
// the floor ring plus a gap. The links are the region's minimum spanning
// tree, built once per board or state change; a zoom only counts how many
// links are short enough (a binary search), and regroups when that count
// changes.

/** A seat's ring centre in flow units, and the innermost region it sits in ("" for none). */
export type ClusterSeat = {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly region: string;
};

export type SeatCluster = {
  /** Stable while the membership is: the smallest member id. */
  readonly key: string;
  readonly members: ReadonlyArray<string>;
  /** Centroid in flow units. */
  readonly x: number;
  readonly y: number;
  /** The zoom at which this cluster parts completely. */
  readonly partsAt: number;
};

/** The smallest a ring is drawn at the overview, on screen. */
export const SEAT_FLOOR_SCREEN_PX = 22;
/** Screen gap two floor rings keep before they gather. */
export const CLUSTER_GAP_PX = 4;

/**
 * Rings a screenful of the zoomed-out board draws, clusters and seats alike:
 * canvas-tier-budget.spec.ts holds the board at far and overview under its
 * layer budget with this many turning.
 */
export const RINGS_PER_SCREEN = 12;

/** Flow distance under which two seats gather at this zoom. */
export const clusterSpan = (zoom: number): number =>
  zoom > 0 && Number.isFinite(zoom) ? (SEAT_FLOOR_SCREEN_PX + CLUSTER_GAP_PX) / zoom : 0;

type Link = { readonly a: string; readonly b: string; readonly d: number };

export type ClusterIndex = {
  readonly seats: ReadonlyMap<string, ClusterSeat>;
  /** Spanning-tree links of every region, shortest first. */
  readonly links: ReadonlyArray<Link>;
  /** Seats never gathered: each draws its own ring. */
  readonly apart: number;
  /** Width and height in flow units of the box round every seat. */
  readonly width: number;
  readonly height: number;
};

const find = (parent: Map<string, string>, id: string): string => {
  let root = id;
  while (parent.get(root) !== root) root = parent.get(root)!;
  let at = id;
  while (parent.get(at) !== root) {
    const next = parent.get(at)!;
    parent.set(at, root);
    at = next;
  }
  return root;
};

/**
 * One region's minimum spanning tree, shortest link first (issue 915): Kruskal
 * over the pairs a neighbour grid finds, a radius at a time. A round takes
 * the pairs at least `lo` and under `r` apart, which sit in neighbouring
 * cells of side `r`; every shorter pair was taken in an earlier round, so the
 * links are the ones every pair sorted at once would give. Ties break by the
 * pair's place in `members`, as a stable sort of all pairs did. The first
 * radius is the seats' mean spacing, and it doubles until one tree is left.
 */
const regionTree = (members: ReadonlyArray<ClusterSeat>): Link[] => {
  const count = members.length;
  if (count < 2) return [];
  const parent = new Int32Array(count);
  for (let i = 0; i < count; i += 1) parent[i] = i;
  const root = (i: number): number => {
    let at = i;
    while (parent[at] !== at) {
      parent[at] = parent[parent[at]!]!;
      at = parent[at]!;
    }
    return at;
  };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const seat of members) {
    minX = Math.min(minX, seat.x);
    minY = Math.min(minY, seat.y);
    maxX = Math.max(maxX, seat.x);
    maxY = Math.max(maxY, seat.y);
  }
  const width = maxX - minX;
  const height = maxY - minY;
  let r = Math.max(Math.sqrt((width * height) / count), Math.max(width, height) / count, Number.MIN_VALUE);
  let lo = 0;
  let trees = count;
  const out: Link[] = [];
  while (trees > 1) {
    // A cell index is at most `count` (r is at least the box side over the
    // seat count), so a row stride past it keys every cell as one number.
    const stride = count + 3;
    const cells = new Map<number, number[]>();
    const column = new Int32Array(count);
    const line = new Int32Array(count);
    for (let i = 0; i < count; i += 1) {
      column[i] = Math.floor((members[i]!.x - minX) / r) + 1;
      line[i] = Math.floor((members[i]!.y - minY) / r) + 1;
      const key = column[i]! * stride + line[i]!;
      const list = cells.get(key);
      if (list === undefined) cells.set(key, [i]);
      else list.push(i);
    }
    const pairs: Array<{ readonly i: number; readonly j: number; readonly d: number }> = [];
    for (let i = 0; i < count; i += 1) {
      const cx = column[i]!;
      const cy = line[i]!;
      const a = members[i]!;
      const ri = root(i);
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          const list = cells.get((cx + dx) * stride + cy + dy);
          if (list === undefined) continue;
          for (const j of list) {
            // A pair already in one tree can never be a link.
            if (j <= i || root(j) === ri) continue;
            const b = members[j]!;
            const d = Math.hypot(a.x - b.x, a.y - b.y);
            if (d >= lo && d < r) pairs.push({ i, j, d });
          }
        }
      }
    }
    pairs.sort((p, q) => p.d - q.d || p.i - q.i || p.j - q.j);
    for (const pair of pairs) {
      const ra = root(pair.i);
      const rb = root(pair.j);
      if (ra === rb) continue;
      parent[ra] = rb;
      trees -= 1;
      out.push({ a: members[pair.i]!.id, b: members[pair.j]!.id, d: pair.d });
    }
    lo = r;
    r *= 2;
  }
  return out;
};

/** Build the links for `seats`, leaving out any seat in `apart` (never gathered). */
export const buildClusterIndex = (
  seats: ReadonlyArray<ClusterSeat>,
  apart: ReadonlySet<string> = new Set(),
): ClusterIndex => {
  const byRegion = new Map<string, ClusterSeat[]>();
  const kept = new Map<string, ClusterSeat>();
  for (const seat of seats) {
    if (apart.has(seat.id)) continue;
    kept.set(seat.id, seat);
    const list = byRegion.get(seat.region) ?? [];
    list.push(seat);
    byRegion.set(seat.region, list);
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const seat of seats) {
    minX = Math.min(minX, seat.x);
    minY = Math.min(minY, seat.y);
    maxX = Math.max(maxX, seat.x);
    maxY = Math.max(maxY, seat.y);
  }
  const links: Link[] = [];
  for (const members of byRegion.values()) links.push(...regionTree(members));
  links.sort((p, q) => p.d - q.d);
  return {
    seats: kept,
    links,
    apart: seats.length - kept.size,
    width: seats.length > 0 ? maxX - minX : 0,
    height: seats.length > 0 ? maxY - minY : 0,
  };
};

/** How many links are short enough to hold at this zoom. */
export const linksHeldAt = (index: ClusterIndex, zoom: number): number => {
  const span = clusterSpan(zoom);
  let lo = 0;
  let hi = index.links.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (index.links[mid]!.d < span) lo = mid + 1;
    else hi = mid;
  }
  return lo;
};

/** How many screens of `view` (px) the board covers at this zoom, one at least. */
export const screensAt = (index: ClusterIndex, zoom: number, view: { readonly width: number; readonly height: number }): number => {
  if (!(zoom > 0) || view.width <= 0 || view.height <= 0) return 1;
  return Math.max(1, (index.width * zoom) / view.width) * Math.max(1, (index.height * zoom) / view.height);
};

/**
 * How many links to hold at this zoom: those short enough to gather (a floor
 * ring does not fit between), and then more, shortest first, until the board
 * draws no more than RINGS_PER_SCREEN rings a screen. Each held link joins two
 * groups, so the board draws its seats less the links held.
 */
export const linksHeldFor = (
  index: ClusterIndex,
  zoom: number,
  view: { readonly width: number; readonly height: number },
): number => {
  const budget = Math.floor(RINGS_PER_SCREEN * screensAt(index, zoom, view));
  const over = index.seats.size + index.apart - budget;
  return Math.max(linksHeldAt(index, zoom), Math.min(index.links.length, over));
};

/** The clusters formed by the shortest `held` links: groups of two or more seats. */
export const clustersOf = (index: ClusterIndex, held: number): SeatCluster[] => {
  const parent = new Map([...index.seats.keys()].map((id) => [id, id] as const));
  // A cluster parts completely once its shortest link breaks.
  const shortest = new Map<string, number>();
  for (let i = 0; i < held; i += 1) {
    const link = index.links[i]!;
    const ra = find(parent, link.a);
    const rb = find(parent, link.b);
    if (ra === rb) continue;
    parent.set(ra, rb);
    shortest.set(rb, Math.min(link.d, shortest.get(ra) ?? Infinity, shortest.get(rb) ?? Infinity));
  }
  const groups = new Map<string, string[]>();
  for (const id of index.seats.keys()) {
    const root = find(parent, id);
    const list = groups.get(root) ?? [];
    list.push(id);
    groups.set(root, list);
  }
  const clusters: SeatCluster[] = [];
  for (const [root, members] of groups) {
    if (members.length < 2) continue;
    members.sort();
    let x = 0;
    let y = 0;
    for (const id of members) {
      const seat = index.seats.get(id)!;
      x += seat.x;
      y += seat.y;
    }
    const d = shortest.get(root) ?? 0;
    clusters.push({
      key: members[0]!,
      members,
      x: x / members.length,
      y: y / members.length,
      partsAt: d > 0 ? (SEAT_FLOOR_SCREEN_PX + CLUSTER_GAP_PX) / d : 1,
    });
  }
  return clusters.sort((a, b) => (a.key < b.key ? -1 : 1));
};

/**
 * The mark a cluster badge draws: its most urgent member's, by the one
 * urgency ladder. Done (a turn nobody has read) first, then work in flight
 * (trouble bends a working ring, but it still works), else rest. Seats that
 * need the operator are never gathered, so they never reach a badge.
 */
export const clusterBadgeMark = (forms: ReadonlyArray<RingForm>): "done" | "work" | "rest" => {
  const level = worstOf(forms.map(levelOfRing));
  if (level === Level.done) return "done";
  return level === Level.working || level === Level.degraded ? "work" : "rest";
};
