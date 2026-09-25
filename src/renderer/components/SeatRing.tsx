import { use$ } from "@legendapp/state/react";
import type { CanvasNode } from "@shared/canvas";
import { isHarnessId } from "@shared/managed-terminal-templates";
import { RING_HOLE_R } from "../lib/activity-rings";
import { agentSeat$, bindingIdForNode } from "../lib/agent-seat-state";
import { useSeatSignalRollup } from "../lib/agent-signals-state";
import { kernel$ } from "../lib/kernel-view";
import { useNodeAttentionReasons } from "../lib/occupancy-feed";
import { cardMark, seatFactsForNode } from "../lib/seat-projections";
import { state$ } from "../lib/state";
import { terminal$ } from "../lib/terminal-state";
import { useThreadHealthMark } from "../lib/thread-health";
import { ActivityMarkFromSpec } from "./ActivityMark";
import { AgentPortrait } from "./AgentPortrait";

/**
 * The even portrait size that fills the ring's hole at a given box: the hole
 * is RING_HOLE_R of a 20-unit box, so its diameter is px * RING_HOLE_R / 10.
 */
export const portraitFor = (px: number): number => Math.round((px * RING_HOLE_R) / 20) * 2;

/**
 * An agent's portrait held by its live ring, anywhere outside the canvas
 * seat (grid cells, focus headers, the kind surface, the inspector). Same
 * facts as the canvas seat: control state, thread health, declared signal.
 */
export function SeatRing({ node, px }: { readonly node: CanvasNode; readonly px: number }) {
  const bindingId = bindingIdForNode(node);
  const seatEvent = use$(() => (bindingId ? agentSeat$.byBindingId[bindingId].get() : undefined));
  const needsLook = use$(() =>
    bindingId ? agentSeat$.needsLookByBindingId[bindingId].get() === true : false,
  );
  const session = use$(() => (bindingId ? terminal$.sessionByBindingId[bindingId].get() : undefined));
  const graphBlocked = use$(() => kernel$.execution.get()?.blocked.includes(node.id) === true);
  const attentionReasons = useNodeAttentionReasons(node);
  const canvasName = use$(state$.canvasName);
  const rollup = useSeatSignalRollup(canvasName, node.id);
  const health = useThreadHealthMark(bindingId, rollup?.kind);
  const harness = typeof node.ether?.terminal?.harness === "string" ? node.ether.terminal.harness : undefined;
  const managed = harness !== undefined && isHarnessId(harness);
  const activity = cardMark(
    seatFactsForNode({
      nodeId: node.id,
      seatEvent,
      session,
      needsLook,
      graphBlocked,
      flags: node.ether?.flags,
      attentionReasons,
      managedSeat: managed,
    }),
  );
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
      signal={rollup?.kind}
      signalCount={rollup?.openCount}
    >
      <AgentPortrait
        identity={node.id}
        size={portrait}
        frame="round"
        outline={false}
        badge={portrait >= 28}
        harness={managed ? harness : undefined}
      />
    </ActivityMarkFromSpec>
  );
}
