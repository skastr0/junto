import type { CanvasDoc } from "@shared/canvas";
import type { ActorSeatId } from "@shared/actor-seat";
import type {
  Message,
  Part,
  Task,
  TaskProposalState,
  TaskState,
} from "@shared/work-model";
import type { ActorRef } from "@shared/work-protocol";
import { taskAdmissionState } from "@shared/claims";
import { taskBrief } from "@shared/task";
import { isArtifactArchived } from "@shared/work";
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
  /** Full brief text — the decision contract shown before approve/reject. */
  readonly details?: string;
  readonly dependsOnCount: number;
  readonly hasFinishCriteria: boolean;
};

export type RequestRow = {
  readonly requestId: string;
  readonly sinkNodeId: string;
  readonly state: TaskState;
  readonly title: string;
  readonly needsInput: boolean;
  readonly response?: string;
  /** Full request text — the decision contract shown before resolve/reject. */
  readonly details?: string;
};

export type BoardTopicRow = {
  readonly sinkNodeId: string;
  readonly topicId: string;
  readonly title: string;
  readonly open: boolean;
  readonly postCount: number;
  readonly lastActivityAtMs: number | undefined;
  readonly authorLabel?: string;
};

export type BoardRow = {
  readonly sinkNodeId: string;
  /** Operator-local unread topic count when the projection knows it. */
  readonly unread: number | undefined;
  readonly topics: ReadonlyArray<BoardTopicRow>;
};

export type ArtifactRow = {
  readonly artifactId: string;
  readonly sinkNodeId: string;
  readonly name: string;
  readonly partCount: number;
  /** First text part, clipped by the caller for display. */
  readonly textPreview: string | undefined;
  readonly archived: boolean;
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

/** All text across a message's parts (the full decision contract). */
const fullText = (message: Message | undefined): string | undefined => {
  const text = (message?.parts ?? [])
    .filter((part): part is Extract<Part, { kind: "text" }> => part.kind === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
  return text || undefined;
};

/** Full text only when it says more than the already-shown title. */
const detailsBeyondTitle = (
  text: string | undefined,
  title: string,
): string | undefined =>
  text !== undefined && text !== title ? text : undefined;

/** taskBrief falls back to the task id when the brief has no text; map that to the fallback. */
const taskTitle = (task: Task, fallback: string): string => {
  const line = taskBrief(task).split(/\r?\n/, 1)[0]?.trim();
  return line === undefined || line === "" || line === task.id ? fallback : line;
};

const metadataText = (task: Task, key: string): string | undefined => {
  const value = task.metadata?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
};

const metadataTitle = (task: Task): string | undefined => metadataText(task, "title");

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
      const title = firstTextLine(proposal.brief) ?? "Untitled proposal";
      const details = detailsBeyondTitle(fullText(proposal.brief), title);
      rows.push({
        proposalId: proposal.id,
        sinkNodeId: node.id,
        state: proposal.state,
        title,
        ...(proposal.reason !== undefined ? { reason: proposal.reason } : {}),
        ...(details !== undefined ? { details } : {}),
        dependsOnCount: proposal.dependsOn?.length ?? 0,
        hasFinishCriteria: proposal.finishCriteria !== undefined,
      });
    }
    const contract = node.ether?.tasks?.contract;
    const seen = new Set(rows.map((row) => `${row.sinkNodeId}:${row.proposalId}`));
    for (const task of node.ether?.tasks?.items ?? []) {
      if (task.raisedBy?.seatId !== seatId) continue;
      if (task.state !== "submitted") continue;
      const admission = taskAdmissionState(task, contract, Date.now());
      if (admission !== "operator-gated" && admission !== "operator-owned") continue;
      const key = `${node.id}:${task.id}`;
      if (seen.has(key)) continue;
      const title = taskBrief(task) || "Untitled proposal";
      const details =
        typeof task.metadata?.details === "string" ? task.metadata.details : undefined;
      rows.push({
        proposalId: task.id,
        sinkNodeId: node.id,
        state: "pending",
        title,
        ...(task.reason !== undefined ? { reason: task.reason } : {}),
        ...(details !== undefined ? { details } : {}),
        dependsOnCount: task.dependsOn?.length ?? 0,
        hasFinishCriteria: task.finishCriteria !== undefined,
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
      const title = metadataTitle(request) ?? taskTitle(request, "Untitled request");
      const details =
        metadataText(request, "details") ??
        detailsBeyondTitle(fullText(request.history[0]), title);
      rows.push({
        requestId: request.id,
        sinkNodeId: node.id,
        state: request.state,
        title,
        needsInput: request.state === "input-required",
        ...(request.response !== undefined ? { response: request.response } : {}),
        ...(details !== undefined ? { details } : {}),
      });
    }
  }
  return rows.sort(compareRequestRows);
};

const isoMs = (value: string): number | undefined => {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
};

/**
 * Boards the actor is wired to (either edge direction), as glance rows from
 * the ether.board projection. Open topics first, then latest activity first.
 * Per-seat unread is not in the glance projection; `unread` is the
 * operator-local count when known.
 */
export const boardRowsForActor = (
  doc: CanvasDoc,
  nodeId: string,
): ReadonlyArray<BoardRow> => {
  const peerIds = new Set<string>();
  for (const edge of doc.edges) {
    if (edge.fromNode === nodeId) peerIds.add(edge.toNode);
    else if (edge.toNode === nodeId) peerIds.add(edge.fromNode);
  }
  const rows: BoardRow[] = [];
  for (const node of doc.nodes) {
    if (!peerIds.has(node.id)) continue;
    const board = node.ether?.board;
    if (board === undefined) continue;
    const topics = [...board.topics]
      .map((topic) => ({
        sinkNodeId: node.id,
        topicId: topic.topicId,
        title: topic.title,
        open: topic.state === "open",
        postCount: topic.postCount,
        lastActivityAtMs: isoMs(topic.lastActivityAt),
        ...(topic.authorLabel !== undefined
          ? { authorLabel: topic.authorLabel }
          : {}),
      }))
      .sort((a, b) => {
        if (a.open !== b.open) return a.open ? -1 : 1;
        return (b.lastActivityAtMs ?? 0) - (a.lastActivityAtMs ?? 0);
      });
    rows.push({ sinkNodeId: node.id, unread: board.unread, topics });
  }
  return rows;
};

const firstTextPart = (parts: ReadonlyArray<Part>): string | undefined => {
  for (const part of parts) {
    if (part.kind === "text") {
      const text = part.text.trim();
      if (text) return text;
    }
  }
  return undefined;
};

/**
 * Artifacts this seat published, across every artifacts sink in the doc.
 * Publisher identity is the projection-stamped metadata.publishedBySeatId
 * (never durable row data). Newest first; archived excluded.
 */
export const artifactRowsForSeat = (
  doc: CanvasDoc,
  seatId: ActorSeatId,
): ReadonlyArray<ArtifactRow> => {
  const rows: ArtifactRow[] = [];
  for (const node of doc.nodes) {
    for (const artifact of node.ether?.artifacts?.items ?? []) {
      if (artifact.metadata?.["publishedBySeatId"] !== seatId) continue;
      const archived = isArtifactArchived(artifact);
      if (archived) continue;
      rows.push({
        artifactId: artifact.artifactId,
        sinkNodeId: node.id,
        name: artifact.name?.trim() || artifact.artifactId,
        partCount: artifact.parts.length,
        textPreview: firstTextPart(artifact.parts),
        archived,
      });
    }
  }
  return rows.sort((a, b) => b.artifactId.localeCompare(a.artifactId));
};
