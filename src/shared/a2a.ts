import type {
  A2AMetadata,
  A2ATask,
  Artifact,
  Message,
  Part,
  TaskState,
} from "./canvas";

// Display + transition helpers for the A2A work plane. Pure — no I/O.

/** First text line of history[0] (the brief); falls back to task id. */
export const taskBrief = (task: A2ATask): string => {
  const first = task.history[0];
  if (!first) return task.id;
  for (const part of first.parts) {
    if (part.kind === "text") {
      const line = part.text.split("\n")[0]?.trim();
      if (line) return line;
    }
  }
  return task.id;
};

export const isTerminalTaskState = (state: TaskState): boolean =>
  state === "completed" || state === "canceled" || state === "failed" || state === "rejected";

/** Legal outbound transitions. Terminal states have no exits. */
const LEGAL_TRANSITIONS: Readonly<Record<TaskState, ReadonlySet<TaskState>>> = {
  submitted: new Set([
    "working",
    "input-required",
    "completed",
    "canceled",
    "failed",
    "rejected",
    "auth-required",
  ]),
  working: new Set([
    "working",
    "input-required",
    "completed",
    "canceled",
    "failed",
    "rejected",
    "auth-required",
  ]),
  "input-required": new Set(["working", "completed", "canceled", "rejected", "auth-required"]),
  "auth-required": new Set(["working", "canceled", "rejected", "failed"]),
  completed: new Set(),
  canceled: new Set(),
  failed: new Set(),
  rejected: new Set(),
};

export const canTransitionTaskState = (from: TaskState, to: TaskState): boolean =>
  LEGAL_TRANSITIONS[from].has(to);

/** Tasks node text mirror: one brief line per item (human-readable offline). */
export const mirrorTasksText = (items: ReadonlyArray<A2ATask>): string => {
  if (items.length === 0) return "tasks";
  return items.map(taskBrief).join("\n");
};

/** Requests node text mirror: pending count + briefs. */
export const mirrorRequestsText = (items: ReadonlyArray<A2ATask>): string => {
  const pending = items.filter((item) => item.state === "input-required").length;
  const header = `${pending} pending`;
  if (items.length === 0) return header;
  return [header, ...items.map(taskBrief)].join("\n");
};

/** Artifacts node text mirror: names (or artifact ids). */
export const mirrorArtifactsText = (items: ReadonlyArray<Artifact>): string => {
  if (items.length === 0) return "artifacts";
  return items.map((item) => item.name?.trim() || item.artifactId).join("\n");
};

export const countByTaskState = (
  items: ReadonlyArray<A2ATask>,
): Readonly<Record<TaskState, number>> => {
  const counts: Record<TaskState, number> = {
    submitted: 0,
    working: 0,
    "input-required": 0,
    completed: 0,
    canceled: 0,
    failed: 0,
    rejected: 0,
    "auth-required": 0,
  };
  for (const item of items) counts[item.state] += 1;
  return counts;
};

export const makeTextParts = (text: string): Part[] => [{ kind: "text", text }];

export const makeUserMessage = (params: {
  readonly messageId: string;
  readonly text: string;
  readonly contextId: string;
  readonly taskId?: string;
  readonly metadata?: A2AMetadata;
}): Message => ({
  messageId: params.messageId,
  role: "user",
  parts: makeTextParts(params.text),
  contextId: params.contextId,
  ...(params.taskId ? { taskId: params.taskId } : {}),
  ...(params.metadata ? { metadata: params.metadata } : {}),
});

export const makeAgentMessage = (params: {
  readonly messageId: string;
  readonly text: string;
  readonly contextId: string;
  readonly taskId?: string;
  readonly metadata?: A2AMetadata;
}): Message => ({
  messageId: params.messageId,
  role: "agent",
  parts: makeTextParts(params.text),
  contextId: params.contextId,
  ...(params.taskId ? { taskId: params.taskId } : {}),
  ...(params.metadata ? { metadata: params.metadata } : {}),
});

export const claimedByOf = (task: A2ATask): string | undefined => {
  const raw = task.metadata?.claimedBy;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
};
