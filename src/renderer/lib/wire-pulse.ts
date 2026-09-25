/**
 * Wire pulse: a message typed into a seat lights the wire it crossed.
 *
 * Main sends one `WireTrafficEvent` per delivered message. This module maps
 * the event onto the one canvas edge joining sender and receiver, decides
 * whether it is worth painting (on screen, under the burst cap), and holds
 * the per-edge pulse the edge component renders. Nothing here runs at idle:
 * every write is caused by an event, and every pulse ends on its own.
 *
 * Pure apart from the keyed observable the edges subscribe to.
 */

import { observable } from "@legendapp/state";
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
const VERB_RANK: Record<string, number> = { messages: 0, reviews: 1 };

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

/** Per-edge pulse, keyed so only the lit edge re-renders. */
export const wirePulses$ = observable<Record<string, WirePulse>>({});

export const wirePulseScheduler = new WirePulseScheduler((edgeId, pulse) => {
  if (pulse === undefined) wirePulses$[edgeId]!.delete();
  else wirePulses$[edgeId]!.set(pulse);
});
