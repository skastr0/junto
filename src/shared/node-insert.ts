/**
 * Effect-wire insert **payloads** — closed, strict create contracts for the
 * target sink. The wire stores the same shapes work-plane create APIs accept
 * (minus `target`, which is the edge's toNode). Kernel decode fails hard on
 * excess keys or missing required fields. No ad-hoc flat field invention.
 */
import { Schema } from "effect";
import {
  FinishCriteria,
  WorkMetadata,
  type FinishCriteria as FinishCriteriaType,
} from "./work-model";

// ─── Task sink: TasksCreateArgs body (no target) ────────────────────────────

/**
 * Same authoring contract as `TasksCreateArgs` / workTaskCreate — without
 * `target` (the effect wire already points at the sink).
 */
export const EffectTasksCreate = Schema.Struct({
  brief: Schema.String,
  reason: Schema.optionalKey(Schema.String),
  metadata: Schema.optionalKey(WorkMetadata),
  dependsOn: Schema.optionalKey(Schema.Array(Schema.String)),
  finishCriteria: Schema.optionalKey(FinishCriteria),
}).pipe(
  Schema.check(
    Schema.makeFilter((args) => {
      const details = args.metadata?.details;
      return (
        (typeof details === "string" && details.trim().length > 0) ||
        "description (metadata.details) must be non-empty"
      );
    }),
  ),
).annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type EffectTasksCreate = typeof EffectTasksCreate.Type;

// ─── Board sink: BoardCreateTopicArgs / BoardPostArgs bodies ─────────────────

/** Same as BoardCreateTopicArgs without target. */
export const EffectBoardCreateTopic = Schema.Struct({
  title: Schema.String,
  body: Schema.optionalKey(Schema.String),
  notify: Schema.optionalKey(Schema.Boolean),
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type EffectBoardCreateTopic = typeof EffectBoardCreateTopic.Type;

/** Same as BoardPostArgs without target. */
export const EffectBoardPost = Schema.Struct({
  topicId: Schema.String,
  text: Schema.String,
}).annotate({
  parseOptions: { onExcessProperty: "error" },
});
export type EffectBoardPost = typeof EffectBoardPost.Type;

// ─── Decode (fail closed) ───────────────────────────────────────────────────

const decodeOpts = { errors: "all" as const, onExcessProperty: "error" as const };

export const decodeEffectTasksCreate = (
  data: unknown,
):
  | { readonly ok: true; readonly value: EffectTasksCreate }
  | { readonly ok: false; readonly message: string } => {
  const result = Schema.decodeUnknownResult(EffectTasksCreate, decodeOpts)(data);
  if (result._tag === "Success") return { ok: true, value: result.success };
  return {
    ok: false,
    message: `task create payload invalid: ${String(result.failure)}`,
  };
};

export const decodeEffectBoardCreateTopic = (
  data: unknown,
):
  | { readonly ok: true; readonly value: EffectBoardCreateTopic }
  | { readonly ok: false; readonly message: string } => {
  const result = Schema.decodeUnknownResult(EffectBoardCreateTopic, decodeOpts)(
    data,
  );
  if (result._tag === "Success") return { ok: true, value: result.success };
  return {
    ok: false,
    message: `board create topic payload invalid: ${String(result.failure)}`,
  };
};

export const decodeEffectBoardPost = (
  data: unknown,
):
  | { readonly ok: true; readonly value: EffectBoardPost }
  | { readonly ok: false; readonly message: string } => {
  const result = Schema.decodeUnknownResult(EffectBoardPost, decodeOpts)(data);
  if (result._tag === "Success") return { ok: true, value: result.success };
  return {
    ok: false,
    message: `board post payload invalid: ${String(result.failure)}`,
  };
};

// ─── Defaults / light authoring helpers (still schema-shaped) ───────────────

/** Default payload matches TaskCreateDialog: title + required description only. */
export const defaultEffectTasksCreate = (
  sourceLabel: string,
): EffectTasksCreate => {
  const label = sourceLabel.trim().length > 0 ? sourceLabel.trim() : "scheduler";
  const brief = `From ${label}`;
  return {
    brief,
    metadata: {
      title: brief,
      details: `Scheduled work from ${label}`,
    },
  };
};

export const defaultEffectBoardCreateTopic = (
  sourceLabel: string,
): EffectBoardCreateTopic => {
  const label = sourceLabel.trim().length > 0 ? sourceLabel.trim() : "scheduler";
  return {
    title: `From ${label}`,
    body: `Scheduled bulletin from ${label}`,
    notify: false,
  };
};

/** True when EffectTasksCreate would decode successfully. */
export const effectTasksCreateValid = (data: unknown): boolean =>
  decodeEffectTasksCreate(data).ok;

export const effectBoardCreateTopicValid = (data: unknown): boolean =>
  decodeEffectBoardCreateTopic(data).ok;

export const effectBoardPostValid = (data: unknown): boolean =>
  decodeEffectBoardPost(data).ok;

/**
 * Map validated task payload → workTaskCreate positional args.
 * Call only after decodeEffectTasksCreate succeeds.
 */
export const effectTasksCreateToWorkArgs = (
  payload: EffectTasksCreate,
): {
  readonly brief: string;
  readonly metadata: { readonly title?: string; readonly details: string } & Record<
    string,
    unknown
  >;
  readonly reason?: string;
  readonly dependsOn?: ReadonlyArray<string>;
  readonly finishCriteria?: FinishCriteriaType;
} => {
  const brief = payload.brief.trim();
  const details =
    typeof payload.metadata?.details === "string"
      ? payload.metadata.details.trim()
      : "";
  const titleRaw = payload.metadata?.title;
  const title =
    typeof titleRaw === "string" && titleRaw.trim().length > 0
      ? titleRaw.trim()
      : brief;
  const reason = payload.reason?.trim();
  return {
    brief,
    metadata: {
      ...(payload.metadata ?? {}),
      title,
      details,
    },
    ...(reason && reason.length > 0 ? { reason } : {}),
    ...(payload.dependsOn && payload.dependsOn.length > 0
      ? { dependsOn: [...payload.dependsOn] }
      : {}),
    ...(payload.finishCriteria ? { finishCriteria: payload.finishCriteria } : {}),
  };
};

// ─── Wire form paths — same authoring surface as TaskCreateDialog ───────────

export type EffectFormField = {
  readonly path: string;
  readonly label: string;
  readonly kind: "text" | "textarea" | "number" | "boolean";
  readonly required: boolean;
};

/**
 * Task create contract fields (TaskCreateDialog → workTaskCreate).
 * No invented "reason" / free-form min-commits number.
 * Git/artifacts hard gates are toggled via helpers below.
 */
export const EFFECT_TASKS_CREATE_FIELDS: ReadonlyArray<EffectFormField> = [
  { path: "brief", label: "Title", kind: "text", required: true },
  {
    path: "metadata.details",
    label: "Description",
    kind: "textarea",
    required: true,
  },
  {
    path: "metadata.workRole",
    label: "Role",
    kind: "text",
    required: false,
  },
  {
    path: "dependsOn",
    label: "Depends on",
    kind: "text",
    required: false,
  },
  {
    path: "finishCriteria.description",
    label: "Finish criteria",
    kind: "textarea",
    required: false,
  },
];

export const EFFECT_BOARD_CREATE_TOPIC_FIELDS: ReadonlyArray<EffectFormField> = [
  { path: "title", label: "Topic title", kind: "text", required: true },
  { path: "body", label: "Opening body", kind: "textarea", required: false },
  { path: "notify", label: "Notify seats", kind: "boolean", required: false },
];

export const EFFECT_BOARD_POST_FIELDS: ReadonlyArray<EffectFormField> = [
  { path: "topicId", label: "Topic id", kind: "text", required: true },
  { path: "text", label: "Post text", kind: "textarea", required: true },
];

/** Create UI: "Require at least one git commit" → finishCriteria.git.minCommits = 1. */
export const effectTasksRequireGit = (data: unknown): boolean => {
  const git = getPath(data, "finishCriteria.git");
  return (
    git !== null &&
    typeof git === "object" &&
    typeof (git as { minCommits?: unknown }).minCommits === "number" &&
    (git as { minCommits: number }).minCommits >= 1
  );
};

export const setEffectTasksRequireGit = (
  data: Record<string, unknown>,
  on: boolean,
): Record<string, unknown> => {
  if (on) return setPath(data, "finishCriteria.git", { minCommits: 1 });
  return setPath(data, "finishCriteria.git", undefined);
};

/** Create UI: require artifact(s) gate. */
export const effectTasksRequireArtifacts = (data: unknown): boolean => {
  const arts = getPath(data, "finishCriteria.artifacts");
  return (
    arts !== null &&
    typeof arts === "object" &&
    typeof (arts as { nodeId?: unknown }).nodeId === "string" &&
    (arts as { nodeId: string }).nodeId.trim().length > 0
  );
};

export const setEffectTasksRequireArtifacts = (
  data: Record<string, unknown>,
  on: boolean,
  artifactsNodeId: string | undefined,
): Record<string, unknown> => {
  if (!on || !artifactsNodeId?.trim()) {
    return setPath(data, "finishCriteria.artifacts", undefined);
  }
  const prev = getPath(data, "finishCriteria.artifacts");
  const prevObj =
    prev !== null && typeof prev === "object"
      ? (prev as Record<string, unknown>)
      : {};
  return setPath(data, "finishCriteria.artifacts", {
    ...prevObj,
    nodeId: artifactsNodeId.trim(),
  });
};

export const setEffectTasksArtifactInstruction = (
  data: Record<string, unknown>,
  instruction: string,
): Record<string, unknown> => {
  const prev = getPath(data, "finishCriteria.artifacts");
  if (prev === null || typeof prev !== "object") return data;
  const nodeId = (prev as { nodeId?: string }).nodeId;
  if (!nodeId) return data;
  const rest = { ...(prev as Record<string, unknown>) };
  if (!instruction.trim()) {
    delete rest.instruction;
  } else {
    rest.instruction = instruction.trim();
  }
  return setPath(data, "finishCriteria.artifacts", rest);
};

export const setEffectTasksArtifactNames = (
  data: Record<string, unknown>,
  namesText: string,
): Record<string, unknown> => {
  const prev = getPath(data, "finishCriteria.artifacts");
  if (prev === null || typeof prev !== "object") return data;
  const nodeId = (prev as { nodeId?: string }).nodeId;
  if (!nodeId) return data;
  const names = namesText
    .split(/[\n,]+/)
    .map((n) => n.trim())
    .filter(Boolean);
  const rest = { ...(prev as Record<string, unknown>) };
  if (names.length === 0) delete rest.names;
  else rest.names = names;
  return setPath(data, "finishCriteria.artifacts", rest);
};

export const getEffectTasksArtifactInstruction = (data: unknown): string => {
  const v = getPath(data, "finishCriteria.artifacts.instruction");
  return typeof v === "string" ? v : "";
};

export const getEffectTasksArtifactNames = (data: unknown): string => {
  const v = getPath(data, "finishCriteria.artifacts.names");
  if (Array.isArray(v)) return v.map(String).join(", ");
  return "";
};

const getPath = (obj: unknown, path: string): unknown => {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
};

const setPath = (
  obj: Record<string, unknown>,
  path: string,
  value: unknown,
): Record<string, unknown> => {
  const parts = path.split(".");
  if (parts.length === 1) {
    const key = parts[0]!;
    if (value === undefined) {
      const next = { ...obj };
      delete next[key];
      return next;
    }
    return { ...obj, [key]: value };
  }
  const [head, ...rest] = parts;
  const child =
    obj[head!] !== null && typeof obj[head!] === "object" && !Array.isArray(obj[head!])
      ? { ...(obj[head!] as Record<string, unknown>) }
      : {};
  const nextChild = setPath(child, rest.join("."), value);
  if (Object.keys(nextChild).length === 0) {
    const next = { ...obj };
    delete next[head!];
    return next;
  }
  return { ...obj, [head!]: nextChild };
};

export const getEffectFormValue = (data: unknown, path: string): string => {
  const v = getPath(data, path);
  if (v === undefined || v === null) return "";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (Array.isArray(v)) return v.map(String).join(", ");
  return String(v);
};

export const setEffectFormValue = (
  data: Record<string, unknown>,
  path: string,
  raw: string,
  kind: EffectFormField["kind"],
): Record<string, unknown> => {
  if (path === "dependsOn") {
    const ids = raw
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    return setPath(data, path, ids.length > 0 ? ids : undefined);
  }
  if (kind === "boolean") {
    if (raw === "" || raw === "false") return setPath(data, path, undefined);
    return setPath(data, path, raw === "true" || raw === "1" || raw === "on");
  }
  if (kind === "number") {
    const n = Number(raw);
    if (!raw.trim() || !Number.isFinite(n) || n < 1) {
      return setPath(data, path, undefined);
    }
    return setPath(data, path, Math.floor(n));
  }
  const trimmed = raw; // keep spaces while typing; trim at validate
  if (trimmed.length === 0) return setPath(data, path, undefined);
  return setPath(data, path, trimmed);
};

/**
 * Historical wire shapes → EffectTasksCreate.
 * - `{ brief, reason? }` old enqueue
 * - `{ title, details }` mistaken flat insert
 * - `{ task: { title, details } }` mistaken TaskInsert
 */
export const migrateToEffectTasksCreate = (
  raw: Record<string, unknown>,
): EffectTasksCreate | undefined => {
  if (raw.mode !== "enqueue_task") return undefined;
  if (raw.data !== undefined && typeof raw.data === "object" && raw.data !== null) {
    const d = raw.data as Record<string, unknown>;
    // Already contract-shaped
    if (typeof d.brief === "string") {
      const decoded = decodeEffectTasksCreate(d);
      return decoded.ok ? decoded.value : undefined;
    }
    // Flat title/details mistake
    if (typeof d.title === "string" || typeof d.details === "string") {
      const title = typeof d.title === "string" ? d.title.trim() : "";
      const details = typeof d.details === "string" ? d.details.trim() : "";
      const brief = title || details;
      const body = details || title;
      if (!brief || !body) return undefined;
      const reason = typeof d.reason === "string" ? d.reason : undefined;
      return {
        brief,
        metadata: { title: brief, details: body },
        ...(reason?.trim() ? { reason: reason.trim() } : {}),
      };
    }
    return undefined;
  }
  if (raw.task !== undefined && typeof raw.task === "object" && raw.task !== null) {
    const t = raw.task as Record<string, unknown>;
    const title = typeof t.title === "string" ? t.title.trim() : "";
    const details = typeof t.details === "string" ? t.details.trim() : "";
    const brief = title || details;
    const body = details || title;
    if (!brief || !body) return undefined;
    return {
      brief,
      metadata: { title: brief, details: body },
      ...(typeof t.reason === "string" && t.reason.trim()
        ? { reason: t.reason.trim() }
        : {}),
      ...(t.finishCriteria && typeof t.finishCriteria === "object"
        ? { finishCriteria: t.finishCriteria as FinishCriteriaType }
        : {}),
    };
  }
  const brief = typeof raw.brief === "string" ? raw.brief.trim() : "";
  if (!brief) return undefined;
  const reason = typeof raw.reason === "string" ? raw.reason.trim() : "";
  return {
    brief,
    metadata: { title: brief, details: brief },
    ...(reason.length > 0 ? { reason } : {}),
  };
};

/** Scrub raw `does` to current effect shapes. */
export const scrubDoesEffect = (does: unknown): unknown => {
  if (does === null || typeof does !== "object" || Array.isArray(does)) {
    return does;
  }
  const raw = does as Record<string, unknown>;
  if (raw.mode === "enqueue_task") {
    if (
      raw.data !== undefined &&
      typeof raw.data === "object" &&
      raw.data !== null &&
      typeof (raw.data as { brief?: unknown }).brief === "string"
    ) {
      return does;
    }
    const migrated = migrateToEffectTasksCreate(raw);
    if (!migrated) return does;
    return { mode: "enqueue_task", data: migrated };
  }
  return does;
};

// Back-compat aliases used during transition (tests / old imports).
/** @deprecated use EffectTasksCreate */
export type InsertData = EffectTasksCreate | EffectBoardCreateTopic | EffectBoardPost | Record<string, string>;

/** @deprecated */
export const insertFieldsFor = (
  kind: string | undefined,
  mode: string,
): ReadonlyArray<EffectFormField> => {
  if (kind === "task" && mode === "enqueue_task") return EFFECT_TASKS_CREATE_FIELDS;
  if (kind === "board" && mode === "board_create_topic")
    return EFFECT_BOARD_CREATE_TOPIC_FIELDS;
  if (kind === "board" && mode === "board_post") return EFFECT_BOARD_POST_FIELDS;
  return [];
};

/** @deprecated */
export const defaultInsertData = (
  kind: string | undefined,
  sourceLabel: string,
): Record<string, unknown> => {
  if (kind === "task") return defaultEffectTasksCreate(sourceLabel);
  if (kind === "board") return defaultEffectBoardCreateTopic(sourceLabel);
  return {};
};

/** @deprecated */
export const insertDataValid = (
  kind: string | undefined,
  mode: string,
  data: unknown,
): boolean => {
  if (kind === "task" && mode === "enqueue_task") return effectTasksCreateValid(data);
  if (kind === "board" && mode === "board_create_topic")
    return effectBoardCreateTopicValid(data);
  if (kind === "board" && mode === "board_post") return effectBoardPostValid(data);
  return false;
};

/** @deprecated */
export const insertDataToTaskCreateArgs = (data: unknown) => {
  const decoded = decodeEffectTasksCreate(data);
  if (!decoded.ok) {
    throw new Error(decoded.message);
  }
  return effectTasksCreateToWorkArgs(decoded.value);
};

/** @deprecated */
export const getInsertField = (data: unknown, key: string): string =>
  getEffectFormValue(data, key);

/** @deprecated */
export const setInsertField = (
  data: Record<string, unknown>,
  key: string,
  value: string,
): Record<string, unknown> => {
  const field = EFFECT_TASKS_CREATE_FIELDS.find((f) => f.path === key);
  return setEffectFormValue(data, key, value, field?.kind ?? "text");
};
