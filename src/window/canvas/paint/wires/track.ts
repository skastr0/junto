/**
 * Flow track geometry: the straight runs a flows or derives wire lays its
 * marks on, and the strip that carries them. The runs are today's
 * (`trackRuns` over the path the DOM draws, FlowTrack.tsx:52-55): one per
 * straight stretch at least a period long, corners bare, a lane jog under
 * half a mark's height ridden through. Room beside each run is today's too
 * (`trackClearances` over every track on the board, `trackFit`).
 *
 * A run is one rectangle along its heading, `trackHeight(fit)` tall, laid as
 * a four-vertex strip in strip.ts's stride: `along` is the distance along the
 * wire (the run's `at` plus the way into it), `across` the signed distance
 * from the run's line, `slot` the wire's record. Floats 2 and 3, the extrude
 * vector on a wire strip, hold `(fit, 0)` here: the size the run's marks are
 * drawn at (a track is never thinner than a pixel, so it needs no widening).
 * The shader draws the mark (an open chevron for flows, a filled arrowhead for
 * derives, flow-track.ts trackTile) at every centre `motion.ts trackPhase`
 * names, in mark units `(along - centre, across) / fit`.
 *
 * Pure. No DOM.
 */

import type { TaskPathVerb } from "@shared/physics";
import { TRACK_SCALE, trackClearances, trackFit, trackHeight, trackRuns, trackTile, type TrackRun } from "@window/lib/flow-track";
import type { CanvasTier } from "../../contract";
import { routePath, type WireRoute } from "./route";
import { joinStrips, STRIP_FLOATS, type WireStrip } from "./strip";
import { trackPeriod } from "./motion";

/** A wire's track runs at a tier. */
export const trackLayout = (route: WireRoute, tier: CanvasTier): TrackRun[] => {
  const scale = TRACK_SCALE[tier];
  return trackRuns(routePath(route), trackPeriod(tier), trackHeight(scale) / 2);
};

/** Each run's fit, for every track on the board at once: they shrink where another lies alongside. */
export const trackFits = (
  layouts: Readonly<Record<string, ReadonlyArray<TrackRun>>>,
  tier: CanvasTier,
): Record<string, number[]> => {
  const scale = TRACK_SCALE[tier];
  const room = trackClearances(layouts);
  const out: Record<string, number[]> = {};
  for (const [id, runs] of Object.entries(layouts)) out[id] = runs.map((_, index) => trackFit(scale, room[id]?.[index]));
  return out;
};

/** One run as a rectangle strip. */
const runStrip = (run: TrackRun, fit: number, slot: number): { vertices: Float32Array; count: number } => {
  const half = trackHeight(fit) / 2;
  const rad = (run.angle * Math.PI) / 180;
  const ux = Math.cos(rad);
  const uy = Math.sin(rad);
  const nx = -uy;
  const ny = ux;
  const vertices = new Float32Array(4 * STRIP_FLOATS);
  const ends = [
    { x: run.x, y: run.y, at: run.at },
    { x: run.x + ux * run.length, y: run.y + uy * run.length, at: run.at + run.length },
  ];
  let o = 0;
  for (const end of ends) {
    for (const sign of [1, -1]) {
      vertices[o++] = end.x + nx * half * sign;
      vertices[o++] = end.y + ny * half * sign;
      vertices[o++] = fit;
      vertices[o++] = 0;
      vertices[o++] = end.at;
      vertices[o++] = half * sign;
      vertices[o++] = slot;
    }
  }
  return { vertices, count: 4 };
};

export type TrackStrip = WireStrip & {
  /** Per run, the fit its marks are drawn at (the shader sizes the mark by it). */
  readonly fits: ReadonlyArray<number>;
};

/** A wire's track as one strip: its runs joined. Fits default to the tier's scale with nothing alongside. */
export const buildTrackStrip = (
  runs: ReadonlyArray<TrackRun>,
  tier: CanvasTier,
  options: { readonly fits?: ReadonlyArray<number>; readonly slot?: number } = {},
): TrackStrip => {
  const scale = TRACK_SCALE[tier];
  const fits = runs.map((_, index) => options.fits?.[index] ?? trackFit(scale));
  const parts = runs.map((run, index) => runStrip(run, fits[index]!, options.slot ?? 0));
  const vertices = joinStrips(parts);
  const tallest = fits.reduce((max, fit) => Math.max(max, trackHeight(fit) / 2), 0);
  const last = runs[runs.length - 1];
  return {
    vertices,
    count: vertices.length / STRIP_FLOATS,
    length: last ? last.at + last.length : 0,
    halfWidth: tallest,
    folded: false,
    fits,
  };
};

/**
 * One period of a track's mark as SVG, white on clear, exactly the tile the
 * DOM masks with today (flow-track.ts trackTile): a period at the tier's
 * scale wide, `trackHeight(fit)` tall, the mark centred. Rasterized once per
 * verb, scale and fit (FlowTrack.tsx keys its cache the same way, fit to
 * three places), it is the track's art; the shader tints it with the verb's
 * colour and reads it at `((along - offset + period / 2) mod period, across + height / 2)`.
 */
export const trackTileSvg = (tier: CanvasTier, fit: number, verb: TaskPathVerb): string => {
  const css = trackTile(TRACK_SCALE[tier], Number(fit.toFixed(3)), verb);
  const prefix = 'url("data:image/svg+xml,';
  return decodeURIComponent(css.slice(prefix.length, -2));
};
