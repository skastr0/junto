/**
 * Content readiness for runnable work.
 *
 * A task/message/artifact may reference ContentRefs. Those refs are control
 * metadata only; the bytes live on the content data plane. Dependent work is
 * claim-ready only when every required ref has a matching verified receipt.
 * Missing, corrupt, unavailable, and unknown states keep work pending.
 */

import type {
  ContentAvailability,
  ContentAvailabilityReason,
  ContentPart,
  ContentRef,
} from "./content";
import { isContentPart } from "./content";
import type { Artifact, Message, Part, Task } from "./work-model";

export type ContentAvailabilityResolver = (
  ref: ContentRef,
) => ContentAvailability;

export type TaskContentReadiness =
  | { readonly kind: "ready" }
  | {
      readonly kind: "pending";
      readonly refs: ReadonlyArray<ContentRef>;
      readonly statuses: ReadonlyArray<ContentAvailability>;
    };

const contentPartRefs = (
  parts: ReadonlyArray<Part> | undefined,
): ContentRef[] => {
  if (parts === undefined || parts.length === 0) return [];
  const refs: ContentRef[] = [];
  for (const part of parts) {
    if (isContentPart(part)) refs.push(part.ref);
  }
  return refs;
};

/** Collect ContentRefs from a free-form Part array (messages, posts, …). */
export const collectContentRefsFromParts = (
  parts: ReadonlyArray<Part> | undefined,
): ReadonlyArray<ContentRef> => contentPartRefs(parts);

/** Collect ContentRefs from every message in a task history. */
export const collectContentRefsFromTask = (
  task: Task,
): ReadonlyArray<ContentRef> => {
  const refs: ContentRef[] = [];
  const seen = new Set<string>();
  for (const message of task.history) {
    for (const ref of contentPartRefs(message.parts)) {
      const key = `${ref.sha256}:${ref.byteLength}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push(ref);
    }
  }
  return refs;
};

export const collectContentRefsFromMessage = (
  message: Message,
): ReadonlyArray<ContentRef> => contentPartRefs(message.parts);

export const collectContentRefsFromArtifact = (
  artifact: Artifact,
): ReadonlyArray<ContentRef> => contentPartRefs(artifact.parts);

/** True only for a verified receipt whose observed identity matches the ref. */
export const isVerifiedContentReceipt = (
  availability: ContentAvailability,
  ref: ContentRef,
): boolean =>
  availability.state === "verified" &&
  availability.ref.sha256 === ref.sha256 &&
  availability.ref.byteLength === ref.byteLength &&
  availability.verifiedSha256 === ref.sha256 &&
  availability.verifiedByteLength === ref.byteLength;

/**
 * When no content parts exist, the task is media-ready.
 * Otherwise every required ref must resolve to a matching verified receipt.
 */
export const taskContentReadiness = (
  task: Task,
  resolve: ContentAvailabilityResolver,
): TaskContentReadiness => {
  const refs = collectContentRefsFromTask(task);
  if (refs.length === 0) return { kind: "ready" };
  const statuses: ContentAvailability[] = [];
  const pending: ContentRef[] = [];
  for (const ref of refs) {
    const availability = resolve(ref);
    statuses.push(availability);
    if (!isVerifiedContentReceipt(availability, ref)) {
      pending.push(ref);
    }
  }
  if (pending.length === 0) return { kind: "ready" };
  return { kind: "pending", refs: pending, statuses };
};

export const taskContentIsRunnable = (
  task: Task,
  resolve: ContentAvailabilityResolver,
): boolean => taskContentReadiness(task, resolve).kind === "ready";

/**
 * Fail-closed resolver used when the content plane is not available to the
 * caller.  Any ContentRef is treated as unavailable so claim paths cannot
 * invent readiness from silence.
 */
export const unavailableContentResolver =
  (reason = "content availability not resolved"): ContentAvailabilityResolver =>
  (ref) => ({
    ref,
    state: "unavailable",
    reason: reason as ContentAvailabilityReason,
  });

/**
 * Human-readable claim rejection when media receipts are not yet verified.
 */
export const taskContentPendingMessage = (
  taskId: string,
  readiness: Extract<TaskContentReadiness, { kind: "pending" }>,
): string => {
  const first = readiness.statuses[0];
  const state = first?.state ?? "unavailable";
  const digest = readiness.refs[0]?.sha256.slice(0, 12) ?? "unknown";
  return `task "${taskId}" is not claim-ready (content ${state}; sha256 ${digest}…)`;
};

/** Type guard for content parts in mixed Part arrays. */
export const asContentParts = (
  parts: ReadonlyArray<Part>,
): ReadonlyArray<ContentPart> =>
  parts.filter((part): part is ContentPart => isContentPart(part));
