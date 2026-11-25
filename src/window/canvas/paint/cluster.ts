/**
 * Seat clusters at far and overview (inventory 3, "Seat clusters"): seats too
 * close to draw as rings gather into one badge, a portrait in a turning ring on
 * a stack of rings, with a count. The grouping is `seat-clusters.ts`, fed seat
 * facts instead of the DOM; this file decides who gathers (`gatheredIds`, for
 * the engine to hide those seats) and paints the badges.
 *
 * A badge has no card: its quads sit in absolute board units around the
 * cluster's centroid, keyed `cluster:<key>.<part>`, in the lifted band, and
 * ride the far seat scale about that centroid (`body` is
 * `scale(var(--far-seat-scale))`).
 */

import { SEAT_SCALE_MAX } from "@shared/canvas-tier";
import type { RingForm, RingState } from "@shared/wire/rings";
import { Level, levelOfRing, rankOf } from "@shared/wire/urgency";
import type { Point, PaintEnv, Quad, SeatLive, ScaleRule, TextRun } from "../contract";
import { MEASURE_WIDTH, TIER_BIT } from "../contract";
import {
  buildClusterIndex,
  clustersOf,
  linksHeldAt,
  type ClusterIndex,
  type ClusterSeat,
  type SeatCluster,
} from "../../lib/seat-clusters";
import { FAR, SEAT } from "./card-spec";
import { portraitPlaceholder, portraitSprite } from "./images";
import { ringQuads } from "./motion";
import { at, grow, shadow, shape, sprite, text, tok } from "./refs";
import type { ThemeMode } from "@shared/theme";

/** A seat as the clusters see it: its ring centre in board units, its region, and what it shows. */
export type ClusterSeatFact = {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  /** The innermost region it sits in; "" for none. */
  readonly region: string;
  readonly ring: RingState;
  readonly ringSince: number;
  readonly selected: boolean;
  readonly portrait?: SeatLive["portrait"];
};

export type ClusterInput = {
  readonly seats: ReadonlyArray<ClusterSeatFact>;
  readonly zoom: number;
  /** The canvas element's size in CSS pixels. */
  readonly view: { readonly width: number; readonly height: number };
  readonly mode: ThemeMode;
  /** The cluster the pointer is in: it rides above the rest. */
  readonly hoveredKey?: string;
};

export type ClusterPlan = {
  readonly clusters: ReadonlyArray<SeatCluster>;
  readonly gathered: ReadonlySet<string>;
};

/**
 * What the scene holds across frames. At far and overview every innermost
 * region with seats is one cluster at every zoom, a seat alone in its region
 * a cluster of one; nothing keeps a seat apart, so the seats that need the
 * operator are gathered too and their urgency rides the badge. Seats in no
 * region gather only where they overlap, by the overlap span, with no ring
 * budget.
 */
export type ClusterGrouping = {
  readonly regions: ReadonlyArray<SeatCluster>;
  /** The seats in no region: the minimum spanning tree the overlap span counts links of. */
  readonly overlap: ClusterIndex;
};

/** A region's cluster: keyed by the region, so it keeps its key while seats come and go. */
const regionCluster = (region: string, seats: ReadonlyArray<ClusterSeatFact>): SeatCluster => {
  const members = seats.map((s) => s.id).sort();
  let x = 0;
  let y = 0;
  for (const s of seats) {
    x += s.x;
    y += s.y;
  }
  // A region's cluster never parts by zoom: it stands for its seats at every far zoom.
  return { key: `region:${region}`, members, x: x / seats.length, y: y / seats.length, partsAt: 0 };
};

/**
 * The grouping for these seats. The scene holds it across frames (a seat's
 * position or region changes it) and only asks for the overlap links this
 * zoom holds.
 */
export const clusterIndexOf = (seats: ReadonlyArray<ClusterSeatFact>): ClusterGrouping => {
  const byRegion = new Map<string, ClusterSeatFact[]>();
  const free: ClusterSeat[] = [];
  for (const s of seats) {
    if (s.region === "") {
      free.push({ id: s.id, x: s.x, y: s.y, region: "" });
      continue;
    }
    const list = byRegion.get(s.region);
    if (list === undefined) byRegion.set(s.region, [s]);
    else list.push(s);
  }
  const regions = [...byRegion].map(([region, members]) => regionCluster(region, members)).sort((a, b) => (a.key < b.key ? -1 : 1));
  return { regions, overlap: buildClusterIndex(free) };
};

/** How many overlap links this zoom holds. */
export const clusterHeldAt = (grouping: ClusterGrouping, zoom: number): number => linksHeldAt(grouping.overlap, zoom);

/** The clusters the shortest `held` overlap links form, with every region's, and the seats they gather. */
export const clustersFor = (grouping: ClusterGrouping, held: number): ClusterPlan => {
  const clusters = [...grouping.regions, ...clustersOf(grouping.overlap, held)].sort((a, b) => (a.key < b.key ? -1 : 1));
  return { clusters, gathered: new Set(clusters.flatMap((c) => c.members)) };
};

/** The clusters at this zoom: one planning step for a caller with no cache. */
export const clustersAt = (grouping: ClusterGrouping, zoom: number): ClusterPlan => clustersFor(grouping, clusterHeldAt(grouping, zoom));

export const planClusters = (input: ClusterInput): ClusterPlan => clustersAt(clusterIndexOf(input.seats), input.zoom);

/** The seats a cluster badge stands for: the engine hides their own paint. */
export const gatheredIds = (input: ClusterInput): ReadonlySet<string> => planClusters(input).gathered;

/**
 * The seat a badge shows: its most urgent member by the one urgency ladder;
 * a tie goes to the latest ring change, then the smallest id. The badge's
 * ring, portrait and rim are this seat's.
 */
export const leadOf = (members: ReadonlyArray<ClusterSeatFact>): ClusterSeatFact | undefined => {
  let lead: ClusterSeatFact | undefined;
  for (const seat of members) {
    if (lead === undefined) {
      lead = seat;
      continue;
    }
    const rank = rankOf(levelOfRing(seat.ring.ring)) - rankOf(levelOfRing(lead.ring.ring));
    if (rank > 0 || (rank === 0 && (seat.ringSince > lead.ringSince || (seat.ringSince === lead.ringSince && seat.id < lead.id)))) lead = seat;
  }
  return lead;
};

/** The rim's alpha: quieter for a lead at rest or offline. */
const rimAlphaOf = (form: RingForm): number => {
  const level = levelOfRing(form);
  return level === Level.resting || level === Level.offline ? 0.7 : 0.85;
};

/** The front ring's disc: a 52 unit seat ring is 40 across (`junto-seat-cluster__stack`). */
export const CLUSTER = { disc: 40, count: { minWidth: 20, height: 20, padX: 5, right: 9, bottom: 7, size: 12, weight: 700 } } as const;

const FAR_UP = TIER_BIT.far | TIER_BIT.overview;

/**
 * One badge's quads, in absolute board units around the cluster's centroid.
 * The scene places them under a cluster owner at that centroid, so its
 * records are relative to the badge's disc and an owner move never
 * repaints them.
 */
export const paintClusterBadge = (cluster: SeatCluster, byId: ReadonlyMap<string, ClusterSeatFact>, input: ClusterInput, env: PaintEnv): ReadonlyArray<Quad> => {
  const members = cluster.members.map((id) => byId.get(id)).filter((s): s is ClusterSeatFact => s !== undefined);
  const lead = leadOf(members);
  const centre: Point = { x: cluster.x, y: cluster.y };
  const scale: ScaleRule = { kind: "seat", cap: SEAT_SCALE_MAX, anchor: centre };
  const p = `cluster:${cluster.key}.`;
  const base = { band: "lifted" as const, tiers: FAR_UP, scale };
  const hovered = input.hoveredKey === cluster.key ? 1 : 0;
  const z = 100 + hovered;
  const disc = at(centre.x - CLUSTER.disc / 2, centre.y - CLUSTER.disc / 2, CLUSTER.disc, CLUSTER.disc);
  const ring = at(centre.x - SEAT.ring / 2, centre.y - SEAT.ring / 2, SEAT.ring, SEAT.ring);
  // The ring, the portrait and the rim are the lead's: the badge bubbles up
  // the highest urgency among its seats.
  const state: RingState = lead?.ring ?? { ring: "rest", hue: "steel", stale: false };
  const since = lead?.ringSince ?? 0;
  const rings = ringQuads(state, since, ring, scale, `${p}ring`, z + 2);
  const portrait = lead?.portrait ?? { seed: lead?.id ?? cluster.key };
  const rim = tok(state.hue, rimAlphaOf(state.ring));
  const count = String(members.length);
  const run: TextRun = {
    text: count,
    font: "mono",
    size: CLUSTER.count.size,
    weight: CLUSTER.count.weight,
    leading: 20 / CLUSTER.count.size,
    tabular: true,
    align: "center",
    truncate: "none",
    width: MEASURE_WIDTH,
  };
  const textW = env.measure(run);
  const w = Math.max(CLUSTER.count.minWidth, textW + CLUSTER.count.padX * 2);
  const h = CLUSTER.count.height;
  const badge = at(disc.x + disc.width + CLUSTER.count.right - w, disc.y + disc.height + CLUSTER.count.bottom - h, w, h);
  const out: Quad[] = [];
  // A stack shadow says there are more behind the front ring: not for one seat.
  if (members.length >= 2) out.push(shadow({ key: `${p}stack`, z, rect: disc }, { shadow: { name: "cluster", tint: rim } }, { ...base, shape: "disc" }));
  out.push(
    shape(
      { key: `${p}disc`, z: z + 1, rect: disc },
      { fill: { kind: "flat", color: tok("raise") } },
      { ...base, shape: "disc", part: { kind: "cluster", memberIds: cluster.members, key: cluster.key } },
    ),
    ...rings.under.map((q) => ({ ...q, band: "lifted" as const, tiers: FAR_UP })),
    sprite(
      { key: `${p}portrait`, z: z + 2, rect: at(centre.x - SEAT.portrait / 2, centre.y - SEAT.portrait / 2, SEAT.portrait, SEAT.portrait) },
      { ...base, shape: "disc", sprite: portraitSprite(portrait.seed, input.mode, SEAT.portrait, portrait.expression, portrait.config), placeholder: portraitPlaceholder(portrait.seed, input.mode, portrait.config) },
    ),
    ...rings.over.map((q) => ({ ...q, band: "lifted" as const, tiers: FAR_UP })),
  );
  // The halo a seat that waits on the operator wears at far, now on its badge.
  const form = state.ring;
  if (form === "call" || form === "wait" || form === "halt") {
    const hue = form === "halt" ? "crimson" : "amber";
    out.push(
      shape({ key: `${p}halo.outer`, z: z + 3, rect: ring }, { stroke: { color: tok(hue, FAR.halo.outerAlpha), width: FAR.halo.outer, outside: true } }, { ...base, shape: "disc" }),
      shape({ key: `${p}halo.inner`, z: z + 4, rect: ring }, { stroke: { color: tok(hue, FAR.halo.innerAlpha), width: FAR.halo.inner, outside: true } }, { ...base, shape: "disc" }),
    );
  }
  // Selection outranks hover, as on a seat: the outline shows when any member is selected.
  const anySelected = members.some((s) => s.selected);
  if (anySelected || hovered === 1) {
    const spec = anySelected ? FAR.selected : FAR.hover;
    const color = anySelected ? tok("main", spec.alpha) : tok("ink", spec.alpha);
    out.push(shape({ key: `${p}outline`, z: z + 5, rect: grow(ring, spec.offset) }, { stroke: { color, width: spec.width, outside: true } }, { ...base, shape: "disc" }));
  }
  out.push(
    shape({ key: `${p}count`, z: z + 6, rect: badge }, { fill: { kind: "flat", color: tok("ink") } }, { ...base, radii: CLUSTER.count.height / 2 }),
    text(
      { key: `${p}count.text`, z: z + 7, rect: at(badge.x, badge.y, w, h) },
      { ink: tok("ground") },
      { ...base, text: { ...run, width: w } },
    ),
  );
  return out;
};

/** Every badge of the board at this zoom. */
export const paintClusters = (input: ClusterInput, env: PaintEnv): ReadonlyArray<Quad> => {
  const plan = planClusters(input);
  const byId = new Map(input.seats.map((s) => [s.id, s] as const));
  return plan.clusters.flatMap((c) => paintClusterBadge(c, byId, input, env));
};
