import type {
  WorkMetadata,
  Task,
  Artifact,
  Message,
  Part,
  ContentPart,
  TaskState,
} from "./work-model";
import type { ActorSeatId } from "./actor-seat";

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

/**
 * Sort key for "latest activity first": last history messageId (ULID), else
 * task id. Newer ULIDs sort after older ones lexicographically.
 */
export const taskLatestActivityKey = (task: Task): string => {
  const last = task.history.at(-1);
  return last?.messageId ?? task.id;
};

/** Newest activity first (Closed lane, glance rows, etc.). */
export const compareTasksByLatestActivityDesc = (a: Task, b: Task): number =>
  taskLatestActivityKey(b).localeCompare(taskLatestActivityKey(a));

/**
 * Activity after the brief (history[0]), newest first for the task detail rail.
 */
export const taskActivityNewestFirst = (task: Task): ReadonlyArray<Message> =>
  task.history.length <= 1 ? [] : [...task.history.slice(1)].reverse();

/** Settled for workers/dragging; completed has the separate QA requeue exit. */
export const isTerminalTaskState = (state: TaskState): boolean =>
  state === "completed" ||
  state === "canceled" ||
  state === "failed" ||
  state === "rejected" ||
  state === "archived";

/** Soft-deleted: durable but omitted from board / list projections. */
export const isArchivedTaskState = (state: TaskState): boolean =>
  state === "archived";

/** Legal outbound transitions. Completed work has one operator-only QA exit. */
const LEGAL_TRANSITIONS: Readonly<Record<TaskState, ReadonlySet<TaskState>>> = {
  submitted: new Set([
    "completed",
    "canceled",
    "failed",
    "rejected",
    "archived",
  ]),
  working: new Set([
    "submitted",
    "working",
    "input-required",
    "completed",
    "canceled",
    "failed",
    "rejected",
    "archived",
  ]),
  "input-required": new Set([
    "submitted",
    "working",
    "completed",
    "canceled",
    "rejected",
    "failed",
    "archived",
  ]),
  /**
   * Residual durable value only — no producer may enter this state.
   * Exits remain so installed rows can heal via normal facts.
   */
  "auth-required": new Set([
    "submitted",
    "working",
    "completed",
    "canceled",
    "rejected",
    "failed",
    "input-required",
    "archived",
  ]),
  // A completed task can be rejected by QA and returned to the Queue. The
  // work transition policy requires the accompanying review comment and
  // stamps the rejection count before the task becomes claimable again.
  // Operators may also archive completed work off the board.
  completed: new Set(["submitted", "archived"]),
  canceled: new Set(["archived"]),
  failed: new Set(["archived"]),
  rejected: new Set(["archived"]),
  archived: new Set(),
};

export const canTransitionTaskState = (from: TaskState, to: TaskState): boolean =>
  LEGAL_TRANSITIONS[from].has(to);

/**
 * Apply the state-bearing part of a task transition.
 *
 * Returning active work to `submitted` is the operator's atomic release:
 * Queue inventory is unclaimed by schema, so the claimant disappears in the
 * same fact that changes state. Every authority path uses this transform.
 */
export const taskWithTransitionState = (
  task: Task,
  state: TaskState,
): Task => {
  if (state !== "submitted") return { ...task, state };
  const { claimedBy: _claimedBy, ...unclaimed } = task;
  if (task.state !== "completed") return { ...unclaimed, state };

  const previousRejections =
    typeof task.metadata?.rejectedTimes === "number" &&
    Number.isSafeInteger(task.metadata.rejectedTimes) &&
    task.metadata.rejectedTimes >= 0
      ? task.metadata.rejectedTimes
      : 0;
  return {
    ...unclaimed,
    state,
    metadata: {
      ...(task.metadata ?? {}),
      rejectedTimes: previousRejections + 1,
    },
  };
};

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

/** Artifacts node text mirror: active names (or artifact ids); skips archived. */
export const mirrorArtifactsText = (items: ReadonlyArray<Artifact>): string => {
  const live = items.filter((item) => item.metadata?.archived !== true);
  if (live.length === 0) return "artifacts";
  return live.map((item) => item.name?.trim() || item.artifactId).join("\n");
};

/**
 * Board node text mirror: recent topic titles for offline glance.
 * Empty → kind name ("board"), never a mood word like "quiet" (that leaked
 * into card titles and edge labels).
 */
export const mirrorBoardText = (
  topics: ReadonlyArray<{ readonly title: string }>,
): string => {
  if (topics.length === 0) return "board";
  return topics
    .slice(0, 4)
    .map((t) => `- ${t.title}`)
    .join("\n");
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
    archived: 0,
  };
  for (const item of items) counts[item.state] += 1;
  return counts;
};

export const makeTextParts = (text: string): Part[] => [{ kind: "text", text }];

/**
 * Legacy inline-media limits retained only for old callers that still build
 * RawPart values in memory. ContentPart references have no attachment-size
 * ceiling here; storage and transfer planes own admission/backpressure.
 */
export const TASK_MEDIA_MAX_BYTES = 4 * 1024 * 1024;
export const TASK_MEDIA_MAX_TOTAL_BYTES = 6 * 1024 * 1024;

const TASK_MEDIA_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/bmp",
]);

export const isTaskMediaPart = (
  part: Part,
): part is Extract<Part, { kind: "raw" }> =>
  part.kind === "raw" &&
    typeof part.mediaType === "string" &&
    TASK_MEDIA_TYPES.has(part.mediaType.trim().toLowerCase().split(";")[0]?.trim() ?? "");

export const taskMediaParts = (
  task: Task,
): ReadonlyArray<Extract<Part, { kind: "raw" }>> => {
  const first = task.history[0];
  if (!first) return [];
  return first.parts.filter(isTaskMediaPart);
};

/** Ref-only media in the brief; unlike legacy taskMediaParts this has no size cap. */
export const taskContentParts = (task: Task): ReadonlyArray<ContentPart> => {
  const first = task.history[0];
  if (!first) return [];
  return first.parts.filter(
    (part): part is ContentPart => part.kind === "content",
  );
};

/** Approximate decoded size of a base64 payload (ignores padding edge cases by ~3 bytes). */
export const base64DecodedByteLength = (bytesBase64: string): number => {
  const cleaned = bytesBase64.replace(/\s+/g, "");
  if (cleaned.length === 0) return 0;
  const padding = cleaned.endsWith("==") ? 2 : cleaned.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((cleaned.length * 3) / 4) - padding);
};

/**
 * Validate operator-supplied task media parts before they enter the task
 * authoring projection. ContentPart is the durable binary form and is not
 * size-limited here. RawPart remains accepted by this pure legacy helper so
 * installed callers can be migrated without changing the canvas transform;
 * repository writes apply the stricter no-inline guard.
 */
export const validateTaskMediaParts = (
  media: ReadonlyArray<Part> | undefined,
): string | undefined => {
  if (media === undefined || media.length === 0) return undefined;
  let total = 0;
  for (let index = 0; index < media.length; index += 1) {
    const part = media[index]!;
    if (part.kind === "content") {
      continue;
    }
    if (part.kind !== "raw") {
      return `media[${index}] must be a raw part or ContentRef part`;
    }
    const mediaType = part.mediaType?.trim().toLowerCase().split(";")[0]?.trim() ?? "";
    if (!TASK_MEDIA_TYPES.has(mediaType)) {
      return `media[${index}] mediaType not allowed: ${part.mediaType ?? "(missing)"}`;
    }
    if (!part.bytesBase64 || part.bytesBase64.length === 0) {
      return `media[${index}] is empty`;
    }
    const size = base64DecodedByteLength(part.bytesBase64);
    if (size <= 0) return `media[${index}] is empty`;
    if (size > TASK_MEDIA_MAX_BYTES) {
      return `media[${index}] too large (${size} bytes; max ${TASK_MEDIA_MAX_BYTES})`;
    }
    total += size;
    if (total > TASK_MEDIA_MAX_TOTAL_BYTES) {
      return `media total too large (${total} bytes; max ${TASK_MEDIA_MAX_TOTAL_BYTES})`;
    }
  }
  return undefined;
};

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

const TASK_RELEASE_ACTOR_SEAT_KEY = "vellum.taskRelease.actorSeatId";

/**
 * Exact operator-release boundary for one claimed task generation.
 *
 * The message id gives subsequent delivery receipts a fresh identity while
 * the seat marker lets factory selection briefly avoid handing the task
 * straight back to the actor it was explicitly released from.
 */
export const makeTaskReleaseMessage = (params: {
  readonly messageId: string;
  readonly text: string;
  readonly contextId: string;
  readonly taskId: string;
  readonly actorSeatId?: ActorSeatId;
}): Message =>
  makeUserMessage({
    messageId: params.messageId,
    text: params.text,
    contextId: params.contextId,
    taskId: params.taskId,
    ...(params.actorSeatId === undefined
      ? {}
      : {
        metadata: {
          [TASK_RELEASE_ACTOR_SEAT_KEY]: params.actorSeatId,
        },
      }),
  });

export const taskReleaseBoundary = (
  task: Task,
): { readonly messageId: string; readonly actorSeatId: ActorSeatId } | undefined => {
  const message = task.history.at(-1);
  const actorSeatId = message?.metadata?.[TASK_RELEASE_ACTOR_SEAT_KEY];
  return message !== undefined &&
      message.role === "user" &&
      typeof actorSeatId === "string" &&
      /^seat_[a-f0-9]{64}$/u.test(actorSeatId)
    ? {
      messageId: message.messageId,
      actorSeatId: actorSeatId as ActorSeatId,
    }
    : undefined;
};

export const claimedByOf = (task: Task): ActorSeatId | undefined =>
  task.claimedBy;
