import { Context, Effect, Schema } from "effect";

export type BackfillMarkerStatus = "pending" | "complete";

export type BackfillMarker = {
  readonly id: string;
  readonly status: BackfillMarkerStatus;
  readonly objectsIngested: number;
  readonly completedAt: string | undefined;
};

export class InstallOpsError extends Schema.TaggedError<InstallOpsError>()(
  "InstallOpsError",
  {
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}

/**
 * Install-local ops plane: backfill ledgers only. Product work never lives
 * here. Seed scripts must not copy this database with vellum.db.
 */
export class InstallOpsService extends Context.Tag("@vellum/InstallOpsService")<
  InstallOpsService,
  {
    readonly path: string;
    readonly getBackfill: (
      id: string,
    ) => Effect.Effect<BackfillMarker | undefined, InstallOpsError>;
    readonly ensurePending: (
      id: string,
    ) => Effect.Effect<void, InstallOpsError>;
    readonly markComplete: (
      id: string,
      objectsIngested: number,
    ) => Effect.Effect<void, InstallOpsError>;
  }
>() {}
