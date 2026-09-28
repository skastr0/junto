import type { CanvasNode } from "@shared/canvas";
import { factoryPause$ } from "./factory-pause";
import {
  multiPromptAgents,
  multiPromptTargetsFromNodes,
  type MultiPromptOps,
  type MultiPromptResult,
  type MultiPromptTarget,
} from "./multi-prompt";
import { agentCountLabel, isAgentSeatNode } from "./multi-selection";
import { nodeTitle } from "./presentation";
import { state$ } from "./state";

/**
 * The operator messages agent seats straight from the canvas: one seat from
 * its toolbar, or every agent in a selection. The text goes out as operator
 * prompt mail on the one delivery path all mail takes (terminalManagedPrompt,
 * via multiPromptAgents): typed into the seat at once when it is up, and when
 * it is down the seat is started and gets it once it is ready. Nothing here
 * writes anywhere else.
 */

export type SeatMessagePlan = {
  /** Agents that can receive: each has a managed terminal. */
  readonly targets: ReadonlyArray<MultiPromptTarget>;
  /** Agents in the selection that have no terminal to type into. */
  readonly unreachable: number;
  /** What the operator reads for each seat: its name on the canvas. */
  readonly names: ReadonlyMap<string, string>;
};

export const planSeatMessage = (nodes: ReadonlyArray<CanvasNode>): SeatMessagePlan => {
  const agents = [...new Map(nodes.map((node) => [node.id, node])).values()].filter(isAgentSeatNode);
  const targets = multiPromptTargetsFromNodes(agents);
  return {
    targets,
    unreachable: agents.length - targets.length,
    names: new Map(agents.map((node) => [node.id, nodeTitle(node)])),
  };
};

/** The seats the operator is about to message, read fresh off the document. */
export const planSeatMessageFor = (nodeIds: ReadonlyArray<string>): SeatMessagePlan => {
  const wanted = new Set(nodeIds);
  return planSeatMessage(state$.doc.peek().nodes.filter((node) => wanted.has(node.id)));
};

/** Composer heading: "Message Cursor Agent", or "Message 3 agents". */
export const seatMessageTitle = (plan: SeatMessagePlan): string => {
  const only = plan.targets.length === 1 && plan.unreachable === 0 ? plan.targets[0] : undefined;
  if (only) return `Message ${plan.names.get(only.nodeId) ?? "agent"}`;
  return `Message ${agentCountLabel(plan.targets.length)}`;
};

/** Composer subline when not every agent can take it; empty when all can. */
export const seatMessageReach = (plan: SeatMessagePlan): string => {
  if (plan.unreachable === 0) return "";
  const total = plan.targets.length + plan.unreachable;
  if (plan.targets.length === 0) {
    return total === 1 ? "This agent has no terminal to receive it." : "None of these agents has a terminal to receive it.";
  }
  return `${plan.unreachable} of ${agentCountLabel(total)} ha${plan.unreachable === 1 ? "s" : "ve"} no terminal and will not get it.`;
};

export type SeatMessageTone = "sent" | "queued" | "failed";

export type SeatMessageOutcome = {
  /** failed beats queued beats sent: the line leads with what needs a look. */
  readonly tone: SeatMessageTone;
  readonly line: string;
  /** Keep the draft so the operator can retry without retyping. */
  readonly keepDraft: boolean;
};

const nameList = (plan: SeatMessagePlan, nodeIds: ReadonlyArray<string>): string =>
  [...new Set(nodeIds.map((id) => plan.names.get(id) ?? id))].join(", ");

/**
 * One line for the operator after a send. "Queued" says when the seat will
 * get it: when it is up, or when the operator presses play on a paused canvas.
 */
export const seatMessageOutcome = (
  plan: SeatMessagePlan,
  result: MultiPromptResult,
  playing: boolean,
): SeatMessageOutcome => {
  const whenUp = playing ? "as soon as it is up" : "when you press play";
  const whenUpMany = playing ? "as soon as they are up" : "when you press play";
  const single = plan.targets.length === 1;
  const queuedIds = result.queued.map((note) => note.nodeId);
  const failedIds = result.failed.map((note) => note.nodeId);

  if (single) {
    const name = plan.names.get(plan.targets[0]!.nodeId) ?? "the agent";
    if (result.failed.length > 0) {
      const why = result.failed[0]?.error;
      return { tone: "failed", line: `Not sent to ${name}${why ? `: ${why}` : "."}`, keepDraft: true };
    }
    if (result.queued.length > 0) {
      return { tone: "queued", line: `Queued. ${name} gets it ${whenUp}.`, keepDraft: false };
    }
    return { tone: "sent", line: `Sent to ${name}.`, keepDraft: false };
  }

  const parts: string[] = [];
  if (result.sent > 0) parts.push(`Sent to ${agentCountLabel(result.sent)}.`);
  if (queuedIds.length > 0) {
    parts.push(
      queuedIds.length === 1
        ? `Queued for ${nameList(plan, queuedIds)}, who gets it ${whenUp}.`
        : `Queued for ${nameList(plan, queuedIds)}, who get it ${whenUpMany}.`,
    );
  }
  if (failedIds.length > 0) parts.push(`Not sent to ${nameList(plan, failedIds)}.`);
  const tone: SeatMessageTone = failedIds.length > 0 ? "failed" : queuedIds.length > 0 ? "queued" : "sent";
  return { tone, line: parts.join(" "), keepDraft: failedIds.length > 0 };
};

/** Send one message to every seat in the plan. Never throws. */
export async function sendSeatMessage(
  plan: SeatMessagePlan,
  text: string,
  ops?: MultiPromptOps,
): Promise<SeatMessageOutcome> {
  // A message is a reason to run the session: a down seat is started for it.
  const result = await multiPromptAgents(plan.targets, text, ops, { wake: true });
  return seatMessageOutcome(plan, result, factoryPause$.state.peek()?.playing ?? true);
}
