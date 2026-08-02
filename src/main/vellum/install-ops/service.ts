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
 * Implementation shape for {@link InstallOpsService}.
 * Named so the V4 swap is a one-line Tag→Service change, not a reshape.
 */
export type InstallOpsServiceShape = {
  readonly path: string;
  readonly getBackfill: (
    id: string,
  ) => Effect.Effect<BackfillMarker | undefined, InstallOpsError>;
  readonly ensurePending: (id: string) => Effect.Effect<void, InstallOpsError>;
  readonly markComplete: (
    id: string,
    objectsIngested: number,
  ) => Effect.Effect<void, InstallOpsError>;
};

/**
 * Install-local ops plane: backfill ledgers only. Product work never lives
 * here. Seed scripts must not copy this database with vellum.db.
 *
 * effect-foundation **S4-state-content** (staged, not half-migrated):
 * - Canonical id: `@vellum/InstallOpsService` — single definition; no dual path.
 * - Substrate: effect@3.21 → `Context.Tag` (`Context.Service` unavailable).
 * - V4 target:
 *   `class InstallOpsService extends Context.Service<InstallOpsService, InstallOpsServiceShape>()("@vellum/InstallOpsService") {}`
 * - Layer today: `InstallOpsLive` / `makeInstallOpsLive` (engine.ts).
 *   V4 rename candidate: `InstallOpsService.layer` — no dual Live+layer export.
 * - Product vs install-local split is law (AGENTS.md): install-ops.db is not
 *   product truth and must not be seeded with vellum.db.
 */
export class InstallOpsService extends Context.Tag("@vellum/InstallOpsService")<
  InstallOpsService,
  InstallOpsServiceShape
>() {}
