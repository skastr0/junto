/**
 * Wire pulse: a message typed into a seat lights the wire it crossed.
 *
 * Main sends one `WireTrafficEvent` per delivered message. This module maps
 * the event onto the one canvas edge joining sender and receiver, decides
 * whether it is worth painting (on screen, under the burst cap), and holds
 * the per-edge pulse the edge component renders. Nothing here runs at idle:
 * every write is caused by an event, and every pulse ends on its own.
 *
 * Pure: the keyed observable the edges subscribe to is wire-pulse-state.ts.
 */

import type { WireTrafficEvent, WireTrafficKind } from "@shared/wire-traffic";

/** One travel of light from sender to receiver. */
export const WIRE_PULSE_MS = 900;
/** Pulses painting at once across the canvas; a burst beyond it is dropped. */
export const WIRE_PULSE_MAX_ACTIVE = 24;
/** An edge whose animation never reported its end frees itself after this. */
const STALE_AFTER_MS = WIRE_PULSE_MS + 400;

/**
 * Interaction kind to its theme token: the pulse's only colour. Chosen off
 * the cold blue of the messages wire it usually runs on: violet mail (the
 * preamble's mail colour), amber prompts, green answers.
 */
export const WIRE_PULSE_TOKEN: Record<WireTrafficKind, string> = {
  notice: "--color-violet",
  prompt: "--color-amber-hi",
  answer: "--color-green",
};

/** The edge fields the mapping reads (a FlowEdge satisfies it). */
export type PulseEdge = {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly data?: { readonly verb?: string };
};

export type PulseTarget = {
  readonly edgeId: string;
  /** True when the light runs target to source on the drawn edge. */
  readonly reverse: boolean;
};

/** Verbs that carry seat-to-seat traffic, best first. */
const VERB_RANK: Record<string, number> = { messages: 0 };

/**
 * The wire a message crossed: an edge joining sender and receiver, in either
 * drawn direction, preferring the verbs that carry mail. No sender (operator
 * or system mail) or no joining edge means no wire to light.
 */
export const pickPulseEdge = (
  edges: ReadonlyArray<PulseEdge>,
  event: Pick<WireTrafficEvent, "fromNodeId" | "toNodeId">,
): PulseTarget | undefined => {
  const from = event.fromNodeId;
  if (from === undefined || from === event.toNodeId) return undefined;
  let best: { edge: PulseEdge; rank: number } | undefined;
  for (const edge of edges) {
    const joins =
      (edge.source === from && edge.target === event.toNodeId) ||
      (edge.source === event.toNodeId && edge.target === from);
    if (!joins) continue;
    const rank = VERB_RANK[edge.data?.verb ?? ""] ?? 2;
    if (best === undefined || rank < best.rank) best = { edge, rank };
  }
  if (best === undefined) return undefined;
  return { edgeId: best.edge.id, reverse: best.edge.source !== from };
};

export type PulseRect = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

/**
 * Whether a wire between two node boxes can be on screen: the box spanning
 * both ends meets the viewport (all in flow coordinates).
 */
export const pulseOnScreen = (
  a: PulseRect,
  b: PulseRect,
  viewport: PulseRect,
): boolean => {
  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return (
    right >= viewport.x &&
    bottom >= viewport.y &&
    left <= viewport.x + viewport.width &&
    top <= viewport.y + viewport.height
  );
};

// --- geometry: the dash as straight runs, for the compositor -----------------

/** The dash's weight, canvas units: its round caps are half this past each end. */
export const WIRE_PULSE_WIDTH = 3.2;
/** The dash's length as a share of the wire's: one short dash runs the wire. */
export const WIRE_PULSE_DASH = 0.16;

/**
 * One straight leg of a wire, corner to corner. `at` is where the leg's
 * origin sits along the wire as drawn, so a point a distance `s` along the
 * wire lies `s - at` along the leg on its straight part.
 */
export type PulseLeg = {
  readonly x: number;
  readonly y: number;
  readonly length: number;
  /** Heading in degrees, 0 pointing along +x. */
  readonly angle: number;
  readonly at: number;
};

export type PulsePlan = {
  /** The wire's length as drawn, rounded corners included. */
  readonly length: number;
  readonly legs: ReadonlyArray<PulseLeg>;
};

const PULSE_NUMBER = /-?\d*\.?\d+(?:e[-+]?\d+)?/gi;
const PULSE_QUAD_STEPS = 16;

const quadLength = (
  from: { x: number; y: number },
  c: { x: number; y: number },
  to: { x: number; y: number },
): number => {
  let length = 0;
  let prev = from;
  for (let s = 1; s <= PULSE_QUAD_STEPS; s += 1) {
    const t = s / PULSE_QUAD_STEPS;
    const u = 1 - t;
    const next = { x: u * u * from.x + 2 * u * t * c.x + t * t * to.x, y: u * u * from.y + 2 * u * t * c.y + t * t * to.y };
    length += Math.hypot(next.x - prev.x, next.y - prev.y);
    prev = next;
  }
  return length;
};

/**
 * A wire path (M, L and Q only: every canvas wire is an orthogonal run with
 * rounded corners) as its straight legs, each running to the sharp corner
 * its rounded one cuts. A leg that meets another at a corner reaches half
 * the dash's weight past it, so the two halves of a dash crossing the
 * corner join without a notch. Along every straight part a leg places the
 * dash exactly where the drawn wire's own dash would be.
 */
export const pulsePlan = (d: string): PulsePlan => {
  const legs: PulseLeg[] = [];
  let walked = 0;
  let cur: { x: number; y: number } | undefined;
  // The open leg: its origin, where that origin sits along the wire, its heading.
  let origin = { x: 0, y: 0 };
  let originAt = 0;
  let heading: { ux: number; uy: number } | undefined;
  let cornerBefore = false;

  const close = (end: { x: number; y: number }, cornerAfter: boolean): void => {
    if (heading === undefined) return;
    const length = (end.x - origin.x) * heading.ux + (end.y - origin.y) * heading.uy;
    if (length <= 0) return;
    const before = cornerBefore ? WIRE_PULSE_WIDTH / 2 : 0;
    const after = cornerAfter ? WIRE_PULSE_WIDTH / 2 : 0;
    legs.push({
      x: origin.x - heading.ux * before,
      y: origin.y - heading.uy * before,
      length: length + before + after,
      angle: (Math.atan2(heading.uy, heading.ux) * 180) / Math.PI,
      at: originAt - before,
    });
  };
  const open = (at: { x: number; y: number }, alongWire: number, corner: boolean): void => {
    origin = at;
    originAt = alongWire;
    heading = undefined;
    cornerBefore = corner;
  };
  const headTo = (to: { x: number; y: number }): boolean => {
    const dx = to.x - origin.x;
    const dy = to.y - origin.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) return true;
    if (heading === undefined) {
      heading = { ux: dx / len, uy: dy / len };
      return true;
    }
    return Math.abs(heading.ux * dy - heading.uy * dx) / len < 1e-3 && heading.ux * dx + heading.uy * dy > 0;
  };

  for (const [, command, args] of d.matchAll(/([MLQ])([^MLQ]*)/g)) {
    const n = (args!.match(PULSE_NUMBER) ?? []).map(Number);
    if (command === "M") {
      if (n.length < 2) continue;
      if (cur !== undefined) close(cur, false);
      cur = { x: n[0]!, y: n[1]! };
      open(cur, walked, false);
      for (let i = 2; i + 1 < n.length; i += 2) {
        const to = { x: n[i]!, y: n[i + 1]! };
        if (!headTo(to)) {
          close(cur, true);
          open(cur, walked, true);
          headTo(to);
        }
        walked += Math.hypot(to.x - cur.x, to.y - cur.y);
        cur = to;
      }
    } else if (command === "L") {
      for (let i = 0; i + 1 < n.length && cur !== undefined; i += 2) {
        const to = { x: n[i]!, y: n[i + 1]! };
        // A turn with no rounding: the corner is sharp where the two meet.
        if (!headTo(to)) {
          close(cur, true);
          open(cur, walked, true);
          headTo(to);
        }
        walked += Math.hypot(to.x - cur.x, to.y - cur.y);
        cur = to;
      }
    } else {
      for (let i = 0; i + 3 < n.length && cur !== undefined; i += 4) {
        const c = { x: n[i]!, y: n[i + 1]! };
        const to = { x: n[i + 2]!, y: n[i + 3]! };
        const curve = quadLength(cur, c, to);
        // The leg so far runs on to the sharp corner the curve rounds.
        if (!headTo(c)) {
          close(cur, true);
          open(cur, walked, true);
          headTo(c);
        }
        close(c, true);
        // The next leg starts at that corner: `to` is the curve's end along the wire.
        const out = Math.hypot(to.x - c.x, to.y - c.y);
        open(c, walked + curve - out, true);
        headTo(to);
        walked += curve;
        cur = to;
      }
    }
  }
  if (cur !== undefined) close(cur, false);
  return { length: walked, legs };
};

/**
 * Where a leg's mover starts and how far it travels, canvas units along the
 * leg. The mover is one travel wide, the dash (caps included) at its left
 * edge, so translating it 100% (or -100% in reverse) carries the dash from
 * just before the wire's start to just past its end, as the drawn dash's
 * offset ran from 0.16 to -1 of the wire.
 */
export const pulseMover = (
  plan: PulsePlan,
  leg: PulseLeg,
  reverse: boolean,
): { readonly left: number; readonly travel: number; readonly dash: number } => {
  const dash = WIRE_PULSE_DASH * plan.length;
  const start = reverse ? plan.length : -dash;
  return { left: start - leg.at - WIRE_PULSE_WIDTH / 2, travel: plan.length + dash, dash: dash + WIRE_PULSE_WIDTH };
};

/** The pulse an edge paints now; `seq` restarts the animation. */
export type WirePulse = {
  readonly seq: number;
  readonly reverse: boolean;
  readonly kind: WireTrafficKind;
};

type ActivePulse = WirePulse & {
  readonly endsAt: number;
  /** One follow-up owed by traffic that arrived mid-flight. */
  next?: { readonly reverse: boolean; readonly kind: WireTrafficKind };
};

export type PulseSink = (edgeId: string, pulse: WirePulse | undefined) => void;

/**
 * Burst coalescing. An edge carries one pulse at a time; traffic landing
 * while it runs owes at most one follow-up, however many messages arrived.
 * Across the canvas at most `WIRE_PULSE_MAX_ACTIVE` pulses run; more are
 * dropped rather than queued, since a late pulse describes nothing.
 */
export class WirePulseScheduler {
  private readonly active = new Map<string, ActivePulse>();
  private seq = 0;

  constructor(
    private readonly sink: PulseSink,
    private readonly now: () => number = () => Date.now(),
  ) {}

  fire(target: PulseTarget, kind: WireTrafficKind): "started" | "coalesced" | "dropped" {
    const now = this.now();
    this.prune(now);
    const running = this.active.get(target.edgeId);
    if (running !== undefined) {
      running.next = { reverse: target.reverse, kind };
      return "coalesced";
    }
    if (this.active.size >= WIRE_PULSE_MAX_ACTIVE) return "dropped";
    this.start(target.edgeId, target.reverse, kind, now);
    return "started";
  }

  /** The edge finished painting pulse `seq`. */
  end(edgeId: string, seq: number): void {
    const running = this.active.get(edgeId);
    if (running === undefined || running.seq !== seq) return;
    this.active.delete(edgeId);
    if (running.next !== undefined) {
      this.start(edgeId, running.next.reverse, running.next.kind, this.now());
      return;
    }
    this.sink(edgeId, undefined);
  }

  activeCount(): number {
    return this.active.size;
  }

  clear(): void {
    for (const edgeId of this.active.keys()) this.sink(edgeId, undefined);
    this.active.clear();
  }

  private start(edgeId: string, reverse: boolean, kind: WireTrafficKind, now: number): void {
    this.seq += 1;
    const pulse: WirePulse = { seq: this.seq, reverse, kind };
    this.active.set(edgeId, { ...pulse, endsAt: now + STALE_AFTER_MS });
    this.sink(edgeId, pulse);
  }

  /** Free edges whose end never came (unmounted, filtered, window hidden). */
  private prune(now: number): void {
    for (const [edgeId, running] of this.active) {
      if (running.endsAt > now) continue;
      this.active.delete(edgeId);
      this.sink(edgeId, undefined);
    }
  }
}
