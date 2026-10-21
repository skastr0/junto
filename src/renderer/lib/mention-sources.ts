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
import type { Canvas, Node } from "@shared/model";
import { titleOf } from "@shared/model/title";
import type { MentionRef } from "@shared/mention";
import type { NodeId } from "@shared/physics/schema";
import {
  automationTargets,
  reaches,
  resourcesInReach,
  seatsInReach,
  type AutomationAuthor,
  type ReachNode,
} from "@shared/region-reach";
import type { ItemId } from "@shared/work-ids";
import type { MentionCandidate } from "./mention-draft";
import { useSeatThreadMentionables, type SeatAddress } from "./seat-threads";
import { useCanvas } from "./use-model";

/** One task or artifact on its node, as a composer has read it. */
export type MentionItem = {
  readonly id: ItemId;
  readonly title: string;
  /** A task's per-canvas number (04), shown first: `#42 fix tabs`. */
  readonly number?: number;
  /** Its state in words, such as "done". */
  readonly note?: string;
};

export type MentionItems = {
  readonly tasksOf?: (nodeId: NodeId) => ReadonlyArray<MentionItem>;
  readonly artifactsOf?: (nodeId: NodeId) => ReadonlyArray<MentionItem>;
};

const seatCandidate = (nodeId: NodeId, name: string): MentionCandidate => ({
  ref: { kind: "seat", nodeId },
  label: `@${name}`,
});

const itemLabel = (item: MentionItem): string =>
  item.number === undefined ? `#${item.title}` : `#${item.number} ${item.title}`;

const withNote = (candidate: MentionCandidate, note: string | undefined): MentionCandidate =>
  note === undefined ? candidate : { ...candidate, note };

/**
 * The candidates the nodes make: an agent is a seat, a page is itself, a
 * task board or an Artifacts node offers its items. Anything else, a peer
 * row included (it acts from its own machine), offers nothing.
 */
export const candidatesOfNodes = (
  canvas: Pick<Canvas, "nodes">,
  nodes: ReadonlyArray<Pick<ReachNode, "id" | "kind">>,
  items: MentionItems = {},
): ReadonlyArray<MentionCandidate> =>
  nodes.flatMap((reach): ReadonlyArray<MentionCandidate> => {
    const node: Node | undefined = canvas.nodes.get(reach.id);
    if (node === undefined) return [];
    switch (node.kind) {
      case "agent":
        return [seatCandidate(reach.id, titleOf(node))];
      case "page":
        return [{ ref: { kind: "page", nodeId: reach.id }, label: `@${titleOf(node)}` }];
      case "task":
        return (items.tasksOf?.(reach.id) ?? []).map((item) =>
          withNote({ ref: { kind: "task", nodeId: reach.id, taskId: item.id } satisfies MentionRef, label: itemLabel(item) }, item.note),
        );
      case "artifacts":
        return (items.artifactsOf?.(reach.id) ?? []).map((item) =>
          withNote(
            { ref: { kind: "artifact", nodeId: reach.id, artifactId: item.id } satisfies MentionRef, label: `#${item.title}` },
            item.note,
          ),
        );
      default:
        return [];
    }
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

/** Resources a seat or resource reaches, pages included: what a # or a page @ may name from there. */
export const resourceNodesInReach = (
  canvas: Pick<Canvas, "nodes">,
  from: NodeId,
): ReadonlyArray<ReachNode> => {
  const found = [...resourcesInReach(canvas, from)];
  for (const node of canvas.nodes.values()) {
    if (node.kind === "page" && node.id !== from && reaches(canvas, from, node.id)) found.push(node);
  }
  return found;
};

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
