/**
 * Seat urgency, derived from the stores with no card mounted: the reading
 * the seat's ring draws (region-urgency.ts's seatUrgencyOfRing over the same
 * facts SeatCard assembles), published into seatUrgency$ for the regions,
 * the minimap and the clusters. AgentSeat no longer publishes it.
 */
import { observe } from "@legendapp/state";
import { agentSeat$ } from "../../lib/agent-seat-state";
import { seatSignalRollups$ } from "../../lib/agent-signals-state";
import { resolveActivityGlyph } from "../../lib/activity";
import { modelStore } from "../../lib/use-model";
import { publishSeatUrgency, seatUrgencyOfRing, type Urgency } from "../../lib/region-urgency";
import { cardMark, seatFactsForNode } from "../../lib/seat-projections";
import { seatAwareness$ } from "../../lib/seat-awareness";
import { state$ } from "../../lib/state";
import { terminal$ } from "../../lib/terminal-state";
import { healthClockNow, threadHealthMarkOf } from "../../lib/thread-health";
import { blockedNodeIds } from "./shared";

export const retainSeatUrgency = (canvasName: string): (() => void) => {
  let published = new Set<string>();
  const off = observe(() => {
    const model = modelStore.canvas$(canvasName);
    const ids = model.nodeIds.get();
    const rollups = seatSignalRollups$.get();
    const openCanvas = state$.canvasName.get();
    agentSeat$.rev.get();
    seatAwareness$.rev.get();
    const sessions = terminal$.sessionByBindingId.get();
    healthClockNow();
    const blocked = blockedNodeIds(canvasName);

    const next = new Map<string, Urgency>();
    for (const id of ids) {
      const node$ = model.nodes[id];
      if (node$.kind.get() !== "agent") continue;
      const bindingId = (node$ as unknown as { bindingId: { get(): string | undefined } }).bindingId.get();
      const rollup = openCanvas === canvasName ? rollups[id]?.kind : undefined;
      const health = threadHealthMarkOf(bindingId, rollup);
      const facts = seatFactsForNode({
        nodeId: id,
        seatEvent: bindingId === undefined ? undefined : agentSeat$.byBindingId[bindingId].peek(),
        session: bindingId === undefined ? undefined : sessions[bindingId],
        needsLook: bindingId !== undefined && agentSeat$.needsLookByBindingId[bindingId].peek() === true,
        graphBlocked: blocked.has(id),
        managedSeat: true,
      });
      const mark = cardMark(facts);
      const urgency = seatUrgencyOfRing({
        glyph: resolveActivityGlyph(mark.mode, mark.tone, mark.glyph),
        signal: rollup,
        health: health.health,
        healthStale: health.healthStale,
      });
      if (urgency !== undefined) next.set(id, urgency);
    }

    for (const id of published) {
      if (!next.has(id)) publishSeatUrgency(id, undefined);
    }
    for (const [id, urgency] of next) publishSeatUrgency(id, urgency);
    published = new Set(next.keys());
  });
  return () => {
    off();
    for (const id of published) publishSeatUrgency(id, undefined);
    published = new Set();
  };
};
