/**
 * Availability sources for `ui/MentionCombobox` (plan 0.10, 03 section 2):
 * one hook per rule, each returning what may be mentioned in a context. A
 * composer passes the candidates of the sources it needs; main checks the
 * same rule again on send, from the same shared function.
 *
 * - `useConnectedSeats`: seats wired to a seat by an edge, as main reads them.
 * - `useSeatsInReach`, `useResourcesInReach`: region reach (`region-reach.ts`).
 * - `useAutomationTargets`: at or below the automation, within its author's reach.
 *
 * Seats and pages are whole nodes. Tasks and artifacts are items on their
 * node, so the composer hands over the items it has read with `MentionItems`;
 * a node whose items are not given offers none.
 */
import { useMemo } from "react";
import type { Canvas } from "@shared/model";
import type { NodeId } from "@shared/physics/schema";
import {
  candidatesOfNodes,
  type MentionCandidate,
  type MentionItem,
  type MentionItems,
} from "@shared/mention-candidates";

/** The rule lives in shared (`mention-candidates.ts`); the desktop re-exports it for its own callers. */
export { candidatesOfNodes, type MentionCandidate, type MentionItem, type MentionItems };
import { mentionableNodesFrom } from "@shared/mention-reach";
import {
  automationTargets,
  seatsInReach,
  type AutomationAuthor,
  type ReachNode,
} from "@shared/region-reach";
import type { ItemId } from "@shared/work-ids";
import { useSeatThreadMentionables, type SeatAddress } from "./seat-threads";
import { useCanvas } from "./use-model";

const seatCandidate = (nodeId: NodeId, name: string): MentionCandidate => ({
  ref: { kind: "seat", nodeId },
  label: `@${name}`,
  title: name,
});

/**
 * Two candidates with one label read apart by a detail: the region path of
 * each, outer to inner, as the old review list did.
 */
export const withRegionDetail = (
  candidates: ReadonlyArray<MentionCandidate>,
  regionPathOf: (nodeId: NodeId) => ReadonlyArray<string>,
): ReadonlyArray<MentionCandidate> =>
  candidates.map((candidate) => {
    const shared = candidates.some((other) => other !== candidate && other.label === candidate.label);
    const path = shared ? regionPathOf(candidate.ref.nodeId) : [];
    return path.length === 0 ? candidate : { ...candidate, detail: path.join(" / ") };
  });

/** What a # or a page @ may name from a seat or a resource: main's rule, read from the one function (`mention-reach.ts`). */
export const resourceNodesInReach = (canvas: Pick<Canvas, "nodes">, from: NodeId): ReadonlyArray<ReachNode> =>
  mentionableNodesFrom(canvas, from);

/** Seats wired to this seat by an edge: the seat mail thread's @ (03 section 3). Empty while unread. */
export const useConnectedSeats = (seat: SeatAddress): ReadonlyArray<MentionCandidate> => {
  const seats = useSeatThreadMentionables(seat);
  return useMemo(() => seats.map((entry) => seatCandidate(entry.nodeId as NodeId, entry.name)), [seats]);
};

/** Seats in reach of a resource: a resource comment's @. */
export const useSeatsInReach = (canvasName: string, resourceId: NodeId): ReadonlyArray<MentionCandidate> => {
  const canvas = useCanvas(canvasName);
  return useMemo(
    () => candidatesOfNodes(canvas, seatsInReach(canvas, resourceId).filter((node) => node.id !== resourceId)),
    [canvas, resourceId],
  );
};

/** Tasks, artifacts and pages in reach of a seat or a resource: the # and the page @. */
export const useResourcesInReach = (
  canvasName: string,
  from: NodeId,
  items: MentionItems = {},
): ReadonlyArray<MentionCandidate> => {
  const canvas = useCanvas(canvasName);
  const { tasksOf, artifactsOf } = items;
  return useMemo(
    () => candidatesOfNodes(canvas, resourceNodesInReach(canvas, from), { tasksOf, artifactsOf }),
    [canvas, from, tasksOf, artifactsOf],
  );
};

/** What an automation may name as a target: at or below it, within its author's reach (07). */
export const useAutomationTargets = (
  canvasName: string,
  automationId: NodeId,
  author: AutomationAuthor,
  items: MentionItems = {},
): ReadonlyArray<MentionCandidate> => {
  const canvas = useCanvas(canvasName);
  const { tasksOf, artifactsOf } = items;
  const authorSeat = author.kind === "seat" ? author.seat : undefined;
  return useMemo(
    () =>
      candidatesOfNodes(
        canvas,
        automationTargets(canvas, automationId, authorSeat === undefined ? { kind: "operator" } : { kind: "seat", seat: authorSeat }),
        { tasksOf, artifactsOf },
      ),
    [canvas, automationId, authorSeat, tasksOf, artifactsOf],
  );
};
