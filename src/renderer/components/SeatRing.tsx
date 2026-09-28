import { use$ } from "@legendapp/state/react";
import type { SeatSignalRollup } from "@shared/agent-signals";
import type { CanvasNode } from "@shared/canvas";
import { isHarnessId, type HarnessId } from "@shared/managed-terminal-templates";
import type { ActivitySpec } from "../lib/activity";
import { RING_HOLE_R } from "../lib/activity-rings";
import { agentSeat$, bindingIdForNode } from "../lib/agent-seat-state";
import type { AgentChatCoarse } from "../lib/chat-state";
import { seatSignalRollups$, useSeatSignalRollup } from "../lib/agent-signals-state";
import { kernel$ } from "../lib/kernel-view";
import { attentionCoarse$, useNodeAttentionReasons } from "../lib/occupancy-feed";
import { attentionReasonsForNode, cardMark, seatFactsForNode, type SeatFactsInput } from "../lib/seat-projections";
import { seatUrgency, type SeatUrgency } from "../lib/seat-line";
import { state$ } from "../lib/state";
import { terminal$ } from "../lib/terminal-state";
import { useThreadHealthMark, type ThreadHealthMark } from "../lib/thread-health";
import { seatPortraitMood } from "../lib/portrait-mood";
import { isOverseerSeat } from "../lib/overseer-set";
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

/** Control state and spawn failure from one read of the seat's stores. */
const seatControl = (
  node: CanvasNode,
  reads: SeatReads,
): Pick<SeatGlance, "activity" | "harness" | "failure"> => {
  const { seatEvent, session } = reads;
  const raw = node.ether?.terminal?.harness;
  const harness = typeof raw === "string" && isHarnessId(raw) ? raw : undefined;
  const activity = cardMark(
    seatFactsForNode({
      nodeId: node.id,
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

/**
 * The same facts as the canvas seat (TextNode): control state, the seat's
 * attention reason, thread health, declared signal, spawn failure.
 */
export function useSeatGlance(node: CanvasNode): SeatGlance {
  const bindingId = bindingIdForNode(node);
  const seatEvent = use$(() => (bindingId ? agentSeat$.byBindingId[bindingId].get() : undefined));
  const needsLook = use$(() =>
    bindingId ? agentSeat$.needsLookByBindingId[bindingId].get() === true : false,
  );
  const session = use$(() => (bindingId ? terminal$.sessionByBindingId[bindingId].get() : undefined));
  const graphBlocked = use$(() => kernel$.execution.get()?.blocked.includes(node.id) === true);
  const attentionReasons = useNodeAttentionReasons(node);
  const canvasName = use$(state$.canvasName);
  const signal = useSeatSignalRollup(canvasName, node.id);
  const health = useThreadHealthMark(bindingId, signal?.kind);
  return {
    ...seatControl(node, { seatEvent, needsLook, session, graphBlocked, attentionReasons }),
    health,
    signal,
  };
}

/**
 * How urgently a seat wants the operator right now (seatUrgency), read once
 * from the same stores without subscribing: a list sorted by it holds its
 * order while the operator moves through it.
 */
export function seatUrgencyNow(node: CanvasNode): SeatUrgency {
  const bindingId = bindingIdForNode(node);
  const coarse = attentionCoarse$(node).peek() as AgentChatCoarse | undefined;
  const control = seatControl(node, {
    seatEvent: bindingId ? agentSeat$.byBindingId[bindingId].peek() : undefined,
    needsLook: bindingId ? agentSeat$.needsLookByBindingId[bindingId].peek() === true : false,
    session: bindingId ? terminal$.sessionByBindingId[bindingId].peek() : undefined,
    graphBlocked: kernel$.execution.peek()?.blocked.includes(node.id) === true,
    attentionReasons: attentionReasonsForNode({ ether: node.ether }, coarse),
  });
  return seatUrgency({ ...control, signal: seatSignalRollups$.peek()[node.id]?.kind });
}

/**
 * An agent's portrait held by its live ring, anywhere outside the canvas
 * seat (grid cells, focus headers, the kind surface, the inspector, cmd+K).
 * Same facts as the canvas seat: control state, thread health, declared signal.
 */
export function SeatRing({ node, px }: { readonly node: CanvasNode; readonly px: number }) {
  return <SeatRingView node={node} px={px} glance={useSeatGlance(node)} />;
}

/** The ring over facts a caller already read (a row that also prints the line). */
export function SeatRingView({
  node,
  px,
  glance,
}: {
  readonly node: CanvasNode;
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
      crest={isOverseerSeat(node)}
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
