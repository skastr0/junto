import { useMemo, useRef } from "react";
import { use$ } from "@legendapp/state/react";
import type { CanvasDoc, CanvasNode } from "@shared/canvas";
import { executionGraphContextFromActorRefs } from "@shared/graph";
import { rankStoppageSeeds, type RankedStoppage } from "@shared/impact";
import { isHarnessId } from "@shared/managed-terminal-templates";
import type { FeedItem, FeedItemKind, OperatorFeed } from "@shared/operator-feed";
import { agentSeat$, bindingIdForNode, seatEventForNode } from "./agent-seat-state";
import { chatCoarse$ } from "./chat-state";
import { executionGraphForImpact } from "./impact-mode";
import { kernel$ } from "./kernel-view";
import { feedItemsInOrder, useOperatorFeed } from "./operator-feed";
import { nodeTitle } from "./presentation";
import { liveAttentionReasons, notifyItem, seatFactsForNode } from "./seat-projections";
import { state$ } from "./state";
import { terminal$ } from "./terminal-state";

/**
 * The top-right inbox: everything that needs the operator, as one list of
 * notifications, newest first. The operator feed (declared signals, a seat's
 * screen wanting input, an AI reading of waiting) is the spine; the canvas
 * adds what only it knows: nodes held up by their work graph, a pending
 * permission on a node the feed does not cover, and the stoppages that hold
 * others up.
 */

export type NeedsYouKind = "blocked" | "needs_input" | "escalation" | "review" | "waiting";

export type NeedsYouEntry = {
  readonly id: string;
  readonly nodeId: string;
  readonly kind: NeedsYouKind;
  readonly name: string;
  readonly text: string;
  /** Epoch ms the need began, or when this window first saw it. */
  readonly since: number;
  /** Set for agent seats: the portrait to draw. */
  readonly portraitIdentity?: string;
};

export const NEEDS_YOU_LABEL: Readonly<Record<NeedsYouKind, string>> = {
  blocked: "blocked",
  needs_input: "needs input",
  escalation: "escalation",
  review: "review requested",
  waiting: "waiting on you",
};

const FROM_FEED: Readonly<Record<FeedItemKind, NeedsYouKind>> = {
  blocked: "blocked",
  attention: "needs_input",
  escalate: "escalation",
  feedback: "review",
  health: "waiting",
};

const RANK: Readonly<Record<NeedsYouKind, number>> = {
  blocked: 5,
  needs_input: 4,
  escalation: 3,
  review: 2,
  waiting: 1,
};

/** A canvas-only need, before it has a first-seen time. */
export type CanvasNeed = Omit<NeedsYouEntry, "since">;

const fromFeed = (item: FeedItem): NeedsYouEntry => ({
  id: item.itemId,
  nodeId: item.seat.nodeId,
  kind: FROM_FEED[item.kind],
  name: item.seat.name,
  text: item.text,
  since: item.since,
  portraitIdentity: item.seat.portraitIdentity,
});

const holdsUp = (count: number): string =>
  count === 0 ? "stuck, clear it to go on" : count === 1 ? "holding up 1 other" : `holding up ${count} others`;

/**
 * What the canvas adds beyond the feed: stoppage seeds, nodes held up by
 * their work, and needs-input on nodes the feed does not list.
 */
export const canvasNeeds = (input: {
  readonly doc: CanvasDoc;
  readonly stoppages: ReadonlyArray<RankedStoppage>;
  readonly graphBlocked: ReadonlySet<string>;
  readonly needsInput: ReadonlySet<string>;
}): ReadonlyArray<CanvasNeed> => {
  const byId = new Map(input.doc.nodes.map((node) => [node.id, node] as const));
  const out = new Map<string, CanvasNeed>();
  const describe = (node: CanvasNode | undefined, nodeId: string) => ({
    name: node ? nodeTitle(node) : nodeId,
    ...(node?.ether?.entity?.kind === "agent" ? { portraitIdentity: node.id } : {}),
  });
  for (const stoppage of input.stoppages) {
    const node = byId.get(stoppage.seedNodeId);
    out.set(stoppage.seedNodeId, {
      id: `stoppage:${stoppage.seedNodeId}`,
      nodeId: stoppage.seedNodeId,
      kind: "blocked",
      ...describe(node, stoppage.seedNodeId),
      text: holdsUp(Math.max(0, stoppage.stops - 1)),
    });
  }
  for (const nodeId of input.graphBlocked) {
    if (out.has(nodeId)) continue;
    out.set(nodeId, {
      id: `held:${nodeId}`,
      nodeId,
      kind: "blocked",
      ...describe(byId.get(nodeId), nodeId),
      text: "waiting on blocked work upstream",
    });
  }
  for (const nodeId of input.needsInput) {
    if (out.has(nodeId)) continue;
    out.set(nodeId, {
      id: `input:${nodeId}`,
      nodeId,
      kind: "needs_input",
      ...describe(byId.get(nodeId), nodeId),
      text: "wants your input",
    });
  }
  return [...out.values()];
};

/**
 * Join the feed and the canvas needs into one list, newest first. Every feed
 * item is its own notification (a seat that asked twice shows twice); a
 * canvas need joins only when the feed has nothing as urgent for that node,
 * since the feed carries the agent's own sentence.
 */
export const needsYouEntries = (
  feed: ReadonlyArray<FeedItem>,
  canvas: ReadonlyArray<CanvasNeed>,
  firstSeen: (id: string) => number,
): ReadonlyArray<NeedsYouEntry> => {
  const entries = feed.map(fromFeed);
  const worst = new Map<string, number>();
  for (const entry of entries) worst.set(entry.nodeId, Math.max(worst.get(entry.nodeId) ?? 0, RANK[entry.kind]));
  for (const need of canvas) {
    if ((worst.get(need.nodeId) ?? 0) >= RANK[need.kind]) continue;
    entries.push({ ...need, since: firstSeen(need.id) });
  }
  return entries.sort((a, b) => b.since - a.since || RANK[b.kind] - RANK[a.kind] || a.id.localeCompare(b.id));
};

const managedSeat = (node: CanvasNode): boolean => {
  const harness = node.ether?.terminal?.harness;
  return typeof harness === "string" && isHarnessId(harness);
};

/** The live inbox for the open canvas, and the feed it is built on. */
export const useNeedsYou = (): { readonly entries: ReadonlyArray<NeedsYouEntry>; readonly feed: OperatorFeed } => {
  const feed = useOperatorFeed();
  const doc = use$(state$.doc);
  const canvasName = use$(state$.canvasName);
  const actorRefs = use$(state$.actorRefs);
  const execution = use$(kernel$.execution);
  const executionRev = use$(kernel$.executionRev);
  const seatRev = use$(agentSeat$.rev);
  const chatByAgent = use$(chatCoarse$) as
    | Readonly<Record<string, { readonly pendingPermissionId?: string } | undefined>>
    | undefined;

  const canvas = useMemo(() => {
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
    return canvasNeeds({ doc, stoppages: rankStoppageSeeds(doc, graph), graphBlocked, needsInput });
    // Kernel execution and seat state mutate in place; their revs carry the change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, canvasName, actorRefs, execution, executionRev, seatRev, chatByAgent]);

  // Canvas needs carry no start time; the first time this window saw one
  // stands in, and is forgotten once the need clears.
  const seen = useRef(new Map<string, number>());
  const entries = useMemo(() => {
    const now = Date.now();
    const live = new Set(canvas.map((need) => need.id));
    for (const id of seen.current.keys()) if (!live.has(id)) seen.current.delete(id);
    const firstSeen = (id: string): number => {
      const at = seen.current.get(id) ?? now;
      seen.current.set(id, at);
      return at;
    };
    return needsYouEntries(feedItemsInOrder(feed.sections), canvas, firstSeen);
  }, [feed, canvas]);

  return { entries, feed };
};
