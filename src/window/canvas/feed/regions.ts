/**
 * Region chrome, derived from the stores with no card mounted: the severity
 * and member counts the minimap and magnifier read (state$.regionSeverityByNodeId
 * / regionCountsByNodeId, was the observe inside RtsBottomBar) and each
 * region's urgency (regionUrgency$, was RegionUrgencyGate's React Flow read).
 */
import { batch, observe } from "@legendapp/state";
import { compareSeverity, type MemberSeverity, type RegionRollup } from "@shared/region-rollup";
import { modelStore } from "../../lib/use-model";
import { nodeUrgency$, publishRegionUrgencies, regionUrgencies, seatUrgency$ } from "../../lib/region-urgency";
import { readRegionRollups } from "../../lib/region-rollups";
import { state$ } from "../../lib/state";
import { regionParentOf } from "./shared";

/** Severity and counts per region node, from the retained rollup store. */
const retainRegionRollups = (canvasName: string): (() => void) =>
  observe(() => {
    const rollups = readRegionRollups(canvasName);
    const severities: Record<string, MemberSeverity> = {};
    const counts: Record<string, RegionRollup["counts"]> = {};
    for (const rollup of [...rollups].sort((a, b) => a.regionId.localeCompare(b.regionId))) {
      for (const member of [...rollup.members].sort((a, b) => a.nodeId.localeCompare(b.nodeId))) {
        const previous = severities[member.nodeId];
        if (previous === undefined || compareSeverity(member.severity, previous) < 0) {
          severities[member.nodeId] = member.severity;
        }
      }
      severities[rollup.regionId] = rollup.severity;
      counts[rollup.regionId] = rollup.counts;
    }
    batch(() => {
      if (JSON.stringify(state$.regionSeverityByNodeId.peek()) !== JSON.stringify(severities)) {
        state$.regionSeverityByNodeId.set(severities);
      }
      if (JSON.stringify(state$.regionCountsByNodeId.peek()) !== JSON.stringify(counts)) {
        state$.regionCountsByNodeId.set(counts);
      }
    });
  });

/** Each region's urgency from the urgent seats and nodes the feeds publish. */
const retainRegionUrgency = (canvasName: string): (() => void) => {
  const off = observe(() => {
    const seats = seatUrgency$.get();
    const nodes = nodeUrgency$.get();
    const parentOf = regionParentOf(canvasName);
    const model = modelStore.canvas$(canvasName);
    const kindOf = (id: string): string | undefined => model.nodes[id]?.kind.peek();
    const urgent = [
      ...Object.entries(seats).map(([id, urgency]) => ({ id, urgency })),
      ...Object.entries(nodes).map(([id, urgency]) => ({ id, urgency })),
    ];
    publishRegionUrgencies(
      regionUrgencies(
        urgent,
        (id) => (kindOf(id) === "region" ? undefined : parentOf.get(id)),
        (id) => parentOf.get(id),
      ),
    );
  });
  return () => {
    off();
    publishRegionUrgencies(new Map());
  };
};

export const retainRegionChrome = (canvasName: string): (() => void) => {
  const stops = [retainRegionRollups(canvasName), retainRegionUrgency(canvasName)];
  return () => {
    for (const stop of stops) stop();
  };
};
