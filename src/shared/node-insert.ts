/**
 * Effect-wire **insert data** — generic to the target node, not a task type.
 *
 * An effect that delivers into a sink carries `data`: a flat string map of
 * field keys the **target kind** publishes on its contract. UI forms and
 * validation read the contract; the kernel maps `data` into the sink's create
 * API only at apply time.
 *
 * Do not name this TaskInsert / put task domain types on the wire.
 */
import { Schema } from "effect";
import type { FinishCriteria } from "./work-model";
import {
  isWellKnownKind,
  type WellKnownKind,
} from "./physics/schema";

/** Flat field values authored on the wire (keys from the target contract). */
export const InsertData = Schema.Record(Schema.String, Schema.String);
export type InsertData = typeof InsertData.Type;

export type InsertFieldKind = "text" | "textarea" | "number";

export type InsertField = {
  readonly key: string;
  readonly label: string;
  readonly kind: InsertFieldKind;
  readonly required: boolean;
};

/**
 * Insert fields for a target kind + effect mode.
 * Owned here as the node surface catalog (contract inputs point at modes;
 * field layout lives once so sheet + validate share one table).
 */
const TASK_ENQUEUE_FIELDS: ReadonlyArray<InsertField> = [
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

const FIELDS_BY_KIND_MODE: Partial<
  Record<WellKnownKind, Partial<Record<string, ReadonlyArray<InsertField>>>>
> = {
  task: {
    enqueue_task: TASK_ENQUEUE_FIELDS,
  },
};

export const insertFieldsFor = (
  kind: string | undefined,
  mode: string,
): ReadonlyArray<InsertField> => {
  if (!kind || !isWellKnownKind(kind)) return [];
  return FIELDS_BY_KIND_MODE[kind]?.[mode] ?? [];
};

export const getInsertField = (data: InsertData, key: string): string =>
  data[key] ?? "";

export const setInsertField = (
  data: InsertData,
  key: string,
  value: string,
): InsertData => {
  if (value.length === 0) {
    if (!(key in data)) return data;
    const next = { ...data };
    delete next[key];
    return next;
  }
  return { ...data, [key]: value };
};

export const insertDataValid = (
  kind: string | undefined,
  mode: string,
  data: InsertData,
): boolean => {
  const fields = insertFieldsFor(kind, mode);
  if (fields.length === 0) return false;
  for (const field of fields) {
    if (!field.required) continue;
    if ((data[field.key] ?? "").trim().length === 0) return false;
  }
  return true;
};

/** Default insert map for a target kind when the wire is first drawn. */
export const defaultInsertData = (
  kind: string | undefined,
  sourceLabel: string,
): InsertData => {
  const label = sourceLabel.trim().length > 0 ? sourceLabel.trim() : "scheduler";
  if (kind === "task") {
    return {
      title: `From ${label}`,
      details: `Scheduled work from ${label}`,
      reason: "scheduler",
    };
  }
  return {};
};

/**
 * Map insert data → workTaskCreate args for a **task** sink.
 * Only call this at the kernel apply boundary for kind === "task".
 */
export const insertDataToTaskCreateArgs = (
  data: InsertData,
): {
  readonly brief: string;
  readonly metadata: { readonly title: string; readonly details: string };
  readonly reason?: string;
  readonly dependsOn?: ReadonlyArray<string>;
  readonly finishCriteria?: FinishCriteria;
} => {
  const title = (data.title ?? "").trim();
  const details = (data.details ?? "").trim();
  const reason = (data.reason ?? "").trim();
  const doneWhen = (data["finishCriteria.description"] ?? "").trim();
  const minRaw = (data["finishCriteria.git.minCommits"] ?? "").trim();
  const minCommits = Number(minRaw);
  const git =
    minRaw.length > 0 && Number.isFinite(minCommits) && minCommits >= 1
      ? { minCommits: Math.floor(minCommits) }
      : undefined;
  const finishCriteria: FinishCriteria | undefined =
    doneWhen || git
      ? {
          ...(doneWhen ? { description: doneWhen } : {}),
          ...(git ? { git } : {}),
        }
      : undefined;
  return {
    brief: title,
    metadata: { title, details },
    ...(reason.length > 0 ? { reason } : {}),
    ...(finishCriteria ? { finishCriteria } : {}),
  };
};

/**
 * Historical wire `{ mode, brief, reason? }` → InsertData.
 * Returns undefined if already `data` shape or not legacy brief.
 */
export const migrateBriefToInsertData = (
  raw: Record<string, unknown>,
): InsertData | undefined => {
  if (raw.mode !== "enqueue_task") return undefined;
  if (raw.data !== undefined && typeof raw.data === "object" && raw.data !== null) {
    return undefined;
  }
  // Also accept mistaken prior TaskInsert shape { task: { title, details } }
  if (raw.task !== undefined && typeof raw.task === "object" && raw.task !== null) {
    const t = raw.task as Record<string, unknown>;
    const title = typeof t.title === "string" ? t.title.trim() : "";
    const details = typeof t.details === "string" ? t.details.trim() : "";
    if (title.length === 0 && details.length === 0) return undefined;
    const out: Record<string, string> = {
      title: title || details,
      details: details || title,
    };
    if (typeof t.reason === "string" && t.reason.trim()) out.reason = t.reason.trim();
    if (
      t.finishCriteria &&
      typeof t.finishCriteria === "object" &&
      t.finishCriteria !== null
    ) {
      const fc = t.finishCriteria as Record<string, unknown>;
      if (typeof fc.description === "string" && fc.description.trim()) {
        out["finishCriteria.description"] = fc.description.trim();
      }
      if (fc.git && typeof fc.git === "object" && fc.git !== null) {
        const min = (fc.git as { minCommits?: unknown }).minCommits;
        if (typeof min === "number" && min >= 1) {
          out["finishCriteria.git.minCommits"] = String(Math.floor(min));
        }
      }
    }
    return out;
  }
  const brief = typeof raw.brief === "string" ? raw.brief.trim() : "";
  if (brief.length === 0) return undefined;
  const reason = typeof raw.reason === "string" ? raw.reason.trim() : "";
  return {
    title: brief,
    details: brief,
    ...(reason.length > 0 ? { reason } : {}),
  };
};

/** Scrub a raw `does` value: legacy brief / task shapes → { mode, data }. */
export const scrubDoesEffect = (does: unknown): unknown => {
  if (does === null || typeof does !== "object" || Array.isArray(does)) {
    return does;
  }
  const raw = does as Record<string, unknown>;
  if (raw.mode !== "enqueue_task") return does;
  if (
    raw.data !== undefined &&
    typeof raw.data === "object" &&
    raw.data !== null &&
    !Array.isArray(raw.data)
  ) {
    // Normalize non-string values out
    const data: Record<string, string> = {};
    for (const [k, v] of Object.entries(raw.data as Record<string, unknown>)) {
      if (typeof v === "string") data[k] = v;
      else if (v !== undefined && v !== null) data[k] = String(v);
    }
    return { mode: "enqueue_task", data };
  }
  const migrated = migrateBriefToInsertData(raw);
  if (!migrated) return does;
  return { mode: "enqueue_task", data: migrated };
};
