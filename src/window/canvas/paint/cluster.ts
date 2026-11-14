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
import { ringKeepsApart } from "@shared/wire/urgency";
import type { Point, PaintEnv, Quad, SeatLive, ScaleRule, TextRun } from "../contract";
import { TIER_BIT } from "../contract";
import {
  buildClusterIndex,
  clusterBadgeMark,
  clustersOf,
  linksHeldFor,
  type ClusterIndex,
  type ClusterSeat,
  type SeatCluster,
} from "../../lib/seat-clusters";
import { SEAT } from "./card-spec";
import { portraitSprite } from "./images";
import { ringQuads } from "./motion";
import { at, shadow, shape, sprite, text, tok } from "./refs";
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
  /** The canvas element's size in CSS pixels (the ring budget counts screens of it). */
  readonly view: { readonly width: number; readonly height: number };
  readonly mode: ThemeMode;
  /** The cluster the pointer is in: it rides above the rest. */
  readonly hoveredKey?: string;
};

/** Seats that are never gathered: selected, or a ring that waits on the operator (call, wait, halt). */
export const keepsApart = (seat: ClusterSeatFact): boolean => seat.selected || ringKeepsApart(seat.ring.ring);

export type ClusterPlan = {
  readonly clusters: ReadonlyArray<SeatCluster>;
  readonly gathered: ReadonlySet<string>;
};

/**
 * The grouping index for these seats: the minimum spanning tree of each
 * region, apart seats left out. The scene holds it across frames (a seat's
 * position, region, ring or selection changes it) and only asks for the
 * links this zoom holds.
 */
export const clusterIndexOf = (seats: ReadonlyArray<ClusterSeatFact>): ClusterIndex => {
  const facts: ClusterSeat[] = seats.map((s) => ({ id: s.id, x: s.x, y: s.y, region: s.region }));
  const apart = new Set(seats.filter(keepsApart).map((s) => s.id));
  return buildClusterIndex(facts, apart);
};

/** The clusters a held index forms at this zoom and viewport, and the seats they gather. */
export const clusterHeldAt = (index: ClusterIndex, zoom: number, view: { readonly width: number; readonly height: number }): number =>
  linksHeldFor(index, zoom, view);

/** The clusters the shortest `held` links form, and the seats they gather. */
export const clustersFor = (index: ClusterIndex, held: number): ClusterPlan => {
  const clusters = clustersOf(index, held);
  return { clusters, gathered: new Set(clusters.flatMap((c) => c.members)) };
};

/** The clusters at this zoom and viewport: one planning step for a caller with no cache. */
export const clustersAt = (index: ClusterIndex, zoom: number, view: { readonly width: number; readonly height: number }): ClusterPlan =>
  clustersFor(index, clusterHeldAt(index, zoom, view));

export const planClusters = (input: ClusterInput): ClusterPlan =>
  clustersAt(clusterIndexOf(input.seats), input.zoom, input.view);

/** The seats a cluster badge stands for: the engine hides their own paint. */
export const gatheredIds = (input: ClusterInput): ReadonlySet<string> => planClusters(input).gathered;

/** The badge's rim and ring tone, by its busiest member (`clusterBadgeMark`). */
const BADGE = {
  work: { rim: tok("cyan", 0.85), ring: { ring: "work", hue: "cyan" } },
  done: { rim: tok("green", 0.85), ring: { ring: "done", hue: "green" } },
  rest: { rim: tok("steel", 0.7), ring: { ring: "rest", hue: "steel" } },
} as const;

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
  const forms: RingForm[] = members.map((s) => s.ring.ring);
  const mark = clusterBadgeMark(forms);
  const style = BADGE[mark];
  const centre: Point = { x: cluster.x, y: cluster.y };
  const scale: ScaleRule = { kind: "seat", cap: SEAT_SCALE_MAX, anchor: centre };
  const p = `cluster:${cluster.key}.`;
  const base = { band: "lifted" as const, tiers: FAR_UP, scale };
  const hovered = input.hoveredKey === cluster.key ? 1 : 0;
  const z = 100 + hovered;
  const disc = at(centre.x - CLUSTER.disc / 2, centre.y - CLUSTER.disc / 2, CLUSTER.disc, CLUSTER.disc);
  const ring = at(centre.x - SEAT.ring / 2, centre.y - SEAT.ring / 2, SEAT.ring, SEAT.ring);
  const state: RingState = { ring: style.ring.ring, hue: style.ring.hue, stale: false };
  const since = members.reduce((latest, s) => Math.max(latest, s.ringSince), 0);
  const rings = ringQuads(state, since, ring, scale, `${p}ring`, z + 2);
  const first = members[0];
  const portrait = first?.portrait ?? { seed: first?.id ?? cluster.key };
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
    width: 4096,
  };
  const textW = env.measure(run);
  const w = Math.max(CLUSTER.count.minWidth, textW + CLUSTER.count.padX * 2);
  const h = CLUSTER.count.height;
  const badge = at(disc.x + disc.width + CLUSTER.count.right - w, disc.y + disc.height + CLUSTER.count.bottom - h, w, h);
  const out: Quad[] = [
    shadow({ key: `${p}stack`, z, rect: disc }, { shadow: { name: "cluster", tint: style.rim } }, { ...base, shape: "disc" }),
    shape(
      { key: `${p}disc`, z: z + 1, rect: disc },
      { fill: { kind: "flat", color: tok("raise") } },
      { ...base, shape: "disc", part: { kind: "cluster", memberIds: cluster.members } },
    ),
    ...rings.under.map((q) => ({ ...q, band: "lifted" as const, tiers: FAR_UP })),
    sprite(
      { key: `${p}portrait`, z: z + 2, rect: at(centre.x - SEAT.portrait / 2, centre.y - SEAT.portrait / 2, SEAT.portrait, SEAT.portrait) },
      { ...base, shape: "disc", sprite: portraitSprite(portrait.seed, input.mode, SEAT.portrait, portrait.expression, portrait.config) },
    ),
    ...rings.over.map((q) => ({ ...q, band: "lifted" as const, tiers: FAR_UP })),
    shape({ key: `${p}count`, z: z + 6, rect: badge }, { fill: { kind: "flat", color: tok("ink") } }, { ...base, radii: CLUSTER.count.height / 2 }),
    text(
      { key: `${p}count.text`, z: z + 7, rect: at(badge.x, badge.y, w, h) },
      { ink: tok("ground") },
      { ...base, text: { ...run, width: w } },
    ),
  ];
  return out;
};

/** Every badge of the board at this zoom. */
export const paintClusters = (input: ClusterInput, env: PaintEnv): ReadonlyArray<Quad> => {
  const plan = planClusters(input);
  const byId = new Map(input.seats.map((s) => [s.id, s] as const));
  return plan.clusters.flatMap((c) => paintClusterBadge(c, byId, input, env));
};
