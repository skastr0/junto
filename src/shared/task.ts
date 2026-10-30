import type {
  WorkMetadata,
  Task,
  Message,
  Part,
  TaskState,
} from "./work-model";

// Display + transition helpers for the work plane. Pure — no I/O.

/** Settled for workers/dragging; completed has the separate QA requeue exit. */
export const isTerminalTaskState = (state: TaskState): boolean =>
  state === "completed" ||
  state === "canceled" ||
  state === "failed" ||
  state === "rejected" ||
  state === "archived";

export const makeTextParts = (text: string): Part[] => [{ kind: "text", text }];

export const makeUserMessage = (params: {
  readonly messageId: string;
  readonly text: string;
  readonly contextId: string;
  readonly taskId?: string;
  readonly metadata?: WorkMetadata;
  /** First-class non-text parts appended after the brief text (images, etc.). */
  readonly extraParts?: ReadonlyArray<Part>;
}): Message => ({
  messageId: params.messageId,
  role: "user",
  parts: [
    ...makeTextParts(params.text),
    ...(params.extraParts ?? []),
  ],
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
