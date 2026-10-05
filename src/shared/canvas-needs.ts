import type { CanvasDoc, CanvasNode } from "./canvas";
import { needsHuman } from "./attention";
import { earliestStateSince, type ExecutionGraph } from "./execution-graph";
import { rankStoppageSeeds } from "./impact";
import { attentionText, feedRegionFor, type FeedCanvasNeed } from "./operator-feed";

/**
 * What the canvas knows that no seat said, as needs for the operator feed:
 * the stoppages that hold others up, the nodes held up by their work, and the
 * sinks and seats that want input. One need per node, the stoppage first.
 *
 * Pure over the document and its execution graph, so the desktop and the
 * companion backend count the same needs. Every time is the true one: a stop
 * began when its reason says (`BlockedReason.since`), a sink has wanted input
 * since its earliest waiting item entered that state (`Task.stateSince`).
 * Where no time is known the need carries none; one is never made up.
 */

const holdsUp = (count: number): string =>
  count === 0 ? "stuck, clear it to go on" : count === 1 ? "holding up 1 other" : `holding up ${count} others`;

const waitingItems = (node: CanvasNode) => {
  const kind = node.ether?.entity?.kind;
  const items = kind === "task" ? node.ether?.tasks?.items : kind === "requests" ? node.ether?.requests?.items : undefined;
  return (items ?? []).filter(needsHuman);
};

const earlier = (a: number | undefined, b: number | undefined): number | undefined =>
  a === undefined ? b : b === undefined ? a : Math.min(a, b);

export const feedCanvasNeeds = (input: {
  readonly doc: CanvasDoc;
  readonly graph: ExecutionGraph;
  readonly nameOf: (node: CanvasNode) => string;
  /**
   * Nodes that want input for a reason the document does not carry, with the
   * epoch ms it began, or undefined when that is not known.
   */
  readonly wantsInput?: ReadonlyMap<string, number | undefined>;
}): ReadonlyArray<FeedCanvasNeed> => {
  const { doc, graph } = input;
  const byId = new Map(doc.nodes.map((node) => [node.id, node] as const));

  // When each stop began, for the stopped node and for the sink that causes it.
  const stoppedSince = new Map<string, number | undefined>();
  const causeSince = new Map<string, number | undefined>();
  for (const [nodeId, reasons] of graph.reasonsByNodeId) {
    for (const reason of reasons) {
      stoppedSince.set(nodeId, earlier(stoppedSince.get(nodeId), reason.since));
      if (reason.kind === "edge") causeSince.set(reason.fromNodeId, earlier(causeSince.get(reason.fromNodeId), reason.since));
    }
  }

  const out = new Map<string, FeedCanvasNeed>();
  const add = (
    nodeId: string,
    prefix: string,
    kind: FeedCanvasNeed["kind"],
    text: string,
    since: number | undefined,
  ): void => {
    if (out.has(nodeId)) return;
    const node = byId.get(nodeId);
    out.set(nodeId, {
      itemId: `${prefix}:${nodeId}`,
      kind,
      seat: { nodeId, name: node ? input.nameOf(node) : nodeId, portraitIdentity: nodeId },
      region: feedRegionFor(doc, nodeId),
      text,
      ...(since === undefined ? {} : { since }),
    });
  };

  for (const stoppage of rankStoppageSeeds(doc, graph)) {
    add(stoppage.seedNodeId, "stoppage", "blocked", holdsUp(Math.max(0, stoppage.stops - 1)), causeSince.get(stoppage.seedNodeId));
  }
  for (const node of doc.nodes) {
    if (graph.blocked.has(node.id)) add(node.id, "held", "blocked", "waiting on blocked work upstream", stoppedSince.get(node.id));
  }
  for (const node of doc.nodes) {
    const waiting = waitingItems(node);
    if (waiting.length > 0) add(node.id, "input", "attention", attentionText(""), earliestStateSince(waiting));
  }
  for (const [nodeId, since] of input.wantsInput ?? []) add(nodeId, "input", "attention", attentionText(""), since);
  return [...out.values()];
};
