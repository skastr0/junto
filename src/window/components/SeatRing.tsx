import { use$ } from "@legendapp/state/react";
import { agentSeatStatusOf } from "@shared/agent-seat-state";
import type { SeatSignalRollup } from "@shared/agent-signals";
import type { HarnessId } from "@shared/managed-terminal-templates";
import type { Seat } from "@shared/model";
import type { ActivitySpec } from "../lib/activity";
import { RING_HOLE_R } from "../lib/activity-rings";
import { agentSeat$ } from "../lib/agent-seat-state";
import { seatSignalRollups$, useSeatSignalRollup } from "../lib/agent-signals-state";
import { kernel$ } from "../lib/kernel-view";
import { cardMark, seatFactsForNode, type SeatFactsInput } from "../lib/seat-projections";
import { Palette, type ViewGroup } from "@shared/wire/urgency";
import { seatLevel, seatLevelSince } from "@shared/wire/seat-level";
import { seatUrgency, type SeatGroup } from "../lib/seat-line";
import { state$ } from "../lib/state";
import { terminal$ } from "../lib/terminal-state";
import { useThreadHealthMark, type ThreadHealthMark } from "../lib/thread-health";
import { seatPortraitMood } from "../lib/portrait-mood";
import { ActivityMarkFromSpec } from "./ActivityMark";
import { AgentPortrait, PortraitBadge } from "./AgentPortrait";

/**
 * The even portrait size that fills the ring's hole at a given box: the hole
 * is RING_HOLE_R of a 20-unit box, so its diameter is px * RING_HOLE_R / 10.
 */
export const portraitFor = (px: number): number => Math.round((px * RING_HOLE_R) / 20) * 2;

/** A seat's live facts, read once for its ring and its line. */
export type SeatGlance = {
  readonly activity: ActivitySpec;
  readonly health: ThreadHealthMark;
  readonly signal: SeatSignalRollup | undefined;
  /** Managed harness id; absent for an unmanaged seat. */
  readonly harness: HarnessId | undefined;
  /** Spawn failure copy, as the canvas seat prints it. */
  readonly failure: string | undefined;
};

type SeatReads = Omit<SeatFactsInput, "nodeId" | "managedSeat">;

const seatControlOf = (
  nodeId: string,
  harness: HarnessId | undefined,
  reads: SeatReads,
): Pick<SeatGlance, "activity" | "harness" | "failure"> => {
  const { seatEvent, session } = reads;
  const activity = cardMark(
    seatFactsForNode({
      nodeId,
      seatEvent,
      session,
      needsLook: reads.needsLook,
      graphBlocked: reads.graphBlocked,
      managedSeat: harness !== undefined,
    }),
  );
  const failure =
    harness !== undefined && session?.exitReason && session.exitMessage ? session.exitMessage : undefined;
  return {
    activity:
      seatEvent?.state === "attention" && seatEvent.reason ? { ...activity, label: seatEvent.reason } : activity,
    harness,
    failure,
  };
};

/** A native seat's live facts, subscribed by its binding. */
export function useSeatGlanceOf(seat: Seat): SeatGlance {
  const seatEvent = use$(agentSeat$.byBindingId[seat.bindingId]);
  const needsLook = use$(() => agentSeat$.needsLookByBindingId[seat.bindingId].get() === true);
  const session = use$(terminal$.sessionByBindingId[seat.bindingId]);
  const graphBlocked = use$(() => kernel$.execution.get()?.blocked.includes(seat.id) === true);
  const signal = useSeatSignalRollup(use$(state$.canvasName), seat.id);
  const health = useThreadHealthMark(seat.bindingId, signal?.kind);
  return { ...seatControlOf(seat.id, seat.harness, { seatEvent, needsLook, session, graphBlocked }), health, signal };
}

type Readable<T> = { get(): T; peek(): T };

/** The seat's control facts and open signal, tracked (`get`) or not (`peek`). */
const seatReadOf = (seat: Seat, tracked: boolean) => {
  const read = <T,>(source: Readable<T>): T => (tracked ? source.get() : source.peek());
  const seatEvent = read(agentSeat$.byBindingId[seat.bindingId]);
  const control = seatControlOf(seat.id, seat.harness, {
    seatEvent,
    needsLook: read(agentSeat$.needsLookByBindingId[seat.bindingId]) === true,
    session: read(terminal$.sessionByBindingId[seat.bindingId]),
    graphBlocked: read(kernel$.execution)?.blocked.includes(seat.id) === true,
  });
  const rollup = read(seatSignalRollups$)[seat.id];
  return { control, seatEvent, rollup, doneAt: read(agentSeat$.doneAtByBindingId[seat.bindingId]) };
};

/**
 * How urgently a seat wants the operator right now (seatUrgency), read once
 * from the same stores without subscribing: a list sorted by it holds its
 * order while the operator moves through it.
 */
export function seatUrgencyOf(seat: Seat): SeatGroup {
  const { control, rollup } = seatReadOf(seat, false);
  return seatUrgency({ ...control, signal: rollup?.kind });
}

/** Where a seat stands in the palette: its group, and when it entered that group. */
export type SeatStanding = { readonly group: ViewGroup<typeof Palette>; readonly since: number };

/**
 * A seat's palette standing. Read inside a `use$` computed it tracks every
 * store it reads, so the palette re-ranks when a seat changes state. `since`
 * is the time of the fact that put the seat in its rank: the open signal for
 * blocked, waiting and review, the finished turn for done, else the status
 * change in the seat's own snapshot (the last time it left rest, for working).
 */
export function seatStandingOf(seat: Seat): SeatStanding {
  const { control, seatEvent, rollup, doneAt } = seatReadOf(seat, true);
  const level = seatLevel({ ...control, signal: rollup?.kind });
  const since = seatLevelSince({
    level,
    ...(rollup ? { signal: { kind: rollup.kind, createdAt: rollup.signal.createdAt } } : {}),
    snapshot: agentSeatStatusOf(seatEvent)?.snapshot,
    doneAt,
    at: seatEvent?.at,
  });
  return { group: Palette.groupOf(level), since };
}

/** The ring over facts a caller already read (a row that also prints the line). */
export function SeatRingView({
  node,
  px,
  glance,
}: {
  readonly node: Seat;
  readonly px: number;
  readonly glance: SeatGlance;
}) {
  const { activity, health, signal, harness } = glance;
  const portrait = portraitFor(px);
  return (
    <ActivityMarkFromSpec
      spec={activity}
      size="glance"
      unit={px}
      health={health.health}
      healthValue={health.value}
      healthStale={health.healthStale}
      healthLabel={health.label}
      signal={signal?.kind}
      signalCount={signal?.openCount}
      crest={node.overseer}
      over={portrait >= 28 && harness !== undefined ? <PortraitBadge size={portrait} frame="round" harness={harness} /> : undefined}
    >
      <AgentPortrait
        identity={node.id}
        size={portrait}
        frame="round"
        outline={false}
        mood={seatPortraitMood(activity, health, signal?.kind)}
      />
    </ActivityMarkFromSpec>
  );
}
