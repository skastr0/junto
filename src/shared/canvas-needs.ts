import { asNodeId, inPaintOrder, type Canvas, type Node } from "./model";
import { titleOf } from "./model/title";
import type { WorkItemsOf } from "./execution-graph";
import { earliestStateSince, type ExecutionGraph } from "./execution-graph";
import { rankStoppageSeeds } from "./impact";
import { attentionText, feedRegionForCanvas, type FeedCanvasNeed } from "./operator-feed";
import type { TaskView } from "./task-model";

/**
 * What the canvas knows that no seat said, as needs for the operator feed:
 * the stoppages that hold others up, the nodes held up by their work, and the
 * sinks and seats that want input. One need per node, the stoppage first.
 *
 * Pure over the canvas and its execution graph, so the desktop and the
 * companion backend count the same needs. Every time is the true one: a stop
 * began when its reason says (`BlockedReason.since`), a sink has wanted input
 * since its earliest waiting task entered that state (`TaskView.stateSince`).
 * Where no time is known the need carries none; one is never made up.
 */

const holdsUp = (count: number): string =>
  count === 0 ? "stuck, clear it to go on" : count === 1 ? "holding up 1 other" : `holding up ${count} others`;

const earlier = (a: number | undefined, b: number | undefined): number | undefined =>
  a === undefined ? b : b === undefined ? a : Math.min(a, b);

/** How much of a task's title a card's sentence carries before it is cut. */
const TASK_TITLE_MAX = 60;

/** "#42 fix tabs", or undefined while a create still waits for its number. */
const taskNamed = (task: TaskView): string | undefined => {
  if (task.number === undefined) return undefined;
  const title = task.title.trim().replace(/\s+/gu, " ");
  const short = title.length > TASK_TITLE_MAX ? `${title.slice(0, TASK_TITLE_MAX - 1).trimEnd()}…` : title;
  return short === "" ? `#${task.number}` : `#${task.number} ${short}`;
};

/**
 * "wants your input", naming the task that has waited longest: its number is
 * what the feed reads as a chip that opens it (task 378). The words stay
 * plain, so a surface that cannot open a task still reads a sentence, and a
 * task still waiting for its number leaves the sentence as it was.
 */
const inputText = (waiting: ReadonlyArray<TaskView>): string => {
  const first = [...waiting].sort((a, b) => a.stateSince - b.stateSince)[0];
  const named = first === undefined ? undefined : taskNamed(first);
  if (named === undefined) return attentionText("");
  const more = waiting.length - 1;
  return more === 0 ? `${named} wants your input` : `${named} and ${more} more want your input`;
};

export const feedCanvasModelNeeds = (input: {
  readonly canvasName: string;
  readonly canvas: Canvas;
  readonly itemsOf: WorkItemsOf;
  readonly graph: ExecutionGraph;
  readonly nameOf?: (node: Node) => string;
  /**
   * Nodes that want input for a reason the document does not carry, with the
   * epoch ms it began, or undefined when that is not known.
   */
  readonly wantsInput?: ReadonlyMap<string, number | undefined>;
}): ReadonlyArray<FeedCanvasNeed> => {
  const { canvas, graph, itemsOf } = input;
  const nodes = inPaintOrder(canvas);
  const byId = canvas.nodes;

  // When each stop began, for the stopped node and for the sink that causes it.
  const stoppedSince = new Map<string, number | undefined>();
  const causeSince = new Map<string, number | undefined>();
  for (const [nodeId, reasons] of graph.reasonsByNodeId) {
    for (const reason of reasons) {
      stoppedSince.set(nodeId, earlier(stoppedSince.get(nodeId), reason.since));
      causeSince.set(reason.taskNodeId, earlier(causeSince.get(reason.taskNodeId), reason.since));
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
    const node = byId.get(asNodeId(nodeId));
    out.set(nodeId, {
      itemId: `${prefix}:${nodeId}`,
      kind,
      seat: { nodeId, name: node ? (input.nameOf ?? titleOf)(node) : nodeId, portraitIdentity: nodeId },
      region: feedRegionForCanvas(canvas, nodeId),
      text,
      ...(since === undefined ? {} : { since }),
    });
  };

  for (const stoppage of rankStoppageSeeds(canvas, graph)) {
    add(stoppage.seedNodeId, "stoppage", "blocked", holdsUp(Math.max(0, stoppage.stops - 1)), causeSince.get(stoppage.seedNodeId));
  }
  for (const node of nodes) {
    if (graph.blocked.has(node.id)) add(node.id, "held", "blocked", "waiting on blocked work upstream", stoppedSince.get(node.id));
  }
  for (const node of nodes) {
    const waiting = (node.kind === "task" ? itemsOf(node.id) : []).filter((task) => task.current.state === "input-required");
    if (waiting.length > 0) add(node.id, "input", "attention", inputText(waiting), earliestStateSince(waiting));
  }
  for (const [nodeId, since] of input.wantsInput ?? []) add(nodeId, "input", "attention", attentionText(""), since);
  return [...out.values()];
};
