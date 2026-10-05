import { useMemo } from "react";
import { use$ } from "@legendapp/state/react";
import type { CanvasDoc, CanvasNode } from "@shared/canvas";
import type { AgentSignal } from "@shared/agent-signals";
import { feedCanvasNeeds } from "@shared/canvas-needs";
import { executionGraphContextFromActorRefs } from "@shared/graph";
import {
  buildOperatorFeed,
  feedSeatsFromDoc,
  needsOperatorCount,
  type FeedCanvasNeed,
  type FeedItem,
  type FeedSection,
  type OperatorFeed,
} from "@shared/operator-feed";
import type { ThreadHealthReading } from "@shared/thread-health";
import { agentSeat$, bindingIdForNode, seatEventForNode } from "./agent-seat-state";
import { agentSignals$ } from "./agent-signals-state";
import { chatCoarse$ } from "./chat-state";
import { executionGraphForImpact } from "./impact-mode";
import { kernel$ } from "./kernel-view";
import { nodeTitle } from "./presentation";
import { seatAwareness$ } from "./seat-awareness";
import { attentionAgentKey } from "./seat-projections";
import { state$ } from "./state";
import { threadHealthView, useHealthClock } from "./thread-health";

/**
 * The desktop's reading of the operator feed: joins the live planes (declared
 * signals, seat control state, thread health) onto the document and hands
 * them to the shared projection, with the needs only the canvas knows
 * (`feedCanvasNeeds`: stoppages, held nodes, sinks wanting input). Whether the feed is open is
 * the operator modal slot's to say (lib/operator-modal).
 */

/** Build the feed for one canvas from the live stores, read once at `nowMs`. */
export const operatorFeedFor = (
  canvasName: string,
  doc: CanvasDoc,
  signals: ReadonlyArray<AgentSignal>,
  nowMs: number,
  needs: ReadonlyArray<FeedCanvasNeed> = [],
): OperatorFeed => {
  const attentionByNodeId = new Map<string, { readonly reason: string; readonly at: number }>();
  const healthByNodeId = new Map<string, { readonly reading: ThreadHealthReading; readonly fresh: boolean }>();
  for (const node of doc.nodes) {
    if (node.ether?.entity?.kind !== "agent") continue;
    const event = seatEventForNode(node);
    if (event?.state === "attention") attentionByNodeId.set(node.id, { reason: event.reason, at: event.at });
    const view = threadHealthView(bindingIdForNode(node), nowMs);
    if (view) healthByNodeId.set(node.id, { reading: view.reading, fresh: view.freshness === "current" });
  }
  return buildOperatorFeed({
    canvasName,
    nowMs,
    seats: feedSeatsFromDoc(doc, { nameOf: nodeTitle, attentionByNodeId, healthByNodeId }),
    signals,
    canvasNeeds: needs,
  });
};

/**
 * Nodes that want input for a reason the document does not carry, and when
 * it began: a terminal that is not an agent seat whose screen wants input
 * (its seat event's time, which main stamps), and a seat with a permission
 * request pending in a live chat. A chat request has no time anyone
 * recorded: this window only knows when it heard of it, and would hear of
 * it again after a reload, so it carries none.
 */
const liveWantsInput = (nodes: ReadonlyArray<CanvasNode>): ReadonlyMap<string, number | undefined> => {
  const out = new Map<string, number | undefined>();
  for (const node of nodes) {
    const agentKey = attentionAgentKey(node);
    if (!agentKey) {
      // Agent seats in attention are the feed's own items already.
      const event = seatEventForNode(node);
      if (event?.state === "attention") out.set(node.id, event.at);
      continue;
    }
    if (chatCoarse$[agentKey].peek()?.pendingPermissionId) out.set(node.id, undefined);
  }
  return out;
};

/** The open canvas's needs that no seat declared, read from the live stores. */
const useCanvasNeeds = (): ReadonlyArray<FeedCanvasNeed> => {
  const doc = use$(state$.doc);
  const canvasName = use$(state$.canvasName);
  const actorRefs = use$(state$.actorRefs);
  const execution = use$(kernel$.execution);
  const executionRev = use$(kernel$.executionRev);
  const seatRev = use$(agentSeat$.rev);
  // One key per pending permission: the map changes only when one opens or closes.
  const permissionKey = use$(() =>
    Object.entries(chatCoarse$.get())
      .map(([agentKey, slot]) => `${agentKey}:${slot?.pendingPermissionId ?? ""}`)
      .join("|"),
  );
  return useMemo(() => {
    const context = executionGraphContextFromActorRefs(canvasName, actorRefs);
    return feedCanvasNeeds({
      doc,
      graph: executionGraphForImpact(doc, execution, context),
      nameOf: nodeTitle,
      wantsInput: liveWantsInput(doc.nodes),
    });
    // Kernel execution and seat state mutate in place; their revs carry the change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, canvasName, actorRefs, execution, executionRev, seatRev, permissionKey]);
};

/** The live feed for the open canvas. */
export const useOperatorFeed = (): OperatorFeed => {
  const canvasName = use$(state$.canvasName);
  const doc = use$(state$.doc);
  // The store mutates in place, so its identity never moves; key the list on
  // what can change about a signal (it arrives, then closes) and rebuild it
  // only then, not on every render.
  const signalsKey = use$(() =>
    Object.values(agentSignals$.get())
      .map((signal) => `${signal.signalId}:${signal.state}`)
      .join("|"),
  );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const signals = useMemo(() => Object.values(agentSignals$.peek()), [signalsKey]);
  const seatRev = use$(agentSeat$.rev);
  const awarenessRev = use$(seatAwareness$.rev);
  const needs = useCanvasNeeds();
  const now = useHealthClock();
  return useMemo(
    () => operatorFeedFor(canvasName, doc, signals, now, needs),
    // Seat and awareness stores mutate in place; their revs carry the change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canvasName, doc, signals, needs, seatRev, awarenessRev, now],
  );
};

/** Items in reading order, for j/k movement. */
export const feedItemsInOrder = (sections: ReadonlyArray<FeedSection>): ReadonlyArray<FeedItem> =>
  sections.flatMap((section) => section.items);

/** The next selection after a j/k step, clamped to the list. */
export const stepFeedSelection = (
  items: ReadonlyArray<Pick<FeedItem, "itemId">>,
  current: string | null,
  step: 1 | -1,
): string | null => {
  if (items.length === 0) return null;
  const index = current === null ? -1 : items.findIndex((item) => item.itemId === current);
  if (index === -1) return items[step === 1 ? 0 : items.length - 1]!.itemId;
  const next = Math.min(items.length - 1, Math.max(0, index + step));
  return items[next]!.itemId;
};

/**
 * Keep a selection through a feed change. When the selected item leaves
 * (answered here, answered elsewhere, dismissed, withdrawn) the selection
 * moves to its nearest neighbour that is still there, next first.
 */
export const reconcileSelection = (
  previous: ReadonlyArray<Pick<FeedItem, "itemId">>,
  current: ReadonlyArray<Pick<FeedItem, "itemId">>,
  selected: string | null,
): string | null => {
  if (selected === null) return null;
  const live = new Set(current.map((item) => item.itemId));
  if (live.has(selected)) return selected;
  const index = previous.findIndex((item) => item.itemId === selected);
  if (index === -1) return null;
  const after = previous.slice(index + 1).find((item) => live.has(item.itemId));
  if (after) return after.itemId;
  const before = previous.slice(0, index).reverse().find((item) => live.has(item.itemId));
  return before?.itemId ?? null;
};

/**
 * "3 waiting across 2 regions": the feed's status line. The number is the
 * feed's own count, the same one the top bar and the Dock badge show.
 */
export const feedStatusLine = (feed: Pick<OperatorFeed, "count" | "sections">): string => {
  if (feed.count === 0) return "nobody needs you right now";
  const regions = feed.sections.filter((section) => needsOperatorCount(section.items) > 0).length;
  return `${feed.count} waiting${regions > 1 ? ` across ${regions} regions` : ""}`;
};

/**
 * Keep items that just left on screen for a moment so they can fade out: the
 * previous sections, with each vanished item reinserted at its old place and
 * marked leaving. Pure; the surface owns the timing.
 */
export const withLeavingItems = (
  previous: ReadonlyArray<FeedSection>,
  current: ReadonlyArray<FeedSection>,
  leaving: ReadonlySet<string>,
): ReadonlyArray<FeedSection & { readonly leavingIds: ReadonlySet<string> }> => {
  const out = current.map((section) => ({ ...section, items: [...section.items], leavingIds: new Set<string>() }));
  const bySection = new Map(out.map((section) => [section.region.regionId ?? "", section] as const));
  for (const section of previous) {
    const key = section.region.regionId ?? "";
    section.items.forEach((item, index) => {
      if (!leaving.has(item.itemId)) return;
      let target = bySection.get(key);
      if (!target) {
        target = { ...section, items: [], leavingIds: new Set<string>() };
        bySection.set(key, target);
        out.push(target);
      }
      if (target.items.some((existing) => existing.itemId === item.itemId)) return;
      target.items.splice(Math.min(index, target.items.length), 0, item);
      target.leavingIds.add(item.itemId);
    });
  }
  return out;
};
