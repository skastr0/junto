import type { CanvasDoc } from "@shared/canvas";
import type { ActorSeatId } from "@shared/actor-seat";
import type {
  Message,
  Task,
  TaskProposalState,
  TaskState,
} from "@shared/work-model";
import type { ActorRef } from "@shared/work-protocol";
import { taskBrief } from "@shared/task";
import { claimedTaskForActorNode } from "./claimed-task";

/**
 * Pure projections of an actor's work-kernel standing for ledger-style UI:
 * the task it currently holds, the proposals it raised, and the requests
 * (escalations) it raised. Everything derives from the canvas doc — no IPC.
 * Total and defensive: missing ether containers yield empty results.
 */

export type ClaimedTaskRow = {
  readonly taskId: string;
  readonly sinkNodeId: string;
  readonly state: TaskState;
  readonly title: string;
  readonly needsInput: boolean;
};

export type ProposalRow = {
  readonly proposalId: string;
  readonly sinkNodeId: string;
  readonly state: TaskProposalState;
  readonly title: string;
  readonly reason?: string;
};

export type RequestRow = {
  readonly requestId: string;
  readonly sinkNodeId: string;
  readonly state: TaskState;
  readonly title: string;
  readonly needsInput: boolean;
  readonly response?: string;
};

/** First non-empty text line across a message's parts. */
const firstTextLine = (message: Message | undefined): string | undefined => {
  for (const part of message?.parts ?? []) {
    if (part.kind === "text") {
      const line = part.text.split("\n")[0]?.trim();
      if (line) return line;
    }
  }
  return undefined;
};

/** taskBrief falls back to the task id when the brief has no text; map that to the fallback. */
const taskTitle = (task: Task, fallback: string): string => {
  const line = taskBrief(task).split(/\r?\n/, 1)[0]?.trim();
  return line === undefined || line === "" || line === task.id ? fallback : line;
};

const metadataTitle = (task: Task): string | undefined => {
  const value = task.metadata?.["title"];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

/** Seat identity for an actor node from the compiled seat projection. */
export const seatIdForActorNode = (
  actorRefs: ReadonlyArray<ActorRef>,
  nodeId: string,
): ActorSeatId | undefined =>
  actorRefs.find((candidate) => candidate.nodeId === nodeId)?.seatId;

/** The one active task an actor node holds, shaped for a ledger row. */
export const claimedTaskRow = (
  doc: CanvasDoc,
  actorRefs: ReadonlyArray<ActorRef>,
  nodeId: string,
): ClaimedTaskRow | undefined => {
  const claimed = claimedTaskForActorNode(doc, actorRefs, nodeId);
  if (claimed === undefined) return undefined;
  return {
    taskId: claimed.task.id,
    sinkNodeId: claimed.sinkNodeId,
    state: claimed.task.state,
    title: taskTitle(claimed.task, "Untitled task"),
    needsInput: claimed.task.state === "input-required",
  };
};

/** Pending first, then newest first (ULID ids sort by birth order). */
const compareProposalRows = (a: ProposalRow, b: ProposalRow): number => {
  const pendingRank = (row: ProposalRow): number =>
    row.state === "pending" ? 0 : 1;
  const byPending = pendingRank(a) - pendingRank(b);
  if (byPending !== 0) return byPending;
  return b.proposalId.localeCompare(a.proposalId);
};

/** Proposals this seat raised, across every tasks sink in the doc. */
export const proposalRowsForSeat = (
  doc: CanvasDoc,
  seatId: ActorSeatId,
): ReadonlyArray<ProposalRow> => {
  const rows: ProposalRow[] = [];
  for (const node of doc.nodes) {
    for (const proposal of node.ether?.tasks?.proposals ?? []) {
      if (proposal.proposedBy?.seatId !== seatId) continue;
      rows.push({
        proposalId: proposal.id,
        sinkNodeId: node.id,
        state: proposal.state,
        title: firstTextLine(proposal.brief) ?? "Untitled proposal",
        ...(proposal.reason !== undefined ? { reason: proposal.reason } : {}),
      });
    }
  }
  return rows.sort(compareProposalRows);
};

/** Needs-input first, then newest first (ULID ids sort by birth order). */
const compareRequestRows = (a: RequestRow, b: RequestRow): number => {
  const inputRank = (row: RequestRow): number => (row.needsInput ? 0 : 1);
  const byInput = inputRank(a) - inputRank(b);
  if (byInput !== 0) return byInput;
  return b.requestId.localeCompare(a.requestId);
};

/**
 * Requests (escalations) this seat raised, across every requests sink in the
 * doc. A request's claimedBy is the raiser's seat — that is the "raised by"
 * identity, including on resolved requests.
 */
export const requestRowsForSeat = (
  doc: CanvasDoc,
  seatId: ActorSeatId,
): ReadonlyArray<RequestRow> => {
  const rows: RequestRow[] = [];
  for (const node of doc.nodes) {
    for (const request of node.ether?.requests?.items ?? []) {
      if (request.claimedBy !== seatId) continue;
      rows.push({
        requestId: request.id,
        sinkNodeId: node.id,
        state: request.state,
        title: metadataTitle(request) ?? taskTitle(request, "Untitled request"),
        needsInput: request.state === "input-required",
        ...(request.response !== undefined ? { response: request.response } : {}),
      });
    }
  }
  return rows.sort(compareRequestRows);
};
