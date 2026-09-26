import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { VERB_COLOR_TOKEN } from "@shared/physics";
import type { WireTrafficKind } from "@shared/wire-traffic";
import type { ActivitySpec } from "../../lib/activity";
import { AGENT_NODE_SIZE } from "../../lib/node-geometry";
import type { SeatBubble } from "../../lib/preamble-feed";
import { WIRE_PULSE_MS, WIRE_PULSE_TOKEN } from "../../lib/wire-pulse";
import { AgentSeatView, type SeatHealth, type SeatSignal } from "../nodes/AgentSeat";
import { PreambleBubble } from "../nodes/PreambleBubble";
import "../edges/wire-pulse.css";

// Live demos for the tour. Every piece here is the real component the canvas
// draws, fed scripted props: nothing reads or writes the operator's
// canvases, the work plane or junto.db, and nothing here survives the tour.

/** A beat that counts up every `periodMs` while the demo is on screen. */
export const useTourBeat = (periodMs: number): number => {
  const [beat, setBeat] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setBeat((n) => n + 1), periodMs);
    return () => window.clearInterval(id);
  }, [periodMs]);
  return beat;
};

const NO_HEALTH: SeatHealth = {};
const NO_SIGNAL: SeatSignal = { openCount: 0 };

/** The stage: a patch of canvas the demos sit on, in the app's theme. */
export function TourStage({
  width,
  height,
  children,
  label,
}: {
  readonly width: number;
  readonly height: number;
  readonly children: ReactNode;
  /** What the demo shows, for assistive tech; the demo itself is decorative. */
  readonly label: string;
}) {
  return (
    <div className="tour-stage" role="img" aria-label={label}>
      <div className="tour-stage__field" style={{ width, height }}>
        {children}
      </div>
    </div>
  );
}

export type DemoSeatProps = {
  readonly id: string;
  readonly name: string;
  readonly harness: string;
  readonly spec: ActivitySpec;
  readonly x: number;
  readonly y: number;
  readonly health?: SeatHealth;
  readonly signal?: SeatSignal;
  readonly overseer?: boolean;
  readonly bubble?: SeatBubble;
  /** Wear the selection surface, as a selected seat does. */
  readonly selected?: boolean;
  /** A caption under the seat, naming what it shows. */
  readonly caption?: string;
};

/** A seat exactly as the canvas draws it, at a fixed spot on the stage. */
export function DemoSeat({
  id,
  name,
  harness,
  spec,
  x,
  y,
  health = NO_HEALTH,
  signal = NO_SIGNAL,
  overseer = false,
  bubble,
  selected = false,
  caption,
}: DemoSeatProps) {
  return (
    <div
      className={`tour-seat react-flow__node${selected ? " selected" : ""}`}
      style={{ left: x, top: y, width: AGENT_NODE_SIZE.width }}
    >
      <div
        className="junto-node relative flex flex-col"
        data-node-kind="agent"
        style={{ ...AGENT_NODE_SIZE, border: "1px solid transparent" } as CSSProperties}
      >
        <AgentSeatView
          identity={id}
          activity={spec}
          harness={harness}
          health={health}
          signal={signal}
          overseer={overseer}
          title={<div className="truncate font-mono text-[13px] font-semibold leading-snug text-ink">{name}</div>}
        />
        {bubble ? <PreambleBubble nodeId={`tour-${id}`} bubble={bubble} selected={selected} /> : null}
      </div>
      {caption ? <div className="tour-seat__caption">{caption}</div> : null}
    </div>
  );
}

type Point = { readonly x: number; readonly y: number };

/** The wire's route: out of the source's right edge, into the target's left. */
const wirePath = (from: Point, to: Point): string => {
  const bend = Math.max(40, Math.abs(to.x - from.x) / 2);
  return `M ${String(from.x)} ${String(from.y)} C ${String(from.x + bend)} ${String(from.y)}, ${String(to.x - bend)} ${String(to.y)}, ${String(to.x)} ${String(to.y)}`;
};

/** Where a seat at (x, y) meets a wire. */
export const seatPort = (x: number, y: number, side: "left" | "right"): Point => ({
  x: side === "right" ? x + AGENT_NODE_SIZE.width : x,
  y: y + AGENT_NODE_SIZE.height / 2,
});

/**
 * A messages wire between two seats, drawn with the canvas's stroke, and the
 * real pulse: the same class and colours the edge renders when a message
 * crosses. `pulse` bumps to send one; each value runs once.
 */
export function DemoWire({
  from,
  to,
  width,
  height,
  pulse,
  kind = "notice",
  reverse = false,
}: {
  readonly from: Point;
  readonly to: Point;
  readonly width: number;
  readonly height: number;
  /** Increments to send a pulse; undefined or 0 sends none. */
  readonly pulse?: number;
  readonly kind?: WireTrafficKind;
  readonly reverse?: boolean;
}) {
  const d = wirePath(from, to);
  return (
    <svg className="tour-wire" width={width} height={height} aria-hidden>
      <path
        d={d}
        className="junto-edge"
        style={{ fill: "none", stroke: `var(${VERB_COLOR_TOKEN.messages})`, strokeWidth: 1.2, opacity: 0.9 }}
      />
      {pulse ? (
        <path
          key={pulse}
          d={d}
          pathLength={1}
          className="junto-wire-pulse"
          data-direction={reverse ? "reverse" : "forward"}
          style={{ stroke: `var(${WIRE_PULSE_TOKEN[kind]})` }}
        />
      ) : null}
    </svg>
  );
}

/** One pulse per beat, spaced so each finishes before the next. */
export const PULSE_BEAT_MS = WIRE_PULSE_MS + 1500;
