import { useMemo } from "react";
import { use$ } from "@legendapp/state/react";
import type { CanvasDoc, CanvasNode } from "@shared/canvas";
import type { AgentSignal } from "@shared/agent-signals";
import { executionGraphContextFromActorRefs } from "@shared/graph";
import { rankStoppageSeeds, type RankedStoppage } from "@shared/impact";
import { isHarnessId } from "@shared/managed-terminal-templates";
import {
  attentionText,
  buildOperatorFeed,
  feedRegionFor,
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
import { liveAttentionReasons, notifyItem, seatFactsForNode } from "./seat-projections";
import { state$ } from "./state";
import { terminal$ } from "./terminal-state";
import { threadHealthView, useHealthClock } from "./thread-health";

/**
 * The desktop's reading of the operator feed: joins the live planes (declared
 * signals, seat control state, thread health) onto the document and hands
 * them to the shared projection, with the needs only the canvas knows
 * (stoppages, held nodes, sinks wanting input). Whether the feed is open is
 * the operator modal slot's to say (lib/operator-modal).
 */

/** A canvas need before it has a start time. */
export type CanvasNeedDraft = Omit<FeedCanvasNeed, "since">;

const holdsUp = (count: number): string =>
  count === 0 ? "stuck, clear it to go on" : count === 1 ? "holding up 1 other" : `holding up ${count} others`;

/**
 * What the canvas knows that no seat said: the stoppages that hold others
 * up, the nodes held up by their work, and the sinks and seats that want
 * input. One need per node, the stoppage first.
 */
export const canvasNeeds = (input: {
  readonly doc: CanvasDoc;
  readonly stoppages: ReadonlyArray<RankedStoppage>;
  readonly graphBlocked: ReadonlySet<string>;
  readonly needsInput: ReadonlySet<string>;
}): ReadonlyArray<CanvasNeedDraft> => {
  const byId = new Map(input.doc.nodes.map((node) => [node.id, node] as const));
  const out = new Map<string, CanvasNeedDraft>();
  const add = (nodeId: string, prefix: string, kind: CanvasNeedDraft["kind"], text: string): void => {
    if (out.has(nodeId)) return;
    const node = byId.get(nodeId);
    out.set(nodeId, {
      itemId: `${prefix}:${nodeId}`,
      kind,
      seat: { nodeId, name: node ? nodeTitle(node) : nodeId, portraitIdentity: nodeId },
      region: feedRegionFor(input.doc, nodeId),
      text,
    });
  };
  for (const stoppage of input.stoppages) {
    add(stoppage.seedNodeId, "stoppage", "blocked", holdsUp(Math.max(0, stoppage.stops - 1)));
  }
  for (const nodeId of input.graphBlocked) add(nodeId, "held", "blocked", "waiting on blocked work upstream");
  for (const nodeId of input.needsInput) add(nodeId, "input", "attention", attentionText(""));
  return [...out.values()];
};

const FIRST_SEEN_KEY = "junto.needs-you.first-seen";

type FirstSeen = Record<string, Record<string, number>>;

const readFirstSeen = (): FirstSeen => {
  try {
    const parsed: unknown = JSON.parse(globalThis.localStorage?.getItem(FIRST_SEEN_KEY) ?? "{}");
    return typeof parsed === "object" && parsed !== null ? (parsed as FirstSeen) : {};
  } catch {
    return {};
  }
};

/**
 * When each canvas need began. The work graph carries no start time, so the
 * first time this machine saw the need stands in for it. It is kept on disk
 * per canvas, so a reload does not restamp every stoppage as now, and it is
 * forgotten once the need clears.
 */
export const stampCanvasNeeds = (
  canvasName: string,
  drafts: ReadonlyArray<CanvasNeedDraft>,
  nowMs: number,
): ReadonlyArray<FeedCanvasNeed> => {
  const all = readFirstSeen();
  const before = all[canvasName] ?? {};
  const after: Record<string, number> = {};
  for (const draft of drafts) after[draft.itemId] = before[draft.itemId] ?? nowMs;
  const changed =
    Object.keys(after).length !== Object.keys(before).length ||
    Object.keys(after).some((id) => before[id] !== after[id]);
  if (changed) {
    const next = { ...all, [canvasName]: after };
    if (drafts.length === 0) delete next[canvasName];
    try {
      globalThis.localStorage?.setItem(FIRST_SEEN_KEY, JSON.stringify(next));
    } catch {
      // No storage (a test, a locked profile): the time holds for this window only.
    }
  }
  return drafts.map((draft) => ({ ...draft, since: after[draft.itemId]! }));
};

const managedSeat = (node: CanvasNode): boolean => {
  const harness = node.ether?.terminal?.harness;
  return typeof harness === "string" && isHarnessId(harness);
};

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

/** The open canvas's needs that no seat declared, read from the live stores. */
const useCanvasNeeds = (): ReadonlyArray<FeedCanvasNeed> => {
  const doc = use$(state$.doc);
  const canvasName = use$(state$.canvasName);
  const actorRefs = use$(state$.actorRefs);
  const execution = use$(kernel$.execution);
  const executionRev = use$(kernel$.executionRev);
  const seatRev = use$(agentSeat$.rev);
  const chatByAgent = use$(chatCoarse$) as
    | Readonly<Record<string, { readonly pendingPermissionId?: string } | undefined>>
    | undefined;
  return useMemo(() => {
    const context = executionGraphContextFromActorRefs(canvasName, actorRefs);
    const graph = executionGraphForImpact(doc, execution, context);
    const graphBlocked = new Set<string>();
    const needsInput = new Set<string>();
    for (const node of doc.nodes) {
      const bindingId = bindingIdForNode(node);
      const facts = seatFactsForNode({
        nodeId: node.id,
        seatEvent: seatEventForNode(node),
        session: bindingId ? terminal$.sessionByBindingId[bindingId].peek() : undefined,
        graphBlocked: graph.blocked.has(node.id),
        attentionReasons: liveAttentionReasons(node, chatByAgent),
        managedSeat: managedSeat(node),
      });
      const kind = notifyItem(facts);
      if (kind === "blocked") graphBlocked.add(node.id);
      else if (kind === "attention") needsInput.add(node.id);
    }
    const drafts = canvasNeeds({ doc, stoppages: rankStoppageSeeds(doc, graph), graphBlocked, needsInput });
    return stampCanvasNeeds(canvasName, drafts, Date.now());
    // Kernel execution and seat state mutate in place; their revs carry the change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, canvasName, actorRefs, execution, executionRev, seatRev, chatByAgent]);
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
