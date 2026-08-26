/**
 * The task payload a scheduler fire creates — the same closed create contract
 * the work plane accepts, minus `target` (the edge already points at the sink).
 *
 * Nothing authors this. The edge carries one verb, and `enqueues` compiles to a
 * payload-free effect; the kernel builds the brief from the scheduler that
 * fired and decodes it here, fail-closed on excess or missing fields. The wire
 * form that once wrote these shapes went with the edge dialog.
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
