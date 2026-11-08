import type { ReactNode } from "react";
import { useSeatSignalRollup } from "../../lib/agent-signals-state";
import { openOperatorModal } from "../../lib/operator-modal";
import { useSeatOffboardFailure } from "../../lib/seat-offboard-state";
import { useSeatOnboardingOf } from "../../lib/seat-onboarding";
import { useThreadHealthMark } from "../../lib/thread-health";
import { useEffect } from "react";
import type { ActivitySpec } from "../../lib/activity";
import { resolveActivityGlyph } from "../../lib/activity";
import { publishSeatUrgency, seatUrgencyOfRing } from "../../lib/region-urgency";
import { SeatCacheStatus } from "./SeatCacheStatus";
import type { SeatCacheFace } from "./seat-cache-status";
import { AgentSeatView } from "./AgentSeatView";

export { AgentSeatView, SeatName, SEAT_PORTRAIT_PX, type SeatHealth, type SeatSignal } from "./AgentSeatView";

/** The live seat: signals and the thread-health reading from their stores. */
export function AgentSeat({
  canvas,
  id,
  bindingId,
  cache,
  host,
  ...rest
}: {
  readonly canvas: string;
  /** The seat's node id. */
  readonly id: string;
  readonly bindingId: string | undefined;
  readonly activity: ActivitySpec;
  readonly title: ReactNode;
  readonly harness?: string;
  readonly context?: string;
  readonly overseer?: boolean;
  readonly cache?: SeatCacheFace;
  readonly host?: string;
  readonly children?: ReactNode;
}) {
  const rollup = useSeatSignalRollup(canvas, id);
  const health = useThreadHealthMark(bindingId, rollup?.kind);
  const onboarding = useSeatOnboardingOf(bindingId);
  // An offboard whose session never closed is said here, on the seat, where
  // the operator is looking; a spawn failure, when there is one, comes first.
  const offboardFailure = useSeatOffboardFailure(id);
  // What the ring says, for the regions and the minimap (region-urgency.ts).
  const urgency = seatUrgencyOfRing({
    glyph: resolveActivityGlyph(rest.activity.mode, rest.activity.tone, rest.activity.glyph),
    signal: rollup?.kind,
    health: health.health,
    healthStale: health.healthStale,
  });
  useEffect(() => {
    publishSeatUrgency(id, urgency);
  }, [id, urgency]);
  useEffect(() => () => publishSeatUrgency(id, undefined), [id]);
  return (
    <AgentSeatView
      identity={id}
      health={health}
      signal={{ worst: rollup?.signal, openCount: rollup?.openCount ?? 0 }}
      onboarding={onboarding}
      // A signal is answered in the needs-you feed.
      onSignalOpen={() => openOperatorModal("feed")}
      cacheStatus={cache ? (words) => <SeatCacheStatus words={words} face={cache} host={host} /> : undefined}
      {...rest}
      context={rest.context ?? offboardFailure}
    />
  );
}
