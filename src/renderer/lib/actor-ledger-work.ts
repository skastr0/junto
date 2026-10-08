import type { WorkLaneRow } from "@shared/work-sinks";
import type { Artifact, BoardGlanceTopic } from "@shared/work-model";
import type { TasksContract } from "@shared/work-model";
import type { ActorSeatId } from "@shared/actor-seat";
import type {
  Message,
  Part,
  Task,
  TaskState,
} from "@shared/work-model";
import type { ActorRef } from "@shared/work-protocol";
import { taskAdmissionState } from "@shared/rules";
import { taskBrief, isAttentionTaskState } from "@shared/task";
import { isArtifactArchived } from "@shared/work";
import { claimedTaskForActorNode } from "./claimed-task";

/**
 * Pure projections of an actor's work-kernel standing for ledger-style UI:
 * the task it currently holds, the tasks it raised, and the requests
 * (escalations) it raised. The caller supplies independently queried Work rows.
 */

export type ClaimedTaskRow = {
  readonly taskId: string;
  readonly sinkNodeId: string;
  readonly state: TaskState;
  readonly title: string;
  readonly needsInput: boolean;
};

export type RaisedTaskRow = {
  readonly taskId: string;
  readonly sinkNodeId: string;
  readonly state: TaskState;
  readonly title: string;
  /** Needs operator approval before agents can claim it. */
  readonly awaitingApproval: boolean;
  readonly reason?: string;
  /** Full brief text — the decision contract shown before deciding. */
  readonly details?: string;
  readonly dependsOnCount: number;
  readonly hasFinishCriteria: boolean;
};

export type RequestRow = {
  readonly requestId: string;
  readonly sinkNodeId: string;
  readonly state: TaskState;
  readonly title: string;
  /**
   * Narrow answer eligibility: only `input-required` can be resolved here.
   * Never broaden — `auth-required` has no producer and resolve refuses it.
   */
  readonly needsInput: boolean;
  /** Waits on the operator (input-required or auth-required) — drives order/tone. */
  readonly attention: boolean;
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
  const line = (metadataTitle(task) ?? taskBrief(task)).split(/\r?\n/, 1)[0]?.trim();
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
  rows: ReadonlyArray<WorkLaneRow>,
  actorRefs: ReadonlyArray<ActorRef>,
  nodeId: string,
): ClaimedTaskRow | undefined => {
  const claimed = claimedTaskForActorNode(rows, actorRefs, nodeId);
  if (claimed === undefined) return undefined;
  return {
    taskId: claimed.task.id,
    sinkNodeId: claimed.sinkNodeId,
    state: claimed.task.state,
    title: taskTitle(claimed.task, "Untitled task"),
    needsInput: claimed.task.state === "input-required",
  };
};

/** Awaiting approval first, then newest first (ULID ids sort by birth order). */
const compareRaisedTaskRows = (a: RaisedTaskRow, b: RaisedTaskRow): number => {
  const rank = (row: RaisedTaskRow): number =>
    row.awaitingApproval ? 0 : 1;
  const byApproval = rank(a) - rank(b);
  if (byApproval !== 0) return byApproval;
  return b.taskId.localeCompare(a.taskId);
};

/** Tasks this seat raised, across every tasks sink in the doc. */
export const raisedTaskRowsForSeat = (
  entries: ReadonlyArray<WorkLaneRow>,
  contractOf: (nodeId: string) => TasksContract | undefined,
  seatId: ActorSeatId,
): ReadonlyArray<RaisedTaskRow> => {
  const rows: RaisedTaskRow[] = [];
  for (const { nodeId, item: task } of entries) {
      const contract = contractOf(nodeId);
      if (task.raisedBy?.seatId !== seatId) continue;
      const title = taskTitle(task, "Untitled task");
      const details =
        metadataText(task, "details") ??
        detailsBeyondTitle(fullText(task.history[0]), title);
      rows.push({
        taskId: task.id,
        sinkNodeId: nodeId,
        state: task.state,
        title,
        awaitingApproval:
          task.state === "submitted" &&
          taskAdmissionState(task, contract, Date.now()) === "approval",
        ...(task.reason !== undefined ? { reason: task.reason } : {}),
        ...(details !== undefined ? { details } : {}),
        dependsOnCount: task.dependsOn?.length ?? 0,
        hasFinishCriteria: task.finishCriteria !== undefined,
      });
  }
  return rows.sort(compareRaisedTaskRows);
};

/** Attention first (waits on the operator), then newest first (ULID birth order). */
const compareRequestRows = (a: RequestRow, b: RequestRow): number => {
  const attentionRank = (row: RequestRow): number => (row.attention ? 0 : 1);
  const byAttention = attentionRank(a) - attentionRank(b);
  if (byAttention !== 0) return byAttention;
  return b.requestId.localeCompare(a.requestId);
};

/**
 * Requests (escalations) this seat raised, across every requests sink in the
 * doc. A request's claimedBy is the raiser's seat — that is the "raised by"
 * identity, including on resolved requests.
 */
export const requestRowsForSeat = (
  entries: ReadonlyArray<WorkLaneRow>,
  seatId: ActorSeatId,
): ReadonlyArray<RequestRow> => {
  const rows: RequestRow[] = [];
  for (const { nodeId, item: request } of entries) {
      if (request.claimedBy !== seatId) continue;
      const title = metadataTitle(request) ?? taskTitle(request, "Untitled request");
      const details =
        metadataText(request, "details") ??
        detailsBeyondTitle(fullText(request.history[0]), title);
      rows.push({
        requestId: request.id,
        sinkNodeId: nodeId,
        state: request.state,
        title,
        needsInput: request.state === "input-required",
        attention: isAttentionTaskState(request.state),
        ...(request.response !== undefined ? { response: request.response } : {}),
        ...(details !== undefined ? { details } : {}),
      });
  }
  return rows.sort(compareRequestRows);
};

const isoMs = (value: string): number | undefined => {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
};

/**
 * Boards the actor is wired to (either edge direction), as glance rows from
 * the board's Work projection. Open topics first, then latest activity first.
 * Per-seat unread is not in the glance projection; `unread` is the
 * operator-local count when known.
 */
export const boardRowsForActor = (
  entries: ReadonlyArray<{ readonly nodeId: string; readonly board: { readonly topics: ReadonlyArray<BoardGlanceTopic>; readonly unread?: number } }>,
): ReadonlyArray<BoardRow> => {
  const rows: BoardRow[] = [];
  for (const { nodeId, board } of entries) {
    const topics = [...board.topics]
      .map((topic) => ({
        sinkNodeId: nodeId,
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
    rows.push({ sinkNodeId: nodeId, unread: board.unread, topics });
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
  entries: ReadonlyArray<{ readonly nodeId: string; readonly item: Artifact }>,
  seatId: ActorSeatId,
): ReadonlyArray<ArtifactRow> => {
  const rows: ArtifactRow[] = [];
  for (const { nodeId, item: artifact } of entries) {
      if (artifact.metadata?.["publishedBySeatId"] !== seatId) continue;
      const archived = isArtifactArchived(artifact);
      if (archived) continue;
      rows.push({
        artifactId: artifact.artifactId,
        sinkNodeId: nodeId,
        name: artifact.name?.trim() || artifact.artifactId,
        partCount: artifact.parts.length,
        textPreview: firstTextPart(artifact.parts),
        archived,
      });
  }
  return rows.sort((a, b) => b.artifactId.localeCompare(a.artifactId));
};
