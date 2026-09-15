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
  TaskRule,
  TaskState,
  TaskAdmission,
  FinishCriteria,
  CompletionEvidence,
  Visit,
} from "./work-model";
import { resolveTaskAdmission } from "./work-model";
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
  validateAuthoredTaskDependsOn,
  validateTaskDependsOn,
} from "./task-deps";
import {
  artifactsByNodeFromDoc,
  evaluateFinishCriteria,
  normalizeCompletionEvidence,
  normalizeFinishCriteria,
} from "./finish-criteria";
import {
  boardContractOf,
  clampRequestedAdmission,
  computeWaitUntil,
  evaluateChecks,
  evaluateForkWaivers,
  evaluateRules,
  evaluateTerminalClose,
  normalizeRuleEvidence,
  requiredChecks,
  rulesInForce,
  taskAdmissionState,
  taskEpoch,
  type RuleFailure,
} from "./rules";
import { flowDestinations, reachableBoards } from "./flow-graph";
import { groupMembers, isGroup } from "./graph";
import {
  ACTOR_ACTOR_INBOX_PORTS,
  NodeSpec,
  resolveSpec,
  type ActorSpec,
  type SinkKind,
} from "./physics";
import { HashSet } from "effect";

// Pure topology validation plus work-item transforms. WorkService uses their
// results to invoke specific SQLite repository verbs; these helpers never
// authorize or commit a canvas-document mutation.
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

/**
 * Write a Tasks board projection. Items are the runtime Work rows; `name` and
 * `contract` are operator-authored document truth that projections must never
 * erase.
 */
const withTasks = (
  doc: CanvasDoc,
  nodeId: string,
  items: ReadonlyArray<Task>,
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
          ...(n.ether?.tasks?.name !== undefined
            ? { name: n.ether.tasks.name }
            : {}),
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
    // The authored name is operator document truth, like ether.tasks.name —
    // the mirror (identity + count + briefs) regenerates beneath it.
    const name = n.ether?.requests?.name;
    return {
      ...n,
      ...(tn ? { text: mirrorRequestsText(items, name) } : {}),
      ether: {
        ...(n.ether ?? {}),
        entity: n.ether?.entity ?? { kind: "requests" },
        requests: {
          items: [...items],
          ...(name !== undefined ? { name } : {}),
        },
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
 * Authoring-input-only guard (create): system-stamped task state — the
 * approval marker and canonical task bag — is never accepted from caller
 * metadata. Existing durable rows legitimately carry the approval marker, so
 * this never runs on patched tasks.
 */
const rejectReservedTaskMetadata = (
  metadata: WorkMetadata | undefined,
): void => {
  if (metadata === undefined) return;
  for (const key of Object.keys(metadata)) {
    if (key.startsWith("vellum.tasks")) {
      throw new WorkError(
        "invalid",
        "metadata keys under vellum.tasks are reserved for the work service",
      );
    }
  }
};

/**
 * Tasks always carry a non-empty description (`metadata.details`).
 * Title/brief alone is not enough — create rejects empty/missing description.
 * Historical rows without details still decode (create-only gate).
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

/** Normalize metadata so create always persists trimmed details. */
const withRequiredDescription = (
  metadata: WorkMetadata | undefined,
): WorkMetadata => {
  const details = requireTaskDescription(metadata);
  return { ...(metadata ?? {}), details };
};

export type WorkTaskCreateOptions = {
  readonly admission?: TaskAdmission;
  /**
   * Agent wire omit persists an explicit `approval` stamp; operator enqueue
   * inherits the board floor.
   */
  readonly admissionOmitted?: "approval" | "inherit";
  /** Explicit task wait before the first claim, in ms; wins over the board default. */
  readonly waitForMs?: number;
  readonly raisedBy?: ActorRef;
  readonly nowMs?: number;
};

export type WorkTaskCreateResult = { readonly doc: CanvasDoc; readonly task: Task };
export type WorkTaskResult = { readonly doc: CanvasDoc; readonly task: Task };
export type WorkTaskClaimResult = WorkTaskResult & {
  readonly claimedBy: ActorRef;
};
export type WorkMessageResult = { readonly doc: CanvasDoc; readonly message: Message };
export type WorkArtifactResult = { readonly doc: CanvasDoc; readonly artifact: Artifact };

/**
 * Authoring-input validation for board-addressed task rules: every rule id is
 * unique, and every board target exists, is a Tasks node, and is reachable
 * from the origin board on the current flow graph.
 */
const validateTaskRules = (
  doc: CanvasDoc,
  originNodeId: string,
  rules: ReadonlyArray<TaskRule> | undefined,
): void => {
  if (rules === undefined || rules.length === 0) return;
  const seen = new Set<string>();
  const reachable = reachableBoards(doc, originNodeId);
  for (const rule of rules) {
    if (seen.has(rule.id)) {
      throw new WorkError("invalid", `task rule id "${rule.id}" is duplicated`);
    }
    seen.add(rule.id);
    const target = doc.nodes.find((n) => n.id === rule.board);
    if (target === undefined) {
      throw new WorkError(
        "invalid",
        `task rule "${rule.id}" targets unknown board "${rule.board}"`,
      );
    }
    requireSink(target, ["task"]);
    if (!reachable.has(rule.board)) {
      throw new WorkError(
        "invalid",
        `task rule "${rule.id}" targets board "${rule.board}", which is not reachable from "${originNodeId}" on the current flow graph`,
      );
    }
  }
};

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
  /** Board-addressed rules; set at creation, immutable on generic transitions. */
  rules?: ReadonlyArray<TaskRule>,
  options?: WorkTaskCreateOptions,
): WorkTaskCreateResult => {
  const node = requireNode(doc, nodeId);
  requireSink(node, ["task"]);
  const trimmed = brief.trim();
  if (!trimmed) throw new WorkError("invalid", "brief must be non-empty");
  rejectRetiredClaimMetadata(metadata);
  rejectReservedTaskMetadata(metadata);
  const nextMetadata = withRequiredDescription(metadata);
  const mediaError = validateTaskMediaParts(media);
  if (mediaError) throw new WorkError("invalid", mediaError);
  const authoredDepError = validateAuthoredTaskDependsOn(dependsOn);
  if (authoredDepError) throw new WorkError("invalid", authoredDepError);
  validateTaskRules(doc, nodeId, rules);
  const contract = boardContractOf(node);
  const clamped = clampRequestedAdmission({
    floor: resolveTaskAdmission(contract),
    requested: options?.admission,
    omitted: options?.admissionOmitted ?? "inherit",
  });
  if (!clamped.ok) throw new WorkError("invalid", clamped.message);
  const waitUntil = computeWaitUntil(
    options?.nowMs ?? Date.now(),
    contract?.incoming?.waitMs,
    options?.waitForMs,
  );
  const taskId = ids.id();
  const existing = node.ether?.tasks?.items ?? [];
  const depError = validateTaskDependsOn({
    taskId,
    dependsOn,
    byId: dependencyScopeIndex(doc, nodeId),
  });
  if (depError) throw new WorkError("invalid", depError);
  const normalizedDeps = normalizeDependsOn(dependsOn);
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
  const normalizedRules = rules && rules.length > 0 ? rules : undefined;
  const task: Task = {
    id: taskId,
    state: "submitted",
    history: [briefMessage],
    metadata: nextMetadata,
    ...(why ? { reason: why } : {}),
    ...(normalizedDeps ? { dependsOn: normalizedDeps } : {}),
    ...(criteria !== undefined ? { finishCriteria: criteria } : {}),
    ...(normalizedRules ? { rules: normalizedRules } : {}),
    ...(clamped.stamp !== undefined ? { admission: clamped.stamp } : {}),
    ...(options?.raisedBy !== undefined ? { raisedBy: options.raisedBy } : {}),
    ...(waitUntil !== undefined ? { waitUntil } : {}),
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
   * Next board on → completed at a board with a task path.
   * Required when the board has more than one Next; auto-resolved when
   * it has exactly one. Validated against live flow edges (act-time DAG law).
   */
  readonly next?: string;
  /** Defect payload on → rejected for a task with a prior visit. */
  readonly defect?: {
    readonly summary: string;
    readonly refs?: ReadonlyArray<string>;
    /**
     * Visited board to send the task back to; omitted = the previous
     * board, or this board in place when the task has no prior visit.
     * Naming the current board explicitly stays refused.
     */
    readonly target?: string;
  };
  /** Per-task send-on wait stamp (ms); wins over the next board's waitMs. */
  readonly waitForMs?: number;
  /** Prose the agent writes when sending a task onward. */
  readonly handoffNote?: string;
  /** Clock for visit/wait stamps. Default Date.now(). */
  readonly nowMs?: number;
};

export type WorkTaskTransitionResult = WorkTaskResult & {
  /** Present when completion sent the task on to its next board. */
  readonly sentOn?: { readonly nodeId: string; readonly task: Task };
  /**
   * Present when a defect sent the task back — to an earlier board, or
   * in place when the task had no prior board to send back to.
   */
  readonly sentBack?: { readonly nodeId: string; readonly task: Task };
};

const completionGateError = (failure: RuleFailure): WorkError =>
  // Same shape as the finish-criteria failure so the control plane surfaces
  // missing/next_step through the one InvalidTransition mapping.
  new WorkError(
    "illegal_transition",
    `completion gate unsatisfied [${failure.missing}]: ${failure.message} (next: ${failure.next_step})`,
  );

/**
 * True when `task`'s current-epoch visits tail closed here with an exit
 * that already re-homed the live successor to another board (sent-on or
 * sent-back). Such a row is a closed visit record, not live work — re-opening
 * it via the generic submitted-entry path would mint a second live row for
 * the same task id (invariant: no split/rejoin).
 */
const isExitedVisitRow = (task: Task, nodeId: string): boolean => {
  const last = (task.visits ?? []).at(-1);
  return (
    last !== undefined &&
    last.board === nodeId &&
    last.epoch === taskEpoch(task) &&
    (last.exit === "sent-on" || last.exit === "sent-back")
  );
};

/**
 * The visit the task is currently living: the last visits entry when it names
 * this board and has not exited; otherwise a fresh entry synthesized at exit
 * time (tasks born before visits were recorded have no entry).
 */
const currentVisitFor = (
  task: Task,
  nodeId: string,
  nowIso: string,
): { readonly visits: ReadonlyArray<Visit>; readonly visit: Visit } => {
  const visits = task.visits ?? [];
  const last = visits[visits.length - 1];
  if (last !== undefined && last.board === nodeId && last.exit === undefined) {
    return { visits: visits.slice(0, -1), visit: last };
  }
  return {
    visits,
    visit: { board: nodeId, enteredAt: nowIso, epoch: taskEpoch(task) },
  };
};

/** Metadata for a re-homed task: the approval marker is epoch-scoped, so it drops. */
const rehomedMetadata = (
  metadata: WorkMetadata | undefined,
): WorkMetadata | undefined => {
  if (metadata === undefined) return undefined;
  const keys = Object.keys(metadata).filter(
    (key) => key.startsWith("vellum.tasks"),
  );
  if (keys.length === 0) return metadata;
  const rest = { ...metadata };
  for (const key of keys) delete rest[key];
  return Object.keys(rest).length > 0 ? (rest as WorkMetadata) : undefined;
};

/**
 * Build the submitted successor of `task` at `destination`. dependsOn stays
 * behind: prerequisites gate the first claim at the origin board and are
 * already satisfied by the time the task travels.
 */
const rehomedTask = (
  task: Task,
  closedVisits: ReadonlyArray<Visit>,
  destination: string,
  epoch: number,
  enteredAt: string,
  waitUntil: string | undefined,
  history: ReadonlyArray<Message>,
): Task => {
  const {
    claimedBy: _claimedBy,
    completionEvidence: _evidence,
    dependsOn: _deps,
    waitUntil: _wait,
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
    visits: [...closedVisits, { board: destination, enteredAt, epoch }],
    ...(waitUntil !== undefined ? { waitUntil } : {}),
    ...(metadata !== undefined ? { metadata } : {}),
  };
};

/**
 * The successor thread at `destination`: extend the board's existing row
 * thread when the task has been here before (send-back cycles), else start
 * from a fresh copy of the brief. Prior visits' interiors stay on their own
 * board rows.
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
  const handoff = options?.handoffNote?.trim();
  const evidence =
    state === "completed"
      ? normalizeRuleEvidence(
          normalizeCompletionEvidence(completionEvidence),
          completionEvidence,
        )
      : state === "working" && completionEvidence !== undefined
        ? normalizeCompletionEvidence(completionEvidence)
        : undefined;
  const destinations =
    state === "completed" ? flowDestinations(doc, nodeId) : [];
  const nextBoardId =
    destinations.length === 0
      ? undefined
      : options?.next ?? (destinations.length === 1 ? destinations[0] : undefined);
  if (destinations.length > 1 && options?.next === undefined && state === "completed") {
    throw new WorkError(
      "invalid",
      `board "${nodeId}" has more than one Next; pick next from [${destinations.join(", ")}]`,
    );
  }
  if (nextBoardId !== undefined && !destinations.includes(nextBoardId)) {
    throw new WorkError(
      "invalid",
      `"${nextBoardId}" is not a live Next for board "${nodeId}" [${destinations.join(", ")}]`,
    );
  }
  if (nextBoardId === nodeId) {
    throw new WorkError("invalid", `board "${nodeId}" cannot send a task on to itself`);
  }

  let sentOn: { readonly nodeId: string; readonly task: Task } | undefined;
  let sentBack: { readonly nodeId: string; readonly task: Task } | undefined;

  const { items: nextItems, task } = patchTaskInList(items, taskId, (current) => {
    if (!canTransitionTaskState(current.state, state)) {
      throw new WorkError(
        "illegal_transition",
        `cannot transition task "${taskId}" from ${current.state} to ${state}`,
      );
    }
    if (state === "submitted" && isExitedVisitRow(current, nodeId)) {
      throw new WorkError(
        "illegal_transition",
        `task "${taskId}" at "${nodeId}" is a closed visit record (exit: ${current.visits?.at(-1)?.exit}) — re-opening it here would create a second live row for this task; the live copy was already re-homed`,
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
      // Structural rules gate — doc-derived, so it runs at every caller
      // (unlike the SQLite-shelf finish gate, which is home-local).
      const rulesGate = evaluateRules({
        rules: rulesInForce(doc, nodeId, current),
        evidence,
      });
      if (rulesGate !== undefined) throw completionGateError(rulesGate);
      if (nextBoardId !== undefined) {
        const checksGate = evaluateChecks({
          task: current,
          checks: requiredChecks(doc, nodeId, nextBoardId),
        });
        if (checksGate !== undefined) throw completionGateError(checksGate);
        const forkGate = evaluateForkWaivers({
          doc,
          boardId: nodeId,
          task: current,
          next: nextBoardId,
          evidence,
        });
        if (forkGate !== undefined) throw completionGateError(forkGate);
      } else {
        const terminalGate = evaluateTerminalClose({
          doc,
          boardId: nodeId,
          task: current,
          evidence,
        });
        if (terminalGate !== undefined) throw completionGateError(terminalGate);
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

    if (state === "completed" && nextBoardId !== undefined) {
      // Send on: stamp the visit exit here and mint the submitted successor
      // at the next board (re-homed, fresh claimedBy, computed waitUntil).
      const { visits, visit } = currentVisitFor(current, nodeId, nowIso);
      const claimedBy = claimedByOf(current);
      const exited: Visit = {
        ...visit,
        ...(claimedBy !== undefined && visit.claimedBy === undefined
          ? { claimedBy }
          : {}),
        exitedAt: nowIso,
        exit: "sent-on",
        next: nextBoardId,
        ...(handoff ? { handoffNote: handoff } : {}),
      };
      const closedVisits = [...visits, exited];
      next = { ...next, visits: closedVisits };
      const destinationNode = requireNode(doc, nextBoardId);
      requireSink(destinationNode, ["task"]);
      const waitUntil = computeWaitUntil(
        nowMs,
        boardContractOf(destinationNode)?.incoming?.waitMs,
        options?.waitForMs,
      );
      const brief: Message = {
        ...current.history[0]!,
        messageId: ids.messageId(),
        taskId,
      };
      const sentOnNote = makeAgentMessage({
        messageId: ids.messageId(),
        text: handoff
          ? `sent on from "${nodeId}" — ${handoff}`
          : note?.trim()
            ? `sent on from "${nodeId}" — ${note.trim()}`
            : `sent on from "${nodeId}"`,
        contextId,
        taskId,
      });
      sentOn = {
        nodeId: nextBoardId,
        task: rehomedTask(
          current,
          closedVisits,
          nextBoardId,
          taskEpoch(current),
          nowIso,
          waitUntil,
          rehomedHistory(doc, nextBoardId, current, brief, sentOnNote),
        ),
      };
    } else if (state === "completed" && (current.visits?.length ?? 0) > 0) {
      // Terminal close of a moved task: the visit record closes here.
      const { visits, visit } = currentVisitFor(current, nodeId, nowIso);
      const claimedBy = claimedByOf(current);
      next = {
        ...next,
        visits: [
          ...visits,
          {
            ...visit,
            ...(claimedBy !== undefined && visit.claimedBy === undefined
              ? { claimedBy }
              : {}),
            exitedAt: nowIso,
            exit: "completed",
          },
        ],
      };
    }

    if (defect !== undefined) {
      const { visits, visit } = currentVisitFor(current, nodeId, nowIso);
      const previous = visits[visits.length - 1];
      // Defect-to-target: any board the task already visited is a legal
      // target; no target keeps today's meaning (the previous board). A
      // defect on a task with no prior board starts over at this same
      // board: the defect log entry and epoch bump still land, so prior
      // claims, checks and review verdicts go stale, and the task
      // re-homes in place as submitted instead of dying rejected with
      // live claims. Explicitly naming this board as target stays
      // refused (see the guard below) — only the implicit default arms
      // in-place re-home.
      const target = defect.target ?? previous?.board ?? nodeId;
      if (defect.target !== undefined) {
        const visited = [...new Set(visits.map((entry) => entry.board))];
        if (defect.target === nodeId) {
          throw new WorkError(
            "invalid",
            `defect target "${defect.target}" is this board — a defect sends the task back to a prior board`,
          );
        }
        if (!visited.includes(defect.target)) {
          throw new WorkError(
            "invalid",
            visited.length === 0
              ? `task "${taskId}" has no prior board to send back to`
              : `defect target "${defect.target}" is not a board this task has visited — pick one of [${visited.join(", ")}]`,
          );
        }
      }
      if (target !== undefined) {
        // Targeted defect: epoch++ and one append-only log entry. Liveness of
        // prior claims is DERIVED from the log (a defect shadows claims at
        // and downstream of its target); nothing is re-stamped or erased.
        const bumpedEpoch = taskEpoch(current) + 1;
        const defects = [
          ...(current.defects ?? []),
          { epoch: bumpedEpoch, target, at: nowIso },
        ];
        const claimedBy = claimedByOf(current);
        const exited: Visit = {
          ...visit,
          ...(claimedBy !== undefined && visit.claimedBy === undefined
            ? { claimedBy }
            : {}),
          exitedAt: nowIso,
          exit: "sent-back",
          next: target,
        };
        const closedVisits = [...visits, exited];
        next = { ...next, visits: closedVisits, defects };
        const targetNode = requireNode(doc, target);
        requireSink(targetNode, ["task"]);
        const waitUntil = computeWaitUntil(
          nowMs,
          boardContractOf(targetNode)?.incoming?.waitMs,
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
        sentBack = {
          nodeId: target,
          task: rehomedTask(
            { ...current, defects },
            closedVisits,
            target,
            bumpedEpoch,
            nowIso,
            waitUntil,
            rehomedHistory(doc, target, current, brief, defectNote),
          ),
        };
      }
    }

    if (
      (state === "completed" || state === "working") &&
      evidence !== undefined
    ) {
      // Staged review evidence: a working update may attach completion
      // evidence (typed refs, claims) without completing, so an independent
      // reviewer has durable refs to judge and the completion gate can run
      // against exactly what was staged. The evidence is re-hashed into the
      // review subject, so replacing the staging unblesses any prior green.
      return { ...next, completionEvidence: evidence };
    }
    if (state !== "completed" && state !== "working") {
      // Rejection/cancel/release clears staged evidence with the state
      // change; a re-home drops it again, so a bumped epoch starts clean.
      const { completionEvidence: _cleared, ...rest } = next;
      return rest;
    }
    return next;
  });

  let nextDoc = withTasks(doc, nodeId, nextItems);
  if (sentOn !== undefined) {
    const destinationItems =
      nextDoc.nodes.find((n) => n.id === sentOn!.nodeId)?.ether?.tasks
        ?.items ?? [];
    nextDoc = withTasks(
      nextDoc,
      sentOn.nodeId,
      replaceOrAppendTask(destinationItems, sentOn.task),
    );
  }
  if (sentBack !== undefined) {
    const previousItems =
      nextDoc.nodes.find((n) => n.id === sentBack!.nodeId)?.ether?.tasks
        ?.items ?? [];
    nextDoc = withTasks(
      nextDoc,
      sentBack.nodeId,
      replaceOrAppendTask(previousItems, sentBack.task),
    );
  }
  return {
    doc: nextDoc,
    task,
    ...(sentOn !== undefined ? { sentOn } : {}),
    ...(sentBack !== undefined ? { sentBack } : {}),
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
    // (deps may live on other Tasks boards in the same region).
    if (current.state === "submitted") {
      // Admission: seats never claim at a Me board; waiting and Approval
      // boards are not claimable yet.
      const admission = taskAdmissionState(
        current,
        boardContractOf(node),
        Date.now(),
      );
      if (admission === "operator") {
        throw new WorkError(
          "claim_contention",
          `board "${nodeId}" is set to Me — the operator works tasks here; no seat claim`,
        );
      }
      if (admission === "waiting") {
        throw new WorkError(
          "invalid",
          `task "${taskId}" is not claimable before ${current.waitUntil} (wait before starting)`,
        );
      }
      if (admission === "approval") {
        throw new WorkError(
          "invalid",
          `task "${taskId}" awaits operator approval at board "${nodeId}"`,
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
  rejectReservedTaskMetadata(metadata);
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
