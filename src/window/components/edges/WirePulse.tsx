import { ViewportPortal } from "@xyflow/react";
import type { WirePulse as Pulse } from "../../lib/wire-pulse";
import { wirePulseScheduler } from "../../lib/wire-pulse-state";
import { PulseHold, PulseStrips } from "./WirePulseView";

export { PulseHold, PulseStrips } from "./WirePulseView";

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
