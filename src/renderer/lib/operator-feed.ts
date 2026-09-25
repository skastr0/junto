import { useMemo } from "react";
import { observable } from "@legendapp/state";
import { use$ } from "@legendapp/state/react";
import type { CanvasDoc } from "@shared/canvas";
import type { AgentSignal } from "@shared/agent-signals";
import {
  buildOperatorFeed,
  feedSeatsFromDoc,
  type FeedItem,
  type FeedSection,
  type OperatorFeed,
} from "@shared/operator-feed";
import type { ThreadHealthReading } from "@shared/thread-health";
import { agentSeat$, bindingIdForNode, seatEventForNode } from "./agent-seat-state";
import { agentSignals$ } from "./agent-signals-state";
import { nodeTitle } from "./presentation";
import { seatAwareness$ } from "./seat-awareness";
import { state$ } from "./state";
import { threadHealthView, useHealthClock } from "./thread-health";

/**
 * The desktop's reading of the operator feed: joins the live planes (declared
 * signals, seat control state, thread health) onto the document and hands
 * them to the shared projection. Also owns whether the feed surface is open.
 */

export const operatorFeed$ = observable({ open: false });

export const openOperatorFeed = (): void => operatorFeed$.open.set(true);
export const closeOperatorFeed = (): void => operatorFeed$.open.set(false);
export const toggleOperatorFeed = (): void => operatorFeed$.open.set(!operatorFeed$.open.peek());

/** Build the feed for one canvas from the live stores, read once at `nowMs`. */
export const operatorFeedFor = (
  canvasName: string,
  doc: CanvasDoc,
  signals: ReadonlyArray<AgentSignal>,
  nowMs: number,
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
  });
};

/** The live feed for the open canvas. */
export const useOperatorFeed = (): OperatorFeed => {
  const canvasName = use$(state$.canvasName);
  const doc = use$(state$.doc);
  // A fresh list on every change: the store mutates in place, so its own
  // identity would never move the memo below.
  const signals = use$(() => Object.values(agentSignals$.get()));
  const seatRev = use$(agentSeat$.rev);
  const awarenessRev = use$(seatAwareness$.rev);
  const now = useHealthClock();
  return useMemo(
    () => operatorFeedFor(canvasName, doc, signals, now),
    // Seat and awareness stores mutate in place; their revs carry the change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canvasName, doc, signals, seatRev, awarenessRev, now],
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

/** "3 waiting across 2 regions" — the feed's status line. */
export const feedStatusLine = (feed: Pick<OperatorFeed, "count" | "sections">): string => {
  if (feed.count === 0) return "nobody needs you right now";
  const regions = feed.sections.length;
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
