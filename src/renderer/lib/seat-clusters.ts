// Seat clusters at the overview tier.
//
// Pulled all the way back, a seat is still its portrait in its ring, held at
// a screen size (canvas-tier.ts). Where seats sit closer than a ring at the
// floor size, they cannot all be drawn: those seats gather into one stacked
// badge with a count, which parts again as the camera comes in. Seats that
// need the operator and seats the operator selected are never gathered.
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

/** Flow distance under which two seats gather at this zoom. */
export const clusterSpan = (zoom: number): number =>
  zoom > 0 && Number.isFinite(zoom) ? (SEAT_FLOOR_SCREEN_PX + CLUSTER_GAP_PX) / zoom : 0;

type Link = { readonly a: string; readonly b: string; readonly d: number };

export type ClusterIndex = {
  readonly seats: ReadonlyMap<string, ClusterSeat>;
  /** Spanning-tree links of every region, shortest first. */
  readonly links: ReadonlyArray<Link>;
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
  const links: Link[] = [];
  for (const members of byRegion.values()) {
    const pairs: Link[] = [];
    for (let i = 0; i < members.length; i += 1) {
      for (let j = i + 1; j < members.length; j += 1) {
        const a = members[i]!;
        const b = members[j]!;
        pairs.push({ a: a.id, b: b.id, d: Math.hypot(a.x - b.x, a.y - b.y) });
      }
    }
    pairs.sort((p, q) => p.d - q.d);
    const parent = new Map(members.map((seat) => [seat.id, seat.id] as const));
    for (const pair of pairs) {
      const ra = find(parent, pair.a);
      const rb = find(parent, pair.b);
      if (ra === rb) continue;
      parent.set(ra, rb);
      links.push(pair);
    }
  }
  links.sort((p, q) => p.d - q.d);
  return { seats: kept, links };
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
