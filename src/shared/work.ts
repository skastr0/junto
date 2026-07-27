import type {
  WorkMetadata,
  Task,
  Artifact,
  CanvasDoc,
  CanvasNode,
  Message,
  TaskState,
  TextNode,
} from "./canvas";
import {
  canTransitionTaskState,
  claimedByOf,
  isTerminalTaskState,
  makeAgentMessage,
  makeUserMessage,
  mirrorArtifactsText,
  mirrorRequestsText,
  mirrorTasksText,
} from "./task";
import { groupMembers, isGroup } from "./graph";
import { resolveSpec } from "./physics";
import { Match } from "effect";

// Pure document transforms for the work plane.
// Kernel WorkService applies these under CanvasesService.mutate.
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

const requireKind = (node: CanvasNode, kinds: ReadonlyArray<string>): string => {
  const kind = node.ether?.entity?.kind;
  if (!kind || !kinds.includes(kind)) {
    throw new WorkError(
      "illegal_kind",
      `node "${node.id}" kind is ${kind ?? "none"}; expected ${kinds.join("|")}`,
    );
  }
  return kind;
};

/**
 * The message inbox is an actor power, and not every actor holds one — a raw
 * terminal has nothing to read a message into. Exhaustive over NodeSpec, so
 * this rule is a per-variant decision rather than a third hand-kept copy of
 * the kind list that `work/authz` (`opsForSpec`) and `work-canvas-merge`
 * (`isWorkSurfaceKind`) already decide the same way.
 *
 * Group-ness is deliberately not consulted: the predicate reads the authored
 * kind, exactly as the list it replaces did.
 */
const requireMessageInbox = (node: CanvasNode): void => {
  const kind = node.ether?.entity?.kind;
  const holdsInbox = Match.value(resolveSpec({ isGroup: false, kind })).pipe(
    Match.tagsExhaustive({
      Actor: (spec) => spec.kind !== "terminal",
      Sink: () => false,
      Scheduler: () => false,
      Geography: () => false,
    }),
  );
  if (!holdsInbox) {
    throw new WorkError(
      "illegal_kind",
      `node "${node.id}" kind is ${kind ?? "none"}; expected an actor inbox`,
    );
  }
};

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
        tasks: { items: [...items] },
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
  const next = items.map((t, i) => (i === idx ? patch(t) : t));
  return { items: next as Task[], task: next[idx]! };
};

const mergeMetadata = (
  existing: WorkMetadata | undefined,
  patch: WorkMetadata | undefined,
): WorkMetadata | undefined => {
  if (!existing && !patch) return undefined;
  return { ...(existing ?? {}), ...(patch ?? {}) };
};

export type WorkTaskCreateResult = { readonly doc: CanvasDoc; readonly task: Task };
export type WorkTaskResult = { readonly doc: CanvasDoc; readonly task: Task };
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
): WorkTaskCreateResult => {
  const node = requireNode(doc, nodeId);
  requireKind(node, ["task"]);
  const trimmed = brief.trim();
  if (!trimmed) throw new WorkError("invalid", "brief must be non-empty");
  const taskId = ids.id();
  const contextId = regionContextId(doc, nodeId, canvasName);
  const briefMessage = makeUserMessage({
    messageId: ids.messageId(),
    text: trimmed,
    contextId,
    taskId,
  });
  const why = reason?.trim();
  const task: Task = {
    id: taskId,
    state: "submitted",
    history: [briefMessage],
    ...(metadata ? { metadata } : {}),
    ...(why ? { reason: why } : {}),
  };
  const items = [...(node.ether?.tasks?.items ?? []), task];
  return { doc: withTasks(doc, nodeId, items), task };
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
  requireKind(node, ["task"]);
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

export const workTaskTransition = (
  doc: CanvasDoc,
  canvasName: string,
  nodeId: string,
  taskId: string,
  state: TaskState,
  note: string | undefined,
  ids: WorkIds,
): WorkTaskResult => {
  const node = requireNode(doc, nodeId);
  requireKind(node, ["task"]);
  const items = node.ether?.tasks?.items ?? [];
  const contextId = regionContextId(doc, nodeId, canvasName);
  const { items: nextItems, task } = patchTaskInList(items, taskId, (current) => {
    if (!canTransitionTaskState(current.state, state)) {
      throw new WorkError(
        "illegal_transition",
        `cannot transition task "${taskId}" from ${current.state} to ${state}`,
      );
    }
    let history = current.history;
    if (note?.trim()) {
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
    return { ...current, state, history };
  });
  return { doc: withTasks(doc, nodeId, nextItems), task };
};

export const workTaskClaim = (
  doc: CanvasDoc,
  canvasName: string,
  nodeId: string,
  taskId: string,
  actor: string,
  ids: WorkIds,
): WorkTaskResult => {
  const node = requireNode(doc, nodeId);
  requireKind(node, ["task"]);
  const actorTrim = actor.trim();
  if (!actorTrim) throw new WorkError("invalid", "actor must be non-empty");
  // Claiming is a worker/factory act — never the human operator label.
  const reserved = actorTrim.toLowerCase();
  if (reserved === "operator" || reserved === "user" || reserved === "human") {
    throw new WorkError(
      "invalid",
      `claimedBy must be a worker identity, not "${actorTrim}"`,
    );
  }
  const items = node.ether?.tasks?.items ?? [];
  const contextId = regionContextId(doc, nodeId, canvasName);
  const { items: nextItems, task } = patchTaskInList(items, taskId, (current) => {
    const existing = claimedByOf(current);
    if (existing && existing !== actorTrim) {
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
    const metadata = mergeMetadata(current.metadata, { claimedBy: actorTrim });
    // Idempotent re-claim by same actor keeps working + claimedBy.
    if (current.state === "working" && existing === actorTrim) {
      return { ...current, metadata };
    }
    const history =
      current.state === "working"
        ? current.history
        : [
            ...current.history,
            makeAgentMessage({
              messageId: ids.messageId(),
              text: `claimed by ${actorTrim}`,
              contextId,
              taskId,
            }),
          ];
    return {
      ...current,
      state: "working",
      history,
      ...(metadata ? { metadata } : {}),
    };
  });
  return { doc: withTasks(doc, nodeId, nextItems), task };
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
    const kind = requireKind(node, ["task", "requests"]);
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
  raisedBy?: string,
  reason?: string,
): WorkTaskCreateResult => {
  const node = requireNode(doc, nodeId);
  requireKind(node, ["requests"]);
  const trimmed = brief.trim();
  if (!trimmed) throw new WorkError("invalid", "brief must be non-empty");
  // A request raised by an actor is claimed by that actor at birth — the
  // raiser is the worker waiting on the answer, so stoppage lands on it.
  // Operator-seeded requests (no raiser) are unclaimed inventory.
  const raiser = raisedBy?.trim();
  if (raiser !== undefined && raiser.length > 0) {
    const reserved = raiser.toLowerCase();
    if (reserved === "operator" || reserved === "user" || reserved === "human") {
      throw new WorkError(
        "invalid",
        `raisedBy must be a worker seat, not "${raiser}"`,
      );
    }
  }
  const taskId = ids.id();
  const contextId = regionContextId(doc, nodeId, canvasName);
  const briefMessage = makeUserMessage({
    messageId: ids.messageId(),
    text: trimmed,
    contextId,
    taskId,
  });
  const stamped = raiser
    ? mergeMetadata(metadata, { claimedBy: raiser })
    : metadata;
  const why = reason?.trim();
  const task: Task = {
    id: taskId,
    state: "input-required",
    history: [briefMessage],
    ...(stamped ? { metadata: stamped } : {}),
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
  requireKind(node, ["requests"]);
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
  _canvasName: string,
  nodeId: string,
  artifact: Artifact,
): WorkArtifactResult => {
  const node = requireNode(doc, nodeId);
  requireKind(node, ["artifacts"]);
  if (!artifact.artifactId.trim()) {
    throw new WorkError("invalid", "artifactId must be non-empty");
  }
  if (!Array.isArray(artifact.parts) || artifact.parts.length === 0) {
    throw new WorkError("invalid", "artifact must have at least one part");
  }
  const existing = node.ether?.artifacts?.items ?? [];
  if (existing.some((a) => a.artifactId === artifact.artifactId)) {
    throw new WorkError("invalid", `artifact "${artifact.artifactId}" already exists`);
  }
  const items = [...existing, artifact];
  return { doc: withArtifacts(doc, nodeId, items), artifact };
};
