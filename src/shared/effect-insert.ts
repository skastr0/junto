/**
 * Effect-wire insert shapes: when a scheduler delivers into a target, the
 * payload is the **target kind's create type** — not an ad-hoc wire field.
 *
 * Task sink → TaskInsert (same authoring surface as work-plane create).
 * Other effect modes (set_flag, inject_prompt) stay mode-local structs on EdgeEffect.
 *
 * Work-plane still stores history[0] as the domain "brief" message; TaskInsert
 * is the authoring contract that *maps into* that create API — it is not a
 * synonym rename of the wire field.
 */
import { FinishCriteria, type FinishCriteria as FinishCriteriaType } from "./work-model";
import { Schema } from "effect";

/** Operator fields for minting a task into a task sink. */
export const TaskInsert = Schema.Struct({
  /** Short name — becomes history brief line + metadata.title. */
  title: Schema.String,
  /** Full description — required metadata.details on create. */
  details: Schema.String,
  reason: Schema.optionalKey(Schema.String),
  dependsOn: Schema.optionalKey(Schema.Array(Schema.String)),
  finishCriteria: Schema.optionalKey(FinishCriteria),
});
export type TaskInsert = typeof TaskInsert.Type;

/** UI field descriptors — compose forms from the target type, not freeform. */
export type InsertFieldKey =
  | "title"
  | "details"
  | "reason"
  | "finishCriteria.description"
  | "finishCriteria.git.minCommits";

export type InsertField = {
  readonly key: InsertFieldKey;
  readonly label: string;
  readonly kind: "text" | "textarea" | "number";
  readonly required: boolean;
};

/** Task create form — mirrors TaskInsert / work create contract. */
export const TASK_INSERT_FIELDS: ReadonlyArray<InsertField> = [
  { key: "title", label: "Title", kind: "text", required: true },
  { key: "details", label: "Description", kind: "textarea", required: true },
  { key: "reason", label: "Reason", kind: "text", required: false },
  {
    key: "finishCriteria.description",
    label: "Done when",
    kind: "textarea",
    required: false,
  },
  {
    key: "finishCriteria.git.minCommits",
    label: "Min commits",
    kind: "number",
    required: false,
  },
];

/** Default insert from a human-readable scheduler label. */
export const defaultTaskInsert = (sourceLabel: string): TaskInsert => {
  const label = sourceLabel.trim().length > 0 ? sourceLabel.trim() : "scheduler";
  const title = `From ${label}`;
  return {
    title,
    details: `Scheduled work from ${label}`,
    reason: "scheduler",
  };
};

export const taskInsertValid = (task: TaskInsert): boolean =>
  task.title.trim().length > 0 && task.details.trim().length > 0;

/** Map wire TaskInsert → workTaskCreate arguments. */
export const taskInsertToCreateArgs = (
  task: TaskInsert,
): {
  readonly brief: string;
  readonly metadata: { readonly title: string; readonly details: string };
  readonly reason?: string;
  readonly dependsOn?: ReadonlyArray<string>;
  readonly finishCriteria?: FinishCriteriaType;
} => {
  const title = task.title.trim();
  const details = task.details.trim();
  const reason = task.reason?.trim();
  const dependsOn =
    task.dependsOn && task.dependsOn.length > 0 ? [...task.dependsOn] : undefined;
  let finishCriteria = task.finishCriteria;
  if (finishCriteria) {
    const desc = finishCriteria.description?.trim();
    const git = finishCriteria.git;
    const artifacts = finishCriteria.artifacts;
    if (!desc && !git && !artifacts) finishCriteria = undefined;
    else {
      finishCriteria = {
        ...(desc ? { description: desc } : {}),
        ...(artifacts ? { artifacts } : {}),
        ...(git ? { git } : {}),
      };
    }
  }
  return {
    brief: title,
    metadata: { title, details },
    ...(reason && reason.length > 0 ? { reason } : {}),
    ...(dependsOn ? { dependsOn } : {}),
    ...(finishCriteria ? { finishCriteria } : {}),
  };
};

export const getTaskInsertField = (
  task: TaskInsert,
  key: InsertFieldKey,
): string => {
  switch (key) {
    case "title":
      return task.title;
    case "details":
      return task.details;
    case "reason":
      return task.reason ?? "";
    case "finishCriteria.description":
      return task.finishCriteria?.description ?? "";
    case "finishCriteria.git.minCommits":
      return task.finishCriteria?.git?.minCommits !== undefined
        ? String(task.finishCriteria.git.minCommits)
        : "";
  }
};

export const setTaskInsertField = (
  task: TaskInsert,
  key: InsertFieldKey,
  value: string,
): TaskInsert => {
  switch (key) {
    case "title":
      return { ...task, title: value };
    case "details":
      return { ...task, details: value };
    case "reason":
      return value.trim().length > 0
        ? { ...task, reason: value }
        : (() => {
            const { reason: _r, ...rest } = task;
            return rest;
          })();
    case "finishCriteria.description": {
      const fc = { ...(task.finishCriteria ?? {}) };
      if (value.trim().length === 0) delete fc.description;
      else fc.description = value;
      if (!fc.description && !fc.git && !fc.artifacts) {
        const { finishCriteria: _f, ...rest } = task;
        return rest;
      }
      return { ...task, finishCriteria: fc };
    }
    case "finishCriteria.git.minCommits": {
      const n = Number(value);
      const fc = { ...(task.finishCriteria ?? {}) };
      if (!value.trim() || !Number.isFinite(n) || n < 1) {
        delete fc.git;
      } else {
        fc.git = { minCommits: Math.floor(n) };
      }
      if (!fc.description && !fc.git && !fc.artifacts) {
        const { finishCriteria: _f, ...rest } = task;
        return rest;
      }
      return { ...task, finishCriteria: fc };
    }
  }
};

/**
 * Migrate historical wire payload `{ mode, brief, reason? }` → TaskInsert.
 * Returns undefined if not an old brief-shaped enqueue.
 */
export const migrateEnqueueBriefToTaskInsert = (
  raw: Record<string, unknown>,
): TaskInsert | undefined => {
  if (raw.mode !== "enqueue_task") return undefined;
  if (raw.task !== undefined && typeof raw.task === "object" && raw.task !== null) {
    return undefined; // already new shape
  }
  const brief = typeof raw.brief === "string" ? raw.brief.trim() : "";
  if (brief.length === 0) return undefined;
  const reason = typeof raw.reason === "string" ? raw.reason : undefined;
  return {
    title: brief,
    details: brief,
    ...(reason && reason.trim().length > 0 ? { reason: reason.trim() } : {}),
  };
};

/** Scrub a raw `does` value: legacy brief enqueue → task insert. */
export const scrubDoesEffect = (does: unknown): unknown => {
  if (does === null || typeof does !== "object" || Array.isArray(does)) {
    return does;
  }
  const raw = does as Record<string, unknown>;
  const migrated = migrateEnqueueBriefToTaskInsert(raw);
  if (!migrated) return does;
  return { mode: "enqueue_task", task: migrated };
};
