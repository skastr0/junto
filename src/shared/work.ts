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
  Passage,
  SinkAdmission,
  TaskProposal,
  TaskState,
  FinishCriteria,
  CompletionEvidence,
  TaskClaim,
} from "./work-model";
import { resolveSinkAdmission } from "./work-model";
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
import {
  PIPELINE_ADMITTED_METADATA_KEY,
  carryClaimEvidence,
  clampRequestedAdmission,
  computeHoldUntil,
  effectiveClaimsStack,
  evaluateBoarding,
  evaluateClaimCompletion,
  evaluateForkWaivers,
  evaluateTerminalClose,
  requiredBoardingChecks,
  sinkContractOf,
  taskAdmissionState,
  taskEpoch,
  type ClaimCheckFailure,
} from "./claims";
import { flowDestinations } from "./flow-graph";
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
          // Operator-authored document truth rides along untouched — work
          // projections must never erase the sink contract.
          ...(n.ether?.tasks?.contract !== undefined
            ? { contract: n.ether.tasks.contract }
            : {}),
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
 * Authoring-input-only guard (create/propose): pipeline state is
 * system-stamped — journeys, tickets, and the operator promotion marker are
 * never accepted from caller metadata. Existing durable rows legitimately
 * carry the promotion marker, so this never runs on patched tasks.
 */
const rejectReservedPipelineMetadata = (
  metadata: WorkMetadata | undefined,
): void => {
  if (
    metadata !== undefined &&
    (Object.prototype.hasOwnProperty.call(metadata, "vellum.pipeline") ||
      Object.prototype.hasOwnProperty.call(
        metadata,
        PIPELINE_ADMITTED_METADATA_KEY,
      ))
  ) {
    throw new WorkError(
      "invalid",
      "metadata keys under vellum.pipeline are reserved for the work service",
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

export type WorkTaskCreateOptions = {
  readonly admission?: SinkAdmission;
  /** Agent wire omit persists operator-gated. Operator enqueue inherits the sink. */
  readonly admissionOmitted?: "operator-gated" | "inherit";
  readonly holdForMs?: number;
  readonly raisedBy?: ActorRef;
  readonly nowMs?: number;
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
  /** Station-addressed claims; set at creation, immutable on generic transitions. */
  claims?: ReadonlyArray<TaskClaim>,
  options?: WorkTaskCreateOptions,
): WorkTaskCreateResult => {
  const node = requireNode(doc, nodeId);
  requireSink(node, ["task"]);
  const trimmed = brief.trim();
  if (!trimmed) throw new WorkError("invalid", "brief must be non-empty");
  rejectRetiredClaimMetadata(metadata);
  rejectReservedPipelineMetadata(metadata);
  const nextMetadata = withRequiredDescription(metadata);
  const mediaError = validateTaskMediaParts(media);
  if (mediaError) throw new WorkError("invalid", mediaError);
  const contract = sinkContractOf(node);
  const clamped = clampRequestedAdmission({
    floor: resolveSinkAdmission(contract),
    requested: options?.admission,
    omitted: options?.admissionOmitted ?? "inherit",
  });
  if (!clamped.ok) throw new WorkError("invalid", clamped.message);
  const holdUntil = computeHoldUntil(
    options?.nowMs ?? Date.now(),
    contract?.inbound?.claimableAfterMs,
    options?.holdForMs,
  );
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
  const normalizedClaims = claims && claims.length > 0 ? claims : undefined;
  const task: Task = {
    id: taskId,
    state: "submitted",
    history: [briefMessage],
    metadata: nextMetadata,
    ...(why ? { reason: why } : {}),
    ...(normalizedDeps ? { dependsOn: normalizedDeps } : {}),
    ...(criteria !== undefined ? { finishCriteria: criteria } : {}),
    ...(normalizedClaims ? { claims: normalizedClaims } : {}),
    ...(clamped.stamp !== undefined ? { admission: clamped.stamp } : {}),
    ...(options?.raisedBy !== undefined ? { raisedBy: options.raisedBy } : {}),
    ...(holdUntil !== undefined ? { holdUntil } : {}),
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
  /** Station-addressed claims; set at creation, carried onto the minted Task on approve. */
  claims?: ReadonlyArray<TaskClaim>,
): WorkProposalResult => {
  const node = requireNode(doc, nodeId);
  requireSink(node, ["task"]);
  const trimmed = brief.trim();
  if (!trimmed) throw new WorkError("invalid", "brief must be non-empty");
  rejectRetiredClaimMetadata(metadata);
  rejectReservedPipelineMetadata(metadata);
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
    ...(claims && claims.length > 0 ? { claims } : {}),
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
    ...(current.claims && current.claims.length > 0
      ? { claims: current.claims }
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
  /**
   * Forward destination on → completed at a sink with flow destinations.
   * Required when the sink has more than one destination; auto-resolved when
   * it has exactly one. Validated against live flow edges (act-time DAG law).
   */
  readonly next?: string;
  /** Defect payload on → rejected for a task with a prior passage. */
  readonly defect?: {
    readonly summary: string;
    readonly refs?: ReadonlyArray<string>;
    /** Visited station to send the task back to; omitted = the previous station. */
    readonly target?: string;
  };
  /** Per-task forward hold stamp (ms); wins over destination claimableAfterMs. */
  readonly holdForMs?: number;
  /** Clock for passage/hold stamps. Default Date.now(). */
  readonly nowMs?: number;
};

export type WorkTaskTransitionResult = WorkTaskResult & {
  /** Present when the completion forwarded the task along a flow edge. */
  readonly forwarded?: { readonly nodeId: string; readonly task: Task };
  /** Present when a defect-back re-homed the task to its previous station. */
  readonly defectBack?: { readonly nodeId: string; readonly task: Task };
};

const claimGateError = (failure: ClaimCheckFailure): WorkError =>
  // Same shape as the finish-criteria failure so the control plane surfaces
  // missing/next_step through the one InvalidTransition mapping.
  new WorkError(
    "illegal_transition",
    `claims unsatisfied [${failure.missing}]: ${failure.message} (next: ${failure.next_step})`,
  );

/**
 * True when `task`'s current-epoch journey tail closed here with an exit
 * that already re-homed the live successor to another station (forward or
 * defect-back). Such a row is a passage record, not live work — re-opening
 * it via the generic submitted-entry path would mint a second live row for
 * the same task id (invariant: no split/rejoin).
 */
const isExitedPassageRow = (task: Task, nodeId: string): boolean => {
  const last = (task.journey ?? []).at(-1);
  return (
    last !== undefined &&
    last.nodeId === nodeId &&
    last.epoch === taskEpoch(task) &&
    (last.exit === "forwarded" || last.exit === "rejected-back")
  );
};

/**
 * The passage the task is currently living: the last journey entry when it
 * names this station and has not exited; otherwise a fresh entry synthesized
 * at exit time (tasks born before the pipeline have no arrival passage).
 */
const currentPassageFor = (
  task: Task,
  nodeId: string,
  nowIso: string,
): { readonly journey: ReadonlyArray<Passage>; readonly passage: Passage } => {
  const journey = task.journey ?? [];
  const last = journey[journey.length - 1];
  if (last !== undefined && last.nodeId === nodeId && last.exit === undefined) {
    return { journey: journey.slice(0, -1), passage: last };
  }
  return {
    journey,
    passage: { nodeId, enteredAt: nowIso, epoch: taskEpoch(task) },
  };
};

/** Metadata for a re-homed task: promotion is per-station, so the marker drops. */
const rehomedMetadata = (
  metadata: WorkMetadata | undefined,
): WorkMetadata | undefined => {
  if (metadata === undefined) return undefined;
  if (!(PIPELINE_ADMITTED_METADATA_KEY in metadata)) return metadata;
  const { [PIPELINE_ADMITTED_METADATA_KEY]: _promoted, ...rest } = metadata;
  return Object.keys(rest).length > 0 ? (rest as WorkMetadata) : undefined;
};

/**
 * Build the submitted successor of `task` at `destination`. dependsOn stays
 * behind: prerequisites gate the first claim at the origin station and are
 * already satisfied by the time the task travels. Boarding tickets stay
 * behind too — tickets are per-station stamps.
 */
const rehomedTask = (
  task: Task,
  closedJourney: ReadonlyArray<Passage>,
  destination: string,
  epoch: number,
  enteredAt: string,
  holdUntil: string | undefined,
  history: ReadonlyArray<Message>,
): Task => {
  const {
    claimedBy: _claimedBy,
    completionEvidence: _evidence,
    dependsOn: _deps,
    boarding: _boarding,
    holdUntil: _hold,
    response: _response,
    metadata: _metadata,
    admission: _admission,
    ...rest
  } = task;
  const metadata = rehomedMetadata(task.metadata);
  return {
    ...rest,
    state: "submitted",
    history: [...history],
    epoch,
    journey: [...closedJourney, { nodeId: destination, enteredAt, epoch }],
    ...(holdUntil !== undefined ? { holdUntil } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
};

/**
 * The successor thread at `destination`: extend the station's existing row
 * thread when the journey has been here before (defect-back cycles), else
 * start from a fresh copy of the brief. Onion law holds by construction —
 * prior passages' interiors stay on their own station rows.
 */
const rehomedHistory = (
  doc: CanvasDoc,
  destination: string,
  task: Task,
  brief: Message,
  note: Message,
): ReadonlyArray<Message> => {
  const existing = doc.nodes
    .find((n) => n.id === destination)
    ?.ether?.tasks?.items.find((item) => item.id === task.id);
  return existing === undefined
    ? [brief, note]
    : [...existing.history, note];
};

const replaceOrAppendTask = (
  items: ReadonlyArray<Task>,
  task: Task,
): Task[] => {
  const index = items.findIndex((candidate) => candidate.id === task.id);
  if (index < 0) return [...items, task];
  const next = [...items];
  next[index] = task;
  return next;
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
): WorkTaskTransitionResult => {
  const node = requireNode(doc, nodeId);
  requireSink(node, ["task"]);
  const items = node.ether?.tasks?.items ?? [];
  const contextId = regionContextId(doc, nodeId, canvasName);
  const runFinishGate = options?.evaluateFinishCriteria !== false;
  const nowMs = options?.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const evidence =
    state === "completed"
      ? carryClaimEvidence(
          normalizeCompletionEvidence(completionEvidence),
          completionEvidence,
        )
      : undefined;
  const destinations =
    state === "completed" ? flowDestinations(doc, nodeId) : [];
  const forwardTo =
    destinations.length === 0
      ? undefined
      : options?.next ?? (destinations.length === 1 ? destinations[0] : undefined);
  if (destinations.length > 1 && options?.next === undefined && state === "completed") {
    throw new WorkError(
      "invalid",
      `sink "${nodeId}" forwards to more than one station; pick next from [${destinations.join(", ")}]`,
    );
  }
  if (forwardTo !== undefined && !destinations.includes(forwardTo)) {
    throw new WorkError(
      "invalid",
      `"${forwardTo}" is not a live flow destination of sink "${nodeId}" [${destinations.join(", ")}]`,
    );
  }
  if (forwardTo === nodeId) {
    throw new WorkError("invalid", `sink "${nodeId}" cannot forward to itself`);
  }

  let forwarded: { readonly nodeId: string; readonly task: Task } | undefined;
  let defectBack: { readonly nodeId: string; readonly task: Task } | undefined;

  const { items: nextItems, task } = patchTaskInList(items, taskId, (current) => {
    if (!canTransitionTaskState(current.state, state)) {
      throw new WorkError(
        "illegal_transition",
        `cannot transition task "${taskId}" from ${current.state} to ${state}`,
      );
    }
    if (state === "submitted" && isExitedPassageRow(current, nodeId)) {
      throw new WorkError(
        "illegal_transition",
        `task "${taskId}" at "${nodeId}" is a closed passage record (exit: ${current.journey?.at(-1)?.exit}) — re-opening it here would create a second live row for this task; forward/defect-back already re-homed the live copy`,
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
    if (state === "completed") {
      // Structural claims gate — doc-derived, so it runs at every caller
      // (unlike the SQLite-shelf finish gate, which is home-local).
      const claimsGate = evaluateClaimCompletion({
        stack: effectiveClaimsStack(doc, nodeId, current),
        evidence,
      });
      if (claimsGate !== undefined) throw claimGateError(claimsGate);
      if (forwardTo !== undefined) {
        const boardingGate = evaluateBoarding({
          task: current,
          checks: requiredBoardingChecks(doc, nodeId, forwardTo),
        });
        if (boardingGate !== undefined) throw claimGateError(boardingGate);
        const forkGate = evaluateForkWaivers({
          doc,
          sinkNodeId: nodeId,
          task: current,
          next: forwardTo,
          evidence,
        });
        if (forkGate !== undefined) throw claimGateError(forkGate);
      } else {
        const terminalGate = evaluateTerminalClose({
          doc,
          sinkNodeId: nodeId,
          task: current,
          evidence,
        });
        if (terminalGate !== undefined) throw claimGateError(terminalGate);
      }
    }
    const defect = state === "rejected" ? options?.defect : undefined;
    if (defect !== undefined && !defect.summary.trim()) {
      throw new WorkError("invalid", "defect summary must be non-empty");
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
    } else if (defect !== undefined) {
      history = [
        ...history,
        makeAgentMessage({
          messageId: ids.messageId(),
          text: `defect: ${defect.summary.trim()}`,
          contextId,
          taskId,
        }),
      ];
    }
    let next = { ...taskWithTransitionState(current, state), history };

    if (state === "completed" && forwardTo !== undefined) {
      // Forward: stamp the passage exit here and mint the submitted successor
      // at the destination (re-homed, fresh claimedBy, computed holdUntil).
      const { journey, passage } = currentPassageFor(current, nodeId, nowIso);
      const claimedBy = claimedByOf(current);
      const exited: Passage = {
        ...passage,
        ...(claimedBy !== undefined && passage.claimedBy === undefined
          ? { claimedBy }
          : {}),
        exitedAt: nowIso,
        exit: "forwarded",
        next: forwardTo,
        ...(note?.trim() ? { emissionNote: note.trim() } : {}),
      };
      const closedJourney = [...journey, exited];
      next = { ...next, journey: closedJourney };
      const destinationNode = requireNode(doc, forwardTo);
      requireSink(destinationNode, ["task"]);
      const holdUntil = computeHoldUntil(
        nowMs,
        sinkContractOf(destinationNode)?.inbound?.claimableAfterMs,
        options?.holdForMs,
      );
      const brief: Message = {
        ...current.history[0]!,
        messageId: ids.messageId(),
        taskId,
      };
      const arrival = makeAgentMessage({
        messageId: ids.messageId(),
        text: note?.trim()
          ? `forwarded from "${nodeId}" — ${note.trim()}`
          : `forwarded from "${nodeId}"`,
        contextId,
        taskId,
      });
      forwarded = {
        nodeId: forwardTo,
        task: rehomedTask(
          current,
          closedJourney,
          forwardTo,
          taskEpoch(current),
          nowIso,
          holdUntil,
          rehomedHistory(doc, forwardTo, current, brief, arrival),
        ),
      };
    } else if (state === "completed" && (current.journey?.length ?? 0) > 0) {
      // Terminal close of a pipeline task: the passage record closes here.
      const { journey, passage } = currentPassageFor(current, nodeId, nowIso);
      const claimedBy = claimedByOf(current);
      next = {
        ...next,
        journey: [
          ...journey,
          {
            ...passage,
            ...(claimedBy !== undefined && passage.claimedBy === undefined
              ? { claimedBy }
              : {}),
            exitedAt: nowIso,
            exit: "closed",
          },
        ],
      };
    }

    if (defect !== undefined) {
      const { journey, passage } = currentPassageFor(current, nodeId, nowIso);
      const previous = journey[journey.length - 1];
      // Defect-to-target: any station the journey already visited is a legal
      // target; no target keeps today's meaning (the previous station).
      // Beginning and previous are just targets, never separate code paths.
      const target = defect.target ?? previous?.nodeId;
      if (defect.target !== undefined) {
        const visited = [...new Set(journey.map((entry) => entry.nodeId))];
        if (defect.target === nodeId) {
          throw new WorkError(
            "invalid",
            `defect target "${defect.target}" is this station — a defect sends the task back to a prior station`,
          );
        }
        if (!visited.includes(defect.target)) {
          throw new WorkError(
            "invalid",
            visited.length === 0
              ? `task "${taskId}" has no prior station to defect to`
              : `defect target "${defect.target}" is not a station this task has visited — pick one of [${visited.join(", ")}]`,
          );
        }
      }
      if (target !== undefined) {
        // Targeted defect: epoch++ and one append-only log entry. Liveness of
        // prior receipts is DERIVED from the log (a defect shadows receipts at
        // and downstream of its target); nothing is re-stamped or erased.
        const bumpedEpoch = taskEpoch(current) + 1;
        const defects = [
          ...(current.defects ?? []),
          { epoch: bumpedEpoch, target, at: nowIso },
        ];
        const claimedBy = claimedByOf(current);
        const exited: Passage = {
          ...passage,
          ...(claimedBy !== undefined && passage.claimedBy === undefined
            ? { claimedBy }
            : {}),
          exitedAt: nowIso,
          exit: "rejected-back",
          next: target,
        };
        const closedJourney = [...journey, exited];
        next = { ...next, journey: closedJourney, defects };
        const targetNode = requireNode(doc, target);
        requireSink(targetNode, ["task"]);
        const holdUntil = computeHoldUntil(
          nowMs,
          sinkContractOf(targetNode)?.inbound?.claimableAfterMs,
          undefined,
        );
        const brief: Message = {
          ...current.history[0]!,
          messageId: ids.messageId(),
          taskId,
        };
        const defectNote = makeAgentMessage({
          messageId: ids.messageId(),
          text: [
            `defect from "${nodeId}": ${defect.summary.trim()}`,
            ...(defect.refs ?? []).map((ref) => `ref: ${ref}`),
          ].join("\n"),
          contextId,
          taskId,
        });
        defectBack = {
          nodeId: target,
          task: rehomedTask(
            { ...current, defects },
            closedJourney,
            target,
            bumpedEpoch,
            nowIso,
            holdUntil,
            rehomedHistory(doc, target, current, brief, defectNote),
          ),
        };
      }
    }

    if (state === "completed" && evidence !== undefined) {
      return { ...next, completionEvidence: evidence };
    }
    if (state !== "completed") {
      const { completionEvidence: _cleared, ...rest } = next;
      return rest;
    }
    return next;
  });

  let nextDoc = withTasks(doc, nodeId, nextItems);
  if (forwarded !== undefined) {
    const destinationItems =
      nextDoc.nodes.find((n) => n.id === forwarded!.nodeId)?.ether?.tasks
        ?.items ?? [];
    nextDoc = withTasks(
      nextDoc,
      forwarded.nodeId,
      replaceOrAppendTask(destinationItems, forwarded.task),
    );
  }
  if (defectBack !== undefined) {
    const previousItems =
      nextDoc.nodes.find((n) => n.id === defectBack!.nodeId)?.ether?.tasks
        ?.items ?? [];
    nextDoc = withTasks(
      nextDoc,
      defectBack.nodeId,
      replaceOrAppendTask(previousItems, defectBack.task),
    );
  }
  return {
    doc: nextDoc,
    task,
    ...(forwarded !== undefined ? { forwarded } : {}),
    ...(defectBack !== undefined ? { defectBack } : {}),
  };
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
        `task "${taskId}" already assigned to "${existing}"`,
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
      // Pipeline admission: seats never claim at operator-owned sinks; baking
      // and unpromoted operator-gated arrivals are not claimable yet.
      const admission = taskAdmissionState(
        current,
        sinkContractOf(node),
        Date.now(),
      );
      if (admission === "operator-owned") {
        throw new WorkError(
          "claim_contention",
          `sink "${nodeId}" is operator-owned; the operator works tasks here — no seat claim`,
        );
      }
      if (admission === "held") {
        throw new WorkError(
          "invalid",
          `task "${taskId}" is not assignable before ${current.holdUntil} (station bake)`,
        );
      }
      if (admission === "operator-gated") {
        throw new WorkError(
          "invalid",
          `task "${taskId}" awaits operator approval at sink "${nodeId}"`,
        );
      }
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
        text: `assigned to ${actor.seatId}`,
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
  rejectReservedPipelineMetadata(metadata);
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

/** Soft-archive flag lives in metadata so decode admits history without schema migration. */
export const isArtifactArchived = (artifact: Artifact): boolean =>
  artifact.metadata?.archived === true;

const withArtifactArchivedFlag = (
  artifact: Artifact,
  archived: boolean,
): Artifact => {
  const nextMeta: Record<string, unknown> = { ...(artifact.metadata ?? {}) };
  if (archived) {
    nextMeta.archived = true;
  } else {
    delete nextMeta.archived;
  }
  if (Object.keys(nextMeta).length === 0) {
    const { metadata: _drop, ...rest } = artifact;
    return rest;
  }
  return { ...artifact, metadata: nextMeta as WorkMetadata };
};

/** Operator soft-archive / restore. Does not delete parts or content refs. */
export const workArtifactArchive = (
  doc: CanvasDoc,
  nodeId: string,
  artifactId: string,
  archived: boolean,
): WorkArtifactResult => {
  const node = requireNode(doc, nodeId);
  requireSink(node, ["artifacts"]);
  const id = artifactId.trim();
  if (!id) throw new WorkError("invalid", "artifactId must be non-empty");
  const items = node.ether?.artifacts?.items ?? [];
  const index = items.findIndex((item) => item.artifactId === id);
  if (index < 0) {
    throw new WorkError("task_not_found", `artifact "${id}" not found`);
  }
  const current = items[index]!;
  const artifact = withArtifactArchivedFlag(current, archived);
  const next = [...items];
  next[index] = artifact;
  return { doc: withArtifacts(doc, nodeId, next), artifact };
};

/** Hard-remove an artifact from the sink (operator). Content objects are retained. */
export const workArtifactDelete = (
  doc: CanvasDoc,
  nodeId: string,
  artifactId: string,
): { readonly doc: CanvasDoc; readonly artifactId: string } => {
  const node = requireNode(doc, nodeId);
  requireSink(node, ["artifacts"]);
  const id = artifactId.trim();
  if (!id) throw new WorkError("invalid", "artifactId must be non-empty");
  const items = node.ether?.artifacts?.items ?? [];
  if (!items.some((item) => item.artifactId === id)) {
    throw new WorkError("task_not_found", `artifact "${id}" not found`);
  }
  return {
    doc: withArtifacts(
      doc,
      nodeId,
      items.filter((item) => item.artifactId !== id),
    ),
    artifactId: id,
  };
};
