import { useMemo } from "react";
import { ViewportPortal } from "@xyflow/react";
import {
  WIRE_PULSE_TOKEN,
  WIRE_PULSE_WIDTH,
  pulseMover,
  pulsePlan,
  wirePulseScheduler,
  type WirePulse as Pulse,
} from "../../lib/wire-pulse";
import type { WireTrafficKind } from "@shared/wire-traffic";
import "./wire-pulse.css";

/**
 * The light a delivered message sends along its wire: one short dash, round
 * capped, from sender to receiver (lib/wire-pulse.ts).
 *
 * It runs on the compositor. The wire is laid as one clipped strip per
 * straight leg, turned to the leg's heading, and inside each a mover one
 * travel wide carries the dash across with transform alone, every strip on
 * the same easing and clock, so the dash crosses each corner as one. Nothing
 * repaints while it travels.
 *
 * Reduced motion keeps the hold: the whole wire takes the kind's colour
 * briefly and clears in one step, drawn as the wire's own second path
 * (`PulseHold`, inside the wire's SVG).
 */
export function PulseStrips({
  path,
  kind,
  reverse,
  impactIn = false,
  className,
  onEnd,
}: {
  readonly path: string;
  readonly kind: WireTrafficKind;
  readonly reverse: boolean;
  readonly impactIn?: boolean;
  readonly className?: string;
  readonly onEnd?: () => void;
}) {
  const plan = useMemo(() => pulsePlan(path), [path]);
  return (
    <div
      className={className ? `junto-wire-pulse ${className}` : "junto-wire-pulse"}
      data-direction={reverse ? "reverse" : "forward"}
      data-impact-in={impactIn ? "" : undefined}
      style={{ color: `var(${WIRE_PULSE_TOKEN[kind]})` }}
      // Every strip's mover ends together; the first end is the pulse's.
      onAnimationEnd={onEnd}
    >
      {plan.legs.map((leg, index) => {
        const mover = pulseMover(plan, leg, reverse);
        return (
          <div
            key={index}
            className="junto-wire-pulse__run"
            style={{
              left: leg.x,
              top: leg.y - WIRE_PULSE_WIDTH / 2,
              width: leg.length,
              height: WIRE_PULSE_WIDTH,
              transform: `rotate(${String(leg.angle)}deg)`,
            }}
          >
            <div className="junto-wire-pulse__mover" style={{ left: mover.left, width: mover.travel }}>
              <div className="junto-wire-pulse__dash" style={{ width: mover.dash }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** The reduced-motion hold, an SVG path laid over the wire; hidden otherwise. */
export function PulseHold({
  path,
  kind,
  onEnd,
}: {
  readonly path: string;
  readonly kind: WireTrafficKind;
  readonly onEnd?: () => void;
}) {
  return (
    <path
      d={path}
      className="junto-wire-pulse-hold"
      style={{ stroke: `var(${WIRE_PULSE_TOKEN[kind]})` }}
      onAnimationEnd={onEnd}
    />
  );
}

/**
 * A canvas wire's pulse. The strips are drawn in the viewport portal above
 * the cards, as a flow track is (FlowTrack), so no card is lifted into a
 * layer of its own for overlapping a moving strip. Every leg stops at the
 * wire's ends, which sit on the cards' edges, so the dash never shows over
 * the card it runs to.
 */
export function WirePulse({
  edgeId,
  path,
  pulse,
  impactIn,
}: {
  readonly edgeId: string;
  readonly path: string;
  readonly pulse: Pulse;
  readonly impactIn: boolean;
}) {
  // The scheduler takes the first end of this seq and ignores the rest.
  const ended = (): void => wirePulseScheduler.end(edgeId, pulse.seq);
  return (
    <>
      <PulseHold key={pulse.seq} path={path} kind={pulse.kind} onEnd={ended} />
      <ViewportPortal>
        <PulseStrips
          key={pulse.seq}
          path={path}
          kind={pulse.kind}
          reverse={pulse.reverse}
          impactIn={impactIn}
          onEnd={ended}
        />
      </ViewportPortal>
    </>
  );
}
