import { use$ } from "@legendapp/state/react";
import type { SeatSignalRollup } from "@shared/agent-signals";
import type { HarnessId } from "@shared/managed-terminal-templates";
import type { Seat } from "@shared/model";
import type { ActivitySpec } from "../lib/activity";
import { RING_HOLE_R } from "../lib/activity-rings";
import { agentSeat$ } from "../lib/agent-seat-state";
import type { AgentChatCoarse } from "../lib/chat-state";
import { seatSignalRollups$, useSeatSignalRollup } from "../lib/agent-signals-state";
import { kernel$ } from "../lib/kernel-view";
import { attentionCoarse$, useSeatAttentionReasons } from "../lib/occupancy-feed";
import { attentionReasonsForNode, cardMark, seatFactsForNode, type SeatFactsInput } from "../lib/seat-projections";
import { seatUrgency, type SeatUrgency } from "../lib/seat-line";
import { state$ } from "../lib/state";
import { terminal$ } from "../lib/terminal-state";
import { useThreadHealthMark, type ThreadHealthMark } from "../lib/thread-health";
import { seatPortraitMood } from "../lib/portrait-mood";
import { ActivityMarkFromSpec } from "./ActivityMark";
import { AgentPortrait } from "./AgentPortrait";

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
      attentionReasons: reads.attentionReasons,
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

/** A native seat's live facts, subscribed by its binding and agent key. */
export function useSeatGlanceOf(seat: Seat): SeatGlance {
  const seatEvent = use$(agentSeat$.byBindingId[seat.bindingId]);
  const needsLook = use$(() => agentSeat$.needsLookByBindingId[seat.bindingId].get() === true);
  const session = use$(terminal$.sessionByBindingId[seat.bindingId]);
  const graphBlocked = use$(() => kernel$.execution.get()?.blocked.includes(seat.id) === true);
  const attentionReasons = useSeatAttentionReasons(seat.agentKey);
  const signal = useSeatSignalRollup(use$(state$.canvasName), seat.id);
  const health = useThreadHealthMark(seat.bindingId, signal?.kind);
  return { ...seatControlOf(seat.id, seat.harness, { seatEvent, needsLook, session, graphBlocked, attentionReasons }), health, signal };
}

/**
 * How urgently a seat wants the operator right now (seatUrgency), read once
 * from the same stores without subscribing: a list sorted by it holds its
 * order while the operator moves through it.
 */
export function seatUrgencyOf(seat: Seat): SeatUrgency {
  const agent = { ether: { entity: { kind: "agent", name: seat.agentKey } } };
  const coarse = attentionCoarse$(agent).peek() as AgentChatCoarse | undefined;
  const control = seatControlOf(seat.id, seat.harness, {
    seatEvent: agentSeat$.byBindingId[seat.bindingId].peek(),
    needsLook: agentSeat$.needsLookByBindingId[seat.bindingId].peek() === true,
    session: terminal$.sessionByBindingId[seat.bindingId].peek(),
    graphBlocked: kernel$.execution.peek()?.blocked.includes(seat.id) === true,
    attentionReasons: attentionReasonsForNode(agent, coarse),
  });
  return seatUrgency({ ...control, signal: seatSignalRollups$.peek()[seat.id]?.kind });
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
    >
      <AgentPortrait
        identity={node.id}
        size={portrait}
        frame="round"
        outline={false}
        badge={portrait >= 28}
        harness={harness}
        mood={seatPortraitMood(activity, health, signal?.kind)}
      />
    </ActivityMarkFromSpec>
  );
}
