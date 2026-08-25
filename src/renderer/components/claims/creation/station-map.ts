/**
 * Pure metro-line derivation for task creation. A task raised at a sink with
 * flow destinations will travel, so the composer reads the whole line first:
 * every station it can still reach, the standing law waiting there, and how
 * arrivals are admitted. No React state, no I/O — the map renders these.
 */

import type { CanvasDoc } from "@shared/canvas";
import {
  effectiveClaimsStack,
  sinkContractOf,
  type EffectiveClaim,
} from "@shared/claims";
import { flowDestinations } from "@shared/flow-graph";
import { stationIdentity } from "@shared/station-identity";
import { resolveSinkAdmission, type SinkAdmission } from "@shared/work-model";

export type StationStop = {
  readonly nodeId: string;
  readonly label: string;
  /** Hops along flow edges from the origin sink; 0 is the origin itself. */
  readonly hops: number;
  readonly origin: boolean;
  /** Nothing downstream: work that reaches this stop can only close here. */
  readonly terminal: boolean;
  /**
   * True when the stop before it in reading order actually forwards here.
   * False marks where the drawn line jumps to another branch of the fork —
   * reading order is breadth-first, and a fork is not a straight track.
   */
  readonly linkedToPrevious: boolean;
  /** Direct forward stations, document edge order. */
  readonly destinations: ReadonlyArray<string>;
  /** Standing law here: region stack claims outer to inner, then the sink's. */
  readonly law: ReadonlyArray<EffectiveClaim>;
  readonly hard: number;
  readonly soft: number;
  readonly admission: SinkAdmission;
  /** Stage purpose, ambient to whoever claims here. */
  readonly instruction?: string;
  /** What this stop says it takes in, for upstream routing. */
  readonly description?: string;
  /** Triage posture for arrivals. */
  readonly triage?: string;
  /** Bake time before an arrival becomes claimable here. */
  readonly bakeMs?: number;
};

/**
 * Every station a task raised at `originNodeId` can still visit, breadth-first
 * from the origin (which is always the first stop — the task is answerable
 * there before it travels anywhere). Deterministic: ties keep document edge
 * order, and a station reachable by two paths keeps its shortest hop count.
 */
export const stationLine = (
  doc: CanvasDoc,
  originNodeId: string,
): ReadonlyArray<StationStop> => {
  const walked: Array<{ readonly nodeId: string; readonly hops: number }> = [];
  const seen = new Set<string>([originNodeId]);
  const queue: Array<{ readonly nodeId: string; readonly hops: number }> = [
    { nodeId: originNodeId, hops: 0 },
  ];
  while (queue.length > 0) {
    const stop = queue.shift()!;
    walked.push(stop);
    for (const destination of flowDestinations(doc, stop.nodeId)) {
      if (seen.has(destination)) continue;
      seen.add(destination);
      queue.push({ nodeId: destination, hops: stop.hops + 1 });
    }
  }
  return walked.map((stop, index) => {
    const node = doc.nodes.find((candidate) => candidate.id === stop.nodeId);
    const contract = sinkContractOf(node);
    const inbound = contract?.inbound;
    const law = effectiveClaimsStack(doc, stop.nodeId);
    const destinations = flowDestinations(doc, stop.nodeId);
    const previous = walked[index - 1];
    const identity = stationIdentity(node, stop.nodeId);
    return {
      nodeId: stop.nodeId,
      label: identity.name,
      hops: stop.hops,
      origin: index === 0,
      terminal: destinations.length === 0,
      linkedToPrevious:
        previous === undefined ||
        flowDestinations(doc, previous.nodeId).includes(stop.nodeId),
      destinations,
      law,
      hard: law.filter((entry) => entry.claim.severity === "hard").length,
      soft: law.filter((entry) => entry.claim.severity === "soft").length,
      admission: resolveSinkAdmission(contract),
      ...(identity.role !== undefined ? { instruction: identity.role } : {}),
      ...(inbound?.description !== undefined
        ? { description: inbound.description }
        : {}),
      ...(inbound?.instruction !== undefined ? { triage: inbound.instruction } : {}),
      ...(inbound?.claimableAfterMs !== undefined
        ? { bakeMs: inbound.claimableAfterMs }
        : {}),
    };
  });
};

/** Distance from the origin, in words: "here", "next stop", "3 stops on". */
export const formatHops = (hops: number): string => {
  if (hops <= 0) return "here";
  if (hops === 1) return "next stop";
  return `${hops} stops on`;
};

/** How a station admits arrivals, in words. */
export const admissionLabel = (admission: SinkAdmission): string => {
  switch (admission) {
    case "operator-owned":
      return "yours to work";
    case "operator-gated":
      return "you admit arrivals";
    case "auto":
      return "open to workers";
  }
};
