import type {
  WorkMetadata,
  Task,
  Artifact,
  Message,
  Part,
  TaskState,
} from "./work-model";

// Display + transition helpers for the work plane. Pure — no I/O.

/** First text line of history[0] (the brief); falls back to task id. */
export const taskBrief = (task: Task): string => {
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
  "input-required": new Set([
    "working",
    "completed",
    "canceled",
    "rejected",
    "failed",
    "auth-required",
  ]),
  "auth-required": new Set([
    "working",
    "completed",
    "canceled",
    "rejected",
    "failed",
    "input-required",
  ]),
  completed: new Set(),
  canceled: new Set(),
  failed: new Set(),
  rejected: new Set(),
};

export const canTransitionTaskState = (from: TaskState, to: TaskState): boolean =>
  LEGAL_TRANSITIONS[from].has(to);

/** Tasks node text mirror: one brief line per item (human-readable offline). */
export const mirrorTasksText = (items: ReadonlyArray<Task>): string => {
  if (items.length === 0) return "tasks";
  return items.map(taskBrief).join("\n");
};

/** Requests node text mirror: pending count + briefs. */
export const mirrorRequestsText = (items: ReadonlyArray<Task>): string => {
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
  items: ReadonlyArray<Task>,
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
  readonly metadata?: WorkMetadata;
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
  readonly metadata?: WorkMetadata;
}): Message => ({
  messageId: params.messageId,
  role: "agent",
  parts: makeTextParts(params.text),
  contextId: params.contextId,
  ...(params.taskId ? { taskId: params.taskId } : {}),
  ...(params.metadata ? { metadata: params.metadata } : {}),
});

export const claimedByOf = (task: Task): string | undefined => {
  const raw = task.metadata?.claimedBy;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
};
