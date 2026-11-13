/**
 * The default painter, until track C's `paint/` lands. It emits contract
 * `Quad`s for every card kind in the shapes section 6 lists, and it is the
 * only place the engine turns facts into drawing: replacing it with C's
 * painter changes no record, no band and no frame.
 *
 * The seat ring is a disc with a motion; the renderer draws a moving disc as a
 * ring with the ring's sweep, so a ring turns on every display frame while it
 * is visible. Shells are rounded rectangles in theme tokens. Text, portraits
 * and the real ring art arrive with C and B; the records and bands are ready
 * for them.
 */

import { AGENT_NODE_SIZE, renderedNodeSize } from "@shared/node-geometry";
import { RING_MOTION, type RingForm } from "@shared/wire/rings";
import type {
  CardFact,
  CardPaint,
  CardView,
  PaintEnv,
  Quad,
  QuadMotion,
  QuadStyle,
  SeatLive,
  TierMask,
} from "../contract";
import { ALL_TIERS, TIER_BIT } from "../contract";
import type { CardPainter } from "./scene";

const NEAR_MID: TierMask = TIER_BIT.near | TIER_BIT.mid;
/** Rings are drawn at every tier (section 11): far and overview hold them at screen size. */
const ALL: TierMask = ALL_TIERS;

const token = (name: string, alpha?: number) => ({ token: name, ...(alpha === undefined ? {} : { alpha }) });

const style = (fill: string, stroke?: string, width = 0, opacity = 1): QuadStyle => ({
  fill: { kind: "flat", color: token(fill) },
  ...(stroke === undefined ? {} : { stroke: { color: token(stroke), width } }),
  opacity,
});

const TONE: Readonly<Record<string, string>> = {
  amber: "amber",
  cyan: "cyan",
  green: "green",
  crimson: "crimson",
  steel: "steel",
};

/** The ring language's motion (RING_MOTION), in the contract's words. */
export const ringMotion = (ring: RingForm): QuadMotion | undefined => {
  if (ring === "rest" || ring === "off") return undefined;
  if (ring === "done") return { kind: "glint", periodMs: 2880 };
  const motion = RING_MOTION[ring as keyof typeof RING_MOTION];
  if (motion === undefined) return undefined;
  if (motion.spin !== undefined) {
    return {
      kind: "turn",
      periodMs: motion.spin.lapMs,
      ...(motion.spin.ccw === true ? { ccw: true } : {}),
      ...(motion.spin.fade === true ? { fade: true } : {}),
    };
  }
  if (motion.pulse !== undefined) {
    const kind = motion.pulse.kind === "send" ? "send" : motion.pulse.kind === "beat" ? "beat" : "breathe";
    return { kind, periodMs: motion.pulse.ms };
  }
  return undefined;
};

export const ringStyle = (live: SeatLive | undefined): QuadStyle => {
  const ring = live?.ring;
  const hue = TONE[ring?.hue ?? "steel"] ?? "steel";
  return {
    fill: { kind: "flat", color: token(hue, ring?.stale === true ? 0.55 : 1) },
    stroke: { color: token(hue), width: 0 },
    opacity: 0.92,
  };
};

/** A ring quad in the card's own units, held at screen size at far and overview. */
const ringQuad = (fact: CardFact, live: SeatLive | undefined, view: CardView): Quad | undefined => {
  if (fact.row.kind !== "agent") return undefined;
  const cap = fact.derived.ringCap ?? 1.75;
  const motion = ringMotion(live?.ring?.ring ?? "rest");
  const anchor = { x: 2 + 26, y: 2 + 26 };
  return {
    key: "ring",
    kind: "shape",
    band: "cards",
    z: 1,
    rect: { x: 2, y: 2, width: 52, height: 52 },
    tiers: ALL,
    scale: { kind: "seat", cap, anchor },
    style: ringStyle(live),
    shape: "disc",
    ...(motion === undefined ? {} : { motion }),
    part: { kind: "body" },
    ...(view.selected ? {} : {}),
  };
};

const shellStyle = (fact: CardFact, view: CardView): QuadStyle => {
  if (fact.row.kind === "region") return style("raise", "stroke", 1, 0.42);
  if (fact.derived.blocked) return style("raise-2", "crimson", 1.2);
  if (view.selected) return style("raise-2", "amber", 1.4);
  if (view.hovered) return style("raise-2", "stroke-hi", 1.2);
  return style("raise-2", "stroke", 1);
};

const shellQuad = (fact: CardFact, view: CardView): Quad => {
  const size = renderedNodeSize(fact.row.kind, fact.row);
  return {
    key: "shell",
    kind: "shape",
    band: fact.row.kind === "region" ? "regions" : view.dragging ? "lifted" : "cards",
    z: fact.derived.z,
    rect: { x: 0, y: 0, width: size.width, height: size.height },
    tiers: fact.row.kind === "region" ? ALL : NEAR_MID,
    scale: { kind: "board" },
    style: shellStyle(fact, view),
    shape: "rect",
    radii: fact.row.kind === "region" ? 12 : 6,
    part: fact.row.kind === "region" ? { kind: "regionTitle" } : { kind: "body" },
  };
};

const kindSeatRing = (fact: CardFact, view: CardView): Quad | undefined => {
  if (fact.row.kind === "agent" || fact.row.kind === "region") return undefined;
  const size = renderedNodeSize(fact.row.kind, fact.row);
  if (size.width !== AGENT_NODE_SIZE.width || size.height !== AGENT_NODE_SIZE.height) return undefined;
  return {
    key: "ring",
    kind: "shape",
    band: "cards",
    z: 1,
    rect: { x: 2, y: 2, width: 52, height: 52 },
    tiers: ALL,
    scale: { kind: "seat", cap: 1.75, anchor: { x: 28, y: 28 } },
    style: ringStyle(undefined),
    shape: "disc",
    part: { kind: "body" },
    ...(view.selected ? {} : {}),
  };
};

export const defaultPainter: CardPainter = (
  fact: CardFact,
  live: SeatLive | undefined,
  view: CardView,
  _env: PaintEnv,
): CardPaint => {
  const quads: Quad[] = [];
  const shell = shellQuad(fact, view);
  quads.push(shell);
  const ring = ringQuad(fact, live, view) ?? kindSeatRing(fact, view);
  if (ring !== undefined) quads.push(ring);
  return { quads, dim: { opacity: 1, saturate: 1 }, lift: view.hovered ? 1 : 0 };
};
