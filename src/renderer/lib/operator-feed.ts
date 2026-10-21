import { useMemo } from "react";
import { observable } from "@legendapp/state";
import { use$ } from "@legendapp/state/react";
import type { Canvas, Node } from "@shared/model";
import type { AgentSignal } from "@shared/agent-signals";
import { feedCanvasModelNeeds } from "@shared/canvas-needs";
import { executionGraphContextFromActorRefs } from "@shared/graph";
import { seatTasks$ } from "./seat-tasks";
import {
  buildOperatorFeed,
  feedSectionsInRegion,
  feedSeatsFromCanvas,
  needsOperatorCount,
  orderFeedSections,
  type FeedCanvasNeed,
  type FeedItem,
  type FeedMailWait,
  type FeedSection,
  type FeedSortOrder,
  type OperatorFeed,
} from "@shared/operator-feed";
import type { ThreadHealthReading } from "@shared/thread-health";
import type { SeatSnapshot } from "@shared/harness-domain";
import { agentSeat$, seatEventForBinding, seatStatusForBinding } from "./agent-seat-state";
import { agentSignals$ } from "./agent-signals-state";
import { executionGraphForImpact } from "./impact-mode";
import { kernel$ } from "./kernel-view";
import { mailWaiting$, mailWaitsOn } from "./mail-waiting";
import { phoneReach$, withPhoneReach } from "./phone-reach";
import { seatAwareness$ } from "./seat-awareness";
import { state$ } from "./state";
import { threadHealthView, useHealthClock } from "./thread-health";
import { useCanvas } from "./use-model";
import { useCanvasWorkItems } from "./use-work-sink";

/**
 * The desktop's reading of the operator feed: joins the live planes (declared
 * signals, seat control state and status, thread health) onto the canvas and hands
 * them to the shared projection, with the needs only the canvas knows
 * (`feedCanvasNeeds`: stoppages, held nodes, sinks wanting input), and this
 * Mac's own (lib/phone-reach). Whether the feed is open is
 * the operator modal slot's to say (lib/operator-modal).
 */

/** Build the feed for one canvas from the live stores, read once at `nowMs`. */
export const operatorFeedFor = (
  canvasName: string,
  canvas: Canvas,
  signals: ReadonlyArray<AgentSignal>,
  nowMs: number,
  needs: ReadonlyArray<FeedCanvasNeed> = [],
  mailWaitByNodeId?: ReadonlyMap<string, FeedMailWait>,
): OperatorFeed => {
  const attentionByNodeId = new Map<string, { readonly reason: string; readonly at: number }>();
  const snapshotByNodeId = new Map<string, SeatSnapshot>();
  const healthByNodeId = new Map<string, { readonly reading: ThreadHealthReading; readonly fresh: boolean }>();
  for (const node of canvas.nodes.values()) {
    if (node.kind !== "agent") continue;
    const event = seatEventForBinding(node.bindingId);
    if (event?.state === "attention") attentionByNodeId.set(node.id, { reason: event.reason, at: event.at });
    const status = seatStatusForBinding(node.bindingId);
    if (status) snapshotByNodeId.set(node.id, status.snapshot);
    const view = threadHealthView(node.bindingId, nowMs);
    if (view) healthByNodeId.set(node.id, { reading: view.reading, fresh: view.freshness === "current" });
  }
  return buildOperatorFeed({
    canvasName,
    nowMs,
    seats: feedSeatsFromCanvas(canvas, {
      attentionByNodeId,
      snapshotByNodeId,
      healthByNodeId,
      ...(mailWaitByNodeId ? { mailWaitByNodeId } : {}),
    }),
    signals,
    canvasNeeds: needs,
  });
};

/**
 * Nodes that want input for a reason the canvas does not carry, and when
 * it began: a terminal that is not an agent seat whose screen wants input
 * (its seat event's time, which main stamps).
 */
const liveWantsInput = (nodes: Iterable<Node>): ReadonlyMap<string, number | undefined> => {
  const out = new Map<string, number | undefined>();
  for (const node of nodes) {
    // Agent seats in attention are the feed's own items already.
    if (node.kind === "agent") continue;
    const bindingId = node.kind === "terminal" ? node.bindingId : agentSeat$.bindingIdByNodeId[node.id].peek();
    const event = seatEventForBinding(bindingId);
    if (event?.state === "attention") out.set(node.id, event.at);
  }
  return out;
};

/** The open canvas's needs that no seat declared, read from the live stores. */
const useCanvasNeeds = (): ReadonlyArray<FeedCanvasNeed> => {
  const canvasName = use$(state$.canvasName);
  const canvas = useCanvas(canvasName);
  const itemsOf = useCanvasWorkItems(canvasName);
  const heldBy = use$(seatTasks$.bySeat);
  const actorRefs = use$(state$.actorRefs);
  const execution = use$(kernel$.execution);
  const executionRev = use$(kernel$.executionRev);
  const seatRev = use$(agentSeat$.rev);
  return useMemo(() => {
    const context = executionGraphContextFromActorRefs(
      canvasName,
      actorRefs,
      heldBy,
    );
    return feedCanvasModelNeeds({
      canvasName,
      canvas,
      itemsOf,
      graph: executionGraphForImpact(canvas, execution, context),
      wantsInput: liveWantsInput(canvas.nodes.values()),
    });
    // Kernel execution and seat state mutate in place; their revs carry the change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvas, canvasName, actorRefs, execution, executionRev, seatRev, itemsOf, heldBy]);
};

/** The live feed for the open canvas. */
export const useOperatorFeed = (): OperatorFeed => {
  const canvasName = use$(state$.canvasName);
  const canvas = useCanvas(canvasName);
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
  // By field: the store mutates in place.
  const paired = use$(phoneReach$.paired);
  const remoteLogin = use$(phoneReach$.remoteLogin);
  // Held mail, by node. The store mutates in place too: key it on what it says.
  const waitsKey = use$(() => JSON.stringify(mailWaiting$[canvasName].get() ?? {}));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const waits = useMemo(() => mailWaitsOn(mailWaiting$.peek(), canvasName), [waitsKey, canvasName]);
  return useMemo(
    () => withPhoneReach(operatorFeedFor(canvasName, canvas, signals, now, needs, waits), { paired, remoteLogin }),
    // Seat and awareness stores mutate in place; their revs carry the change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canvasName, canvas, signals, needs, seatRev, awarenessRev, now, paired, remoteLogin, waits],
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
 * feed's own count, the same one the top bar and the Dock badge show. With a
 * region filter on, it says what is left in view against the whole feed.
 */
export const feedStatusLine = (
  feed: Pick<OperatorFeed, "count" | "sections">,
  filtered?: { readonly label: string; readonly count: number },
): string => {
  if (filtered !== undefined) {
    return `${filtered.count} of ${feed.count} waiting in ${filtered.label}`;
  }
  if (feed.count === 0) return "nobody needs you right now";
  const regions = feed.sections.filter((section) => needsOperatorCount(section.items) > 0).length;
  return `${feed.count} waiting${regions > 1 ? ` across ${regions} regions` : ""}`;
};

// --- view state -------------------------------------------------------------

/**
 * The region the operator narrowed the feed to. `regionId` null names the
 * open field. The label is a display copy kept for the option row and empty
 * state; the pick is ignored on another canvas.
 */
export type FeedRegionPick = {
  readonly canvasName: string;
  readonly regionId: string | null;
  readonly label: string;
};

/**
 * The feed's view: which region is showing and in what order. Session-lived
 * and module-scoped so it survives the modal opening and closing — triage
 * spans more than one look — without pretending to be a preference.
 */
export const feedView$ = observable<{
  region: FeedRegionPick | undefined;
  order: FeedSortOrder;
}>({ region: undefined, order: "urgency" });

/**
 * The sections an open feed shows: the picked region's, or all of them, in
 * the picked order.
 */
export const viewFeedSections = (
  sections: ReadonlyArray<FeedSection>,
  pick: FeedRegionPick | undefined,
  canvasName: string,
  order: FeedSortOrder,
): ReadonlyArray<FeedSection> =>
  orderFeedSections(
    feedSectionsInRegion(sections, pick?.canvasName === canvasName ? pick.regionId : undefined),
    order,
  );

/** A section as the open feed draws it, with the items fading out of it. */
export type ShownFeedSection = FeedSection & { readonly leavingIds: ReadonlySet<string> };

const regionKey = (section: Pick<FeedSection, "region">): string => section.region.regionId ?? "";

/**
 * `kept` in its own order, with each entry of `ranked` it lacks put where the
 * ranking puts it: just before the first entry ranked after it that is
 * already placed, or last.
 */
const holdOrder = <T>(kept: ReadonlyArray<T>, ranked: ReadonlyArray<T>, keyOf: (entry: T) => string): T[] => {
  const out = [...kept];
  const placed = new Set(out.map(keyOf));
  let after: string | undefined;
  // From the end, so new neighbours keep their ranked order between them.
  for (let index = ranked.length - 1; index >= 0; index -= 1) {
    const entry = ranked[index]!;
    const key = keyOf(entry);
    if (!placed.has(key)) {
      const at = after === undefined ? -1 : out.findIndex((placedEntry) => keyOf(placedEntry) === after);
      out.splice(at === -1 ? out.length : at, 0, entry);
      placed.add(key);
    }
    after = key;
  }
  return out;
};

/**
 * What an open feed draws after a change: `ranked` held in the order the
 * operator already sees in `shown`. A region or a card keeps its place, one
 * that is new goes where the ranking puts it, and a card in `leaving` that
 * is gone from `ranked` stays where it was, marked, so it can fade out
 * there; its region stays with it. Pure; the surface owns the timing.
 */
export const holdFeedPlaces = (
  shown: ReadonlyArray<ShownFeedSection>,
  ranked: ReadonlyArray<FeedSection>,
  leaving: ReadonlySet<string>,
): ReadonlyArray<ShownFeedSection> => {
  const live = new Set(feedItemsInOrder(ranked).map((item) => item.itemId));
  const rankedByRegion = new Map(ranked.map((section) => [regionKey(section), section] as const));
  const held = shown.flatMap((section): ShownFeedSection[] => {
    const now = rankedByRegion.get(regionKey(section));
    const nowById = new Map(now?.items.map((item) => [item.itemId, item] as const));
    const leavingIds = new Set<string>();
    const kept = section.items.flatMap((item): FeedItem[] => {
      const current = nowById.get(item.itemId);
      if (current) return [current];
      // Moved to another region: it is drawn there, not faded out here.
      if (live.has(item.itemId) || !leaving.has(item.itemId)) return [];
      leavingIds.add(item.itemId);
      return [item];
    });
    const items = holdOrder(kept, now?.items ?? [], (item) => item.itemId);
    return items.length === 0 ? [] : [{ ...(now ?? section), items, leavingIds }];
  });
  const fresh = ranked.map((section): ShownFeedSection => ({ ...section, items: [...section.items], leavingIds: new Set() }));
  return holdOrder(held, fresh, regionKey);
};
