import type {
  CanvasDoc,
  CanvasNode,
  TextNode,
} from "./canvas";
import type {
  WorkMetadata,
  Task,
  Artifact,
  Message,
  Part,
  TaskProposal,
  TaskState,
  FinishCriteria,
  CompletionEvidence,
} from "./work-model";
import type { ActorRef } from "./work-protocol";
import {
  canTransitionTaskState,
  claimedByOf,
  isTerminalTaskState,
  makeAgentMessage,
  makeTaskReleaseMessage,
  makeUserMessage,
  mirrorArtifactsText,
  mirrorRequestsText,
  mirrorTasksText,
  taskWithTransitionState,
  validateTaskMediaParts,
} from "./task";
import { dependencyScopeIndex } from "./task-dep-scope";
import {
  normalizeDependsOn,
  taskIsClaimReady,
  validateTaskDependsOn,
} from "./task-deps";
import {
  artifactsByNodeFromDoc,
  evaluateFinishCriteria,
  normalizeCompletionEvidence,
  normalizeFinishCriteria,
} from "./finish-criteria";
import { groupMembers, isGroup } from "./graph";
import {
  ACTOR_ACTOR_INBOX_PORTS,
  NodeSpec,
  resolveSpec,
  type ActorSpec,
  type SinkKind,
} from "./physics";
import { HashSet } from "effect";

// Pure topology validation plus work-item draft/projection transforms.
// WorkService uses their results to invoke specific SQLite repository verbs;
// these helpers never authorize or commit a canvas-document mutation.
// No dual shapes: only Task / Message / Artifact.

export type WorkErrorCode =
  | "canvas_not_found"
  | "node_not_found"
  | "task_not_found"
  | "illegal_kind"
  | "illegal_transition"
  | "claim_contention"
  | "invalid";

export class WorkError extends Error {
  readonly code: WorkErrorCode;
  constructor(code: WorkErrorCode, message: string) {
    super(message);
    this.name = "WorkError";
    this.code = code;
  }
}

export type WorkIds = {
  readonly id: () => string;
  readonly messageId: () => string;
};

const textNode = (node: CanvasNode): TextNode | undefined =>
  node.type === "text" ? node : undefined;

const regionContextId = (doc: CanvasDoc, nodeId: string, canvasName: string): string => {
  const members = groupMembers(doc);
  for (const [groupId, memberIds] of members) {
    if (!memberIds.includes(nodeId)) continue;
    const group = doc.nodes.find((n) => n.id === groupId);
    if (!group || !isGroup(group)) continue;
    const label = group.label?.trim();
    if (label) return label;
    return groupId;
  }
  return canvasName;
};

const requireNode = (doc: CanvasDoc, nodeId: string): CanvasNode => {
  const node = doc.nodes.find((n) => n.id === nodeId);
  if (!node) throw new WorkError("node_not_found", `node "${nodeId}" not found`);
  return node;
};

const illegalKind = (node: CanvasNode, expected: string): WorkError =>
  new WorkError(
    "illegal_kind",
    `node "${node.id}" kind is ${node.ether?.entity?.kind ?? "none"}; expected ${expected}`,
  );

/**
 * Group-ness is deliberately not consulted: these predicates read the authored
 * kind, exactly as the string lists they replace did.
 */
const specOf = (node: CanvasNode) =>
  resolveSpec({ isGroup: false, kind: node.ether?.entity?.kind });

const isActorSpec = NodeSpec.$is("Actor");
const isSinkSpec = NodeSpec.$is("Sink");

/** The node is an actor. Role first, through the one resolution site. */
const requireActor = (node: CanvasNode, expected: string): ActorSpec => {
  const spec = specOf(node);
  if (!isActorSpec(spec)) throw illegalKind(node, expected);
  return spec;
};

/**
 * The node is a sink of one of the admitted kinds. Returns the kind narrowed to
 * what was admitted, so a caller branching afterwards branches on a literal it
 * has already proved rather than on a loose string.
 */
const requireSink = <K extends SinkKind>(
  node: CanvasNode,
  kinds: ReadonlyArray<K>,
): K => {
  const spec = specOf(node);
  if (!isSinkSpec(spec)) throw illegalKind(node, kinds.join("|"));
  const kind = kinds.find((admitted): admitted is K => admitted === spec.kind);
  if (kind === undefined) throw illegalKind(node, kinds.join("|"));
  return kind;
};

/**
 * The message inbox is an actor power, and not every actor holds one — a raw
 * terminal has nothing to read a message into. Which actors hold it is read
 * from the offered ports, so this is the same single declaration
 * (`ACTOR_ACTOR_INBOX_PORTS` → `KindSpecs`) used by capability admission,
 * not a second hand-kept copy of the kind list.
 */
const requireMessageInbox = (node: CanvasNode): void => {
  const actor = requireActor(node, "an actor inbox");
  const holdsInbox = ACTOR_ACTOR_INBOX_PORTS.every((port) =>
    HashSet.has(actor.offers, port),
  );
  if (!holdsInbox) throw illegalKind(node, "an actor inbox");
};

const withTasks = (
  doc: CanvasDoc,
  nodeId: string,
  items: ReadonlyArray<Task>,
  proposals?: ReadonlyArray<TaskProposal>,
): CanvasDoc => ({
  ...doc,
  nodes: doc.nodes.map((n) => {
    if (n.id !== nodeId) return n;
    const tn = textNode(n);
    const base = tn ?? n;
    return {
      ...base,
      ...(tn
        ? { text: mirrorTasksText(items) }
        : {}),
      ether: {
        ...(n.ether ?? {}),
        entity: n.ether?.entity ?? { kind: "task" },
        tasks: {
          items: [...items],
          proposals: [...(proposals ?? n.ether?.tasks?.proposals ?? [])],
        },
      },
    } as CanvasNode;
  }),
});

const withRequests = (
  doc: CanvasDoc,
  nodeId: string,
  items: ReadonlyArray<Task>,
): CanvasDoc => ({
  ...doc,
  nodes: doc.nodes.map((n) => {
    if (n.id !== nodeId) return n;
    const tn = textNode(n);
    return {
      ...n,
      ...(tn ? { text: mirrorRequestsText(items) } : {}),
      ether: {
        ...(n.ether ?? {}),
        entity: n.ether?.entity ?? { kind: "requests" },
        requests: { items: [...items] },
      },
    } as CanvasNode;
  }),
});

const withArtifacts = (
  doc: CanvasDoc,
  nodeId: string,
  items: ReadonlyArray<Artifact>,
): CanvasDoc => ({
  ...doc,
  nodes: doc.nodes.map((n) => {
    if (n.id !== nodeId) return n;
    const tn = textNode(n);
    return {
      ...n,
      ...(tn ? { text: mirrorArtifactsText(items) } : {}),
      ether: {
        ...(n.ether ?? {}),
        entity: n.ether?.entity ?? { kind: "artifacts" },
        artifacts: { items: [...items] },
      },
    } as CanvasNode;
  }),
});

const withMessages = (
  doc: CanvasDoc,
  nodeId: string,
  items: ReadonlyArray<Message>,
): CanvasDoc => ({
  ...doc,
  nodes: doc.nodes.map((n) => {
    if (n.id !== nodeId) return n;
    return {
      ...n,
      ether: {
        ...(n.ether ?? {}),
        messages: { items: [...items] },
      },
    } as CanvasNode;
  }),
});

const patchTaskInList = (
  items: ReadonlyArray<Task>,
  taskId: string,
  patch: (task: Task) => Task,
): { readonly items: Task[]; readonly task: Task } => {
  const idx = items.findIndex((t) => t.id === taskId);
  if (idx < 0) throw new WorkError("task_not_found", `task "${taskId}" not found`);
  const next = items.map((t, i) => {
    if (i !== idx) return t;
    rejectRetiredClaimMetadata(t.metadata);
    return patch(t);
  });
  return { items: next as Task[], task: next[idx]! };
};

const rejectRetiredClaimMetadata = (
  metadata: WorkMetadata | undefined,
): void => {
  if (
    metadata !== undefined &&
    Object.prototype.hasOwnProperty.call(metadata, "claimedBy")
  ) {
    throw new WorkError(
      "invalid",
      "metadata.claimedBy is retired; use Task.claimedBy",
    );
  }
};

/**
 * Tasks and proposals always carry a non-empty description (`metadata.details`).
 * Title/brief alone is not enough — create and propose both reject empty/missing
 * description. Historical rows without details still decode (create-only gate).
 */
export const requireTaskDescription = (
  metadata: WorkMetadata | undefined,
): string => {
  const raw = metadata?.details;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new WorkError("invalid", "description must be non-empty");
  }
  return raw.trim();
};

/** Normalize metadata so create/propose always persist trimmed details. */
const withRequiredDescription = (
  metadata: WorkMetadata | undefined,
): WorkMetadata => {
  const details = requireTaskDescription(metadata);
  return { ...(metadata ?? {}), details };
};

export type WorkTaskCreateResult = { readonly doc: CanvasDoc; readonly task: Task };
export type WorkTaskResult = { readonly doc: CanvasDoc; readonly task: Task };
export type WorkProposalResult = {
  readonly doc: CanvasDoc;
  readonly proposal: TaskProposal;
};
export type WorkProposalApprovalResult = WorkProposalResult & {
  readonly task: Task;
};
export type WorkTaskClaimResult = WorkTaskResult & {
  readonly claimedBy: ActorRef;
};
export type WorkMessageResult = { readonly doc: CanvasDoc; readonly message: Message };
export type WorkArtifactResult = { readonly doc: CanvasDoc; readonly artifact: Artifact };

export const workTaskCreate = (
  doc: CanvasDoc,
  canvasName: string,
  nodeId: string,
  brief: string,
  metadata: WorkMetadata | undefined,
  ids: WorkIds,
  reason?: string,
  /**
   * First-class media on the brief message (raw image parts). Stored in
   * history[0].parts so remote claims / tasks.list project them without host
   * paths.
   */
  media?: ReadonlyArray<Part>,
  /** Same-region hard prerequisites (task ids; cross-sink ok). Empty / omitted = free. */
  dependsOn?: ReadonlyArray<string>,
  finishCriteria?: FinishCriteria,
): WorkTaskCreateResult => {
  const node = requireNode(doc, nodeId);
  requireSink(node, ["task"]);
  const trimmed = brief.trim();
  if (!trimmed) throw new WorkError("invalid", "brief must be non-empty");
  rejectRetiredClaimMetadata(metadata);
  const nextMetadata = withRequiredDescription(metadata);
  const mediaError = validateTaskMediaParts(media);
  if (mediaError) throw new WorkError("invalid", mediaError);
  const taskId = ids.id();
  const existing = node.ether?.tasks?.items ?? [];
  const normalizedDeps = normalizeDependsOn(dependsOn);
  const depError = validateTaskDependsOn({
    taskId,
    dependsOn: normalizedDeps,
    byId: dependencyScopeIndex(doc, nodeId),
  });
  if (depError) throw new WorkError("invalid", depError);
  let criteria: FinishCriteria | undefined;
  try {
    criteria = normalizeFinishCriteria(finishCriteria);
  } catch (cause) {
    throw new WorkError(
      "invalid",
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  const contextId = regionContextId(doc, nodeId, canvasName);
  const briefMessage = makeUserMessage({
    messageId: ids.messageId(),
    text: trimmed,
    contextId,
    taskId,
    ...(media && media.length > 0 ? { extraParts: media } : {}),
  });
  const why = reason?.trim();
  const task: Task = {
    id: taskId,
    state: "submitted",
    history: [briefMessage],
    metadata: nextMetadata,
    ...(why ? { reason: why } : {}),
    ...(normalizedDeps ? { dependsOn: normalizedDeps } : {}),
    ...(criteria !== undefined ? { finishCriteria: criteria } : {}),
  };
  const items = [...existing, task];
  return { doc: withTasks(doc, nodeId, items), task };
};

/**
 * Operator rewrite of finish criteria. Cleared by passing undefined.
 * Terminal tasks cannot change criteria.
 */
export const workTaskSetFinishCriteria = (
  doc: CanvasDoc,
  canvasName: string,
  nodeId: string,
  taskId: string,
  finishCriteria: FinishCriteria | undefined,
): WorkTaskResult => {
  const node = requireNode(doc, nodeId);
  requireSink(node, ["task"]);
  const items = node.ether?.tasks?.items ?? [];
  let criteria: FinishCriteria | undefined;
  try {
    criteria = normalizeFinishCriteria(finishCriteria);
  } catch (cause) {
    throw new WorkError(
      "invalid",
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  const { items: nextItems, task } = patchTaskInList(items, taskId, (current) => {
    if (isTerminalTaskState(current.state)) {
      throw new WorkError(
        "illegal_transition",
        `cannot change finish criteria of task "${taskId}" in terminal state ${current.state}`,
      );
    }
    const { finishCriteria: _prev, completionEvidence: _ev, ...rest } = current;
    return {
      ...rest,
      ...(criteria !== undefined ? { finishCriteria: criteria } : {}),
    };
  });
  void canvasName;
  return { doc: withTasks(doc, nodeId, nextItems), task };
};

export const workTaskPropose = (
  doc: CanvasDoc,
  canvasName: string,
  nodeId: string,
  brief: string,
  metadata: WorkMetadata | undefined,
  ids: WorkIds,
  proposedBy: ActorRef,
  reason?: string,
  /**
   * First-class media on the brief message — same contract as task.create.
   */
  media?: ReadonlyArray<Part>,
  /** Same-region hard prerequisites (task ids; cross-sink ok). Empty / omitted = free. */
  dependsOn?: ReadonlyArray<string>,
  finishCriteria?: FinishCriteria,
): WorkProposalResult => {
  const node = requireNode(doc, nodeId);
  requireSink(node, ["task"]);
  const trimmed = brief.trim();
  if (!trimmed) throw new WorkError("invalid", "brief must be non-empty");
  rejectRetiredClaimMetadata(metadata);
  const nextMetadata = withRequiredDescription(metadata);
  const mediaError = validateTaskMediaParts(media);
  if (mediaError) throw new WorkError("invalid", mediaError);
  const proposalId = ids.id();
  const existing = node.ether?.tasks?.items ?? [];
  const normalizedDeps = normalizeDependsOn(dependsOn);
  const depError = validateTaskDependsOn({
    taskId: proposalId,
    dependsOn: normalizedDeps,
    byId: dependencyScopeIndex(doc, nodeId),
  });
  if (depError) throw new WorkError("invalid", depError);
  let criteria: FinishCriteria | undefined;
  try {
    criteria = normalizeFinishCriteria(finishCriteria);
  } catch (cause) {
    throw new WorkError(
      "invalid",
      cause instanceof Error ? cause.message : String(cause),
    );
  }
  const contextId = regionContextId(doc, nodeId, canvasName);
  const proposal: TaskProposal = {
    id: proposalId,
    state: "pending",
    brief: makeUserMessage({
      messageId: ids.messageId(),
      text: trimmed,
      contextId,
      taskId: proposalId,
      ...(media && media.length > 0 ? { extraParts: media } : {}),
    }),
    proposedBy,
    metadata: nextMetadata,
    ...(reason?.trim() ? { reason: reason.trim() } : {}),
    ...(normalizedDeps ? { dependsOn: normalizedDeps } : {}),
    ...(criteria !== undefined ? { finishCriteria: criteria } : {}),
  };
  return {
    doc: withTasks(
      doc,
      nodeId,
      existing,
      [...(node.ether?.tasks?.proposals ?? []), proposal],
    ),
    proposal,
  };
};

export const workTaskApproveProposal = (
  doc: CanvasDoc,
  canvasName: string,
  nodeId: string,
  proposalId: string,
  ids: WorkIds,
): WorkProposalApprovalResult => {
  const node = requireNode(doc, nodeId);
  requireSink(node, ["task"]);
  const items = node.ether?.tasks?.items ?? [];
  const proposals = node.ether?.tasks?.proposals ?? [];
  const index = proposals.findIndex((proposal) => proposal.id === proposalId);
  if (index < 0) {
    throw new WorkError(
      "task_not_found",
      `proposal "${proposalId}" not found`,
    );
  }
  const current = proposals[index]!;
  if (current.state !== "pending") {
    throw new WorkError(
      "illegal_transition",
      `proposal "${proposalId}" is not pending`,
    );
  }
  const taskId = ids.id();
  // Re-validate deps against region-scoped items at approve time (still not self).
  const depError = validateTaskDependsOn({
    taskId,
    dependsOn: current.dependsOn,
    byId: dependencyScopeIndex(doc, nodeId),
  });
  if (depError) throw new WorkError("invalid", depError);
  const task: Task = {
    id: taskId,
    state: "submitted",
    history: [{
      ...current.brief,
      messageId: ids.messageId(),
      taskId,
      contextId:
        current.brief.contextId ??
        regionContextId(doc, nodeId, canvasName),
    }],
    ...(current.metadata ? { metadata: current.metadata } : {}),
    ...(current.reason ? { reason: current.reason } : {}),
    ...(current.dependsOn && current.dependsOn.length > 0
      ? { dependsOn: current.dependsOn }
      : {}),
    ...(current.finishCriteria !== undefined
      ? { finishCriteria: current.finishCriteria }
      : {}),
  };
  const proposal: TaskProposal = {
    ...current,
    state: "approved",
    approvedTaskId: taskId,
  };
  const nextProposals = proposals.map((candidate, proposalIndex) =>
    proposalIndex === index ? proposal : candidate
  );
  return {
    doc: withTasks(doc, nodeId, [...items, task], nextProposals),
    proposal,
    task,
  };
};

/**
 * Operator discard of a pending proposal. Terminal on the planning lane —
 * never mints a task. Rejected proposals drop out of the board's pending view.
 */
export const workTaskRejectProposal = (
  doc: CanvasDoc,
  nodeId: string,
  proposalId: string,
): WorkProposalResult => {
  const node = requireNode(doc, nodeId);
  requireSink(node, ["task"]);
  const items = node.ether?.tasks?.items ?? [];
  const proposals = node.ether?.tasks?.proposals ?? [];
  const index = proposals.findIndex((proposal) => proposal.id === proposalId);
  if (index < 0) {
    throw new WorkError(
      "task_not_found",
      `proposal "${proposalId}" not found`,
    );
  }
  const current = proposals[index]!;
  if (current.state !== "pending") {
    throw new WorkError(
      "illegal_transition",
      `proposal "${proposalId}" is not pending`,
    );
  }
  const proposal: TaskProposal = {
    ...current,
    state: "rejected",
  };
  const nextProposals = proposals.map((candidate, proposalIndex) =>
    proposalIndex === index ? proposal : candidate
  );
  return {
    doc: withTasks(doc, nodeId, items, nextProposals),
    proposal,
  };
};

export const workTaskDescribe = (
  doc: CanvasDoc,
  canvasName: string,
  nodeId: string,
  taskId: string,
  brief: string,
  ids: WorkIds,
): WorkTaskResult => {
  const node = requireNode(doc, nodeId);
  requireSink(node, ["task"]);
  const trimmed = brief.trim();
  if (!trimmed) throw new WorkError("invalid", "brief must be non-empty");
  const items = node.ether?.tasks?.items ?? [];
  const contextId = regionContextId(doc, nodeId, canvasName);
  const { items: nextItems, task } = patchTaskInList(items, taskId, (current) => {
    if (isTerminalTaskState(current.state)) {
      throw new WorkError(
        "illegal_transition",
        `cannot re-describe task "${taskId}" in terminal state ${current.state}`,
      );
    }
    // Re-author the brief in place: history[0] IS the ask (taskBrief reads it).
    // Later status notes stay appended and untouched.
    const briefMessage = makeUserMessage({
      messageId: ids.messageId(),
      text: trimmed,
      contextId,
      taskId,
    });
    return { ...current, history: [briefMessage, ...current.history.slice(1)] };
  });
  return { doc: withTasks(doc, nodeId, nextItems), task };
};

export type WorkTaskTransitionOptions = {
  /**
   * When false, skip evaluateFinishCriteria (caller is not the entity home;
   * the home repository/command path is the sole gate). Default true.
   */
  readonly evaluateFinishCriteria?: boolean;
};

export const workTaskTransition = (
  doc: CanvasDoc,
  canvasName: string,
  nodeId: string,
  taskId: string,
  state: TaskState,
  note: string | undefined,
  ids: WorkIds,
  completionEvidence?: CompletionEvidence,
  options?: WorkTaskTransitionOptions,
): WorkTaskResult => {
  const node = requireNode(doc, nodeId);
  requireSink(node, ["task"]);
  const items = node.ether?.tasks?.items ?? [];
  const contextId = regionContextId(doc, nodeId, canvasName);
  const runFinishGate = options?.evaluateFinishCriteria !== false;
  const evidence =
    state === "completed"
      ? normalizeCompletionEvidence(completionEvidence)
      : undefined;
  const { items: nextItems, task } = patchTaskInList(items, taskId, (current) => {
    if (!canTransitionTaskState(current.state, state)) {
      throw new WorkError(
        "illegal_transition",
        `cannot transition task "${taskId}" from ${current.state} to ${state}`,
      );
    }
    if (current.state === "completed" && state === "submitted" && !note?.trim()) {
      throw new WorkError(
        "invalid",
        "a QA rejection comment is required before returning a completed task to Queue",
      );
    }
    if (state === "completed" && runFinishGate) {
      const gate = evaluateFinishCriteria({
        task: current,
        taskNodeId: nodeId,
        canvasName,
        evidence,
        artifactsByNode: artifactsByNodeFromDoc(doc.nodes),
      });
      if (gate !== undefined) {
        throw new WorkError(
          "illegal_transition",
          `finish criteria unsatisfied [${gate.missing}]: ${gate.message} (next: ${gate.next_step})`,
        );
      }
    }
    let history = current.history;
    if (state === "submitted") {
      history = [
        ...history,
        makeTaskReleaseMessage({
          messageId: ids.messageId(),
          text: note?.trim() || "Released to Queue by operator.",
          contextId,
          taskId,
          actorSeatId: claimedByOf(current),
        }),
      ];
    } else if (note?.trim()) {
      history = [
        ...history,
        makeAgentMessage({
          messageId: ids.messageId(),
          text: note.trim(),
          contextId,
          taskId,
        }),
      ];
    }
    const next = { ...taskWithTransitionState(current, state), history };
    if (state === "completed" && evidence !== undefined) {
      return { ...next, completionEvidence: evidence };
    }
    if (state !== "completed") {
      const { completionEvidence: _cleared, ...rest } = next;
      return rest;
    }
    return next;
  });
  return { doc: withTasks(doc, nodeId, nextItems), task };
};

/**
 * The operator's response is one task mutation: record their exact words and
 * leave the attention state in the same atomic transition. It is deliberately
 * narrower than a generic message append so a failed transition never leaves
 * durable context that claims the worker may resume.
 */
export const workTaskRespond = (
  doc: CanvasDoc,
  canvasName: string,
  nodeId: string,
  taskId: string,
  responseText: string,
  disposition: "working" | "rejected",
  ids: WorkIds,
): WorkTaskResult => {
  const node = requireNode(doc, nodeId);
  requireSink(node, ["task"]);
  const text = responseText.trim();
  if (!text) throw new WorkError("invalid", "response text must be non-empty");
  const items = node.ether?.tasks?.items ?? [];
  const contextId = regionContextId(doc, nodeId, canvasName);
  const { items: nextItems, task } = patchTaskInList(items, taskId, (current) => {
    if (current.state !== "input-required" && current.state !== "auth-required") {
      throw new WorkError(
        "illegal_transition",
        `cannot respond to task "${taskId}" in state ${current.state}`,
      );
    }
    if (!canTransitionTaskState(current.state, disposition)) {
      throw new WorkError(
        "illegal_transition",
        `cannot transition task "${taskId}" from ${current.state} to ${disposition}`,
      );
    }
    const response = makeUserMessage({
      messageId: ids.messageId(),
      text,
      contextId,
      taskId,
    });
    return {
      ...current,
      state: disposition,
      history: [...current.history, response],
    };
  });
  return { doc: withTasks(doc, nodeId, nextItems), task };
};

export const workTaskClaim = (
  doc: CanvasDoc,
  canvasName: string,
  nodeId: string,
  taskId: string,
  actor: ActorRef,
  ids: WorkIds,
): WorkTaskClaimResult => {
  const node = requireNode(doc, nodeId);
  requireSink(node, ["task"]);
  const items = node.ether?.tasks?.items ?? [];
  const contextId = regionContextId(doc, nodeId, canvasName);
  const { items: nextItems, task } = patchTaskInList(items, taskId, (current) => {
    const existing = claimedByOf(current);
    if (existing && existing !== actor.seatId) {
      throw new WorkError(
        "claim_contention",
        `task "${taskId}" already claimed by "${existing}"`,
      );
    }
    // Claims take submitted or working items only. An attention task is
    // waiting on a HUMAN — a claim must never consume that wait — and
    // terminal work is closed. (Contention above already guards working
    // items held by another actor.)
    if (current.state !== "submitted" && current.state !== "working") {
      throw new WorkError(
        "illegal_transition",
        `cannot claim task "${taskId}" in state ${current.state}`,
      );
    }
    // Exact replay may arrive through another canvas reference to the same
    // executable seat. Idempotency keys on ActorSeatId, never node identity.
    if (current.state === "working" && existing === actor.seatId) {
      return current;
    }
    // Hard prereqs: first claim only when every dependsOn is completed
    // (deps may live on other task sinks in the same region).
    if (current.state === "submitted") {
      const byId = dependencyScopeIndex(doc, nodeId);
      if (!taskIsClaimReady(current, byId)) {
        throw new WorkError(
          "invalid",
          `task "${taskId}" is not claim-ready (unsatisfied dependsOn)`,
        );
      }
    }
    const history = [
      ...current.history,
      makeAgentMessage({
        messageId: ids.messageId(),
        text: `claimed by ${actor.seatId}`,
        contextId,
        taskId,
      }),
    ];
    return {
      ...current,
      state: "working",
      claimedBy: actor.seatId,
      history,
    };
  });
  return {
    doc: withTasks(doc, nodeId, nextItems),
    task,
    claimedBy: actor,
  };
};

export const workMessageAppend = (
  doc: CanvasDoc,
  canvasName: string,
  nodeId: string,
  taskId: string | null,
  message: Message,
): WorkMessageResult => {
  const node = requireNode(doc, nodeId);
  const contextId = message.contextId?.trim() || regionContextId(doc, nodeId, canvasName);
  const stamped: Message = {
    ...message,
    contextId,
    ...(taskId ? { taskId } : message.taskId ? { taskId: message.taskId } : {}),
  };

  if (taskId) {
    const kind = requireSink(node, ["task", "requests"] as const);
    if (kind === "task") {
      const items = node.ether?.tasks?.items ?? [];
      const { items: nextItems, task } = patchTaskInList(items, taskId, (current) => ({
        ...current,
        history: [...current.history, { ...stamped, taskId }],
      }));
      void task;
      return { doc: withTasks(doc, nodeId, nextItems), message: { ...stamped, taskId } };
    }
    const items = node.ether?.requests?.items ?? [];
    const { items: nextItems } = patchTaskInList(items, taskId, (current) => ({
      ...current,
      history: [...current.history, { ...stamped, taskId }],
    }));
    return { doc: withRequests(doc, nodeId, nextItems), message: { ...stamped, taskId } };
  }

  requireMessageInbox(node);
  const items = [...(node.ether?.messages?.items ?? []), stamped];
  return { doc: withMessages(doc, nodeId, items), message: stamped };
};

export const workRequestCreate = (
  doc: CanvasDoc,
  canvasName: string,
  nodeId: string,
  brief: string,
  metadata: WorkMetadata | undefined,
  ids: WorkIds,
  raisedBy: ActorRef,
  reason?: string,
): WorkTaskCreateResult => {
  const node = requireNode(doc, nodeId);
  requireSink(node, ["requests"]);
  const trimmed = brief.trim();
  if (!trimmed) throw new WorkError("invalid", "brief must be non-empty");
  const why = reason?.trim() ?? "";
  const detailsRaw = metadata?.details;
  const details = typeof detailsRaw === "string" ? detailsRaw.trim() : "";
  if (!why && !details) {
    throw new WorkError(
      "invalid",
      "request body required: provide reason and/or metadata.details (not title-only)",
    );
  }
  rejectRetiredClaimMetadata(metadata);
  // A request is actor-originated and claimed by its raiser at birth. The
  // raiser is the worker waiting on the answer, so stoppage lands on it.
  const taskId = ids.id();
  const contextId = regionContextId(doc, nodeId, canvasName);
  // Message body prefers details, then reason, then brief — never title alone.
  const bodyText = details || why || trimmed;
  const briefMessage = makeUserMessage({
    messageId: ids.messageId(),
    text: bodyText === trimmed ? trimmed : `${trimmed}\n\n${bodyText}`,
    contextId,
    taskId,
  });
  const task: Task = {
    id: taskId,
    state: "input-required",
    claimedBy: raisedBy.seatId,
    history: [briefMessage],
    ...(metadata ? { metadata } : {}),
    ...(why ? { reason: why } : {}),
  };
  const items = [...(node.ether?.requests?.items ?? []), task];
  return { doc: withRequests(doc, nodeId, items), task };
};

export const workRequestResolve = (
  doc: CanvasDoc,
  canvasName: string,
  nodeId: string,
  taskId: string,
  responseText: string,
  disposition: "completed" | "rejected",
  ids: WorkIds,
): WorkTaskResult => {
  const node = requireNode(doc, nodeId);
  requireSink(node, ["requests"]);
  const text = responseText.trim();
  if (!text) throw new WorkError("invalid", "response text must be non-empty");
  const items = node.ether?.requests?.items ?? [];
  const contextId = regionContextId(doc, nodeId, canvasName);
  const { items: nextItems, task } = patchTaskInList(items, taskId, (current) => {
    if (current.state !== "input-required") {
      throw new WorkError(
        "illegal_transition",
        `cannot resolve request "${taskId}" in state ${current.state}`,
      );
    }
    if (!canTransitionTaskState(current.state, disposition)) {
      throw new WorkError(
        "illegal_transition",
        `cannot transition request "${taskId}" from ${current.state} to ${disposition}`,
      );
    }
    const reply = makeUserMessage({
      messageId: ids.messageId(),
      text,
      contextId,
      taskId,
    });
    // The answer is first-class on the item (glanceable), and in history.
    return {
      ...current,
      state: disposition,
      history: [...current.history, reply],
      response: text,
    };
  });
  return { doc: withRequests(doc, nodeId, nextItems), task };
};

export const workArtifactPublish = (
  doc: CanvasDoc,
  canvasName: string,
  nodeId: string,
  artifact: Artifact,
): WorkArtifactResult => {
  const node = requireNode(doc, nodeId);
  requireSink(node, ["artifacts"]);
  if (!artifact.artifactId.trim()) {
    throw new WorkError("invalid", "artifactId must be non-empty");
  }
  if (!Array.isArray(artifact.parts) || artifact.parts.length === 0) {
    throw new WorkError("invalid", "artifact must have at least one part");
  }
  const taskRef = artifact.task;
  if (taskRef !== undefined) {
    if (taskRef.sink.canvasName !== canvasName) {
      throw new WorkError(
        "invalid",
        "artifact task reference must belong to the artifact canvas",
      );
    }
    const taskNode = requireNode(doc, taskRef.sink.nodeId);
    requireSink(taskNode, ["task"]);
    const task = taskNode.ether?.tasks?.items.find(
      (candidate) => candidate.id === taskRef.itemId,
    );
    if (task === undefined) {
      throw new WorkError(
        "task_not_found",
        `task "${taskRef.itemId}" not found`,
      );
    }
    if (task.claimedBy === undefined) {
      throw new WorkError(
        "invalid",
        `task "${taskRef.itemId}" must be claimed before artifact linkage`,
      );
    }
  }
  const existing = node.ether?.artifacts?.items ?? [];
  if (existing.some((a) => a.artifactId === artifact.artifactId)) {
    throw new WorkError("invalid", `artifact "${artifact.artifactId}" already exists`);
  }
  const items = [...existing, artifact];
  return { doc: withArtifacts(doc, nodeId, items), artifact };
};
