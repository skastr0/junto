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
    cause: Schema.optional(Schema.Unknown),
  },
) {}

/**
 * The install-local ledger could not be acquired safely on this boot. Backfill
 * work must defer. Product state and the rest of the runtime remain available.
 */
export class InstallOpsDeferredError extends Schema.TaggedError<InstallOpsDeferredError>()(
  "InstallOpsDeferredError",
  {
    path: Schema.String,
    operation: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export type InstallOpsServiceError =
  | InstallOpsError
  | InstallOpsDeferredError;

export type InstallOpsAvailability =
  | { readonly status: "available" }
  | {
    readonly status: "unavailable";
    readonly reason: InstallOpsDeferredError;
  };

/**
 * Implementation shape for {@link InstallOpsService}.
 * Named so the V4 swap is a one-line Tag→Service change, not a reshape.
 */
export type MachineUpdateLatchOutcome = "attempting" | "rolled-back" | "start-failed" | "stop-unconfirmed" | "uncertain" | "activated" | "failed" | "needs-signed-release";
export type MachineUpdateLatch = {
  readonly installationId: string;
  readonly targetBuild: string;
  readonly outcome: MachineUpdateLatchOutcome;
  readonly at: string;
};

/**
 * The last send to a name whose far setup refused with the S4 pin rule. The
 * route is its fixed fingerprint, so a changed route drops the record; the
 * installation id is the far's own, from that send's install receipt.
 */
export type MachineSetupRefusal = {
  readonly machineName: string;
  readonly installationId: string;
  readonly route: string;
  readonly at: string;
};

export type InstallOpsServiceShape = {
  readonly path: string;
  /** Explicit status for Doctor and other operational reporting surfaces. */
  readonly availability: InstallOpsAvailability;
  readonly getBackfill: (
    id: string,
  ) => Effect.Effect<BackfillMarker | undefined, InstallOpsServiceError>;
  readonly ensurePending: (
    id: string,
  ) => Effect.Effect<void, InstallOpsServiceError>;
  /**
   * Reopen an existing completion witness after product-state drift is seen.
   * Keeps the prior ingest count; only status/completedAt are reset.
   */
  readonly reopenPending: (
    id: string,
  ) => Effect.Effect<void, InstallOpsServiceError>;
  readonly markComplete: (
    id: string,
    objectsIngested: number,
  ) => Effect.Effect<void, InstallOpsServiceError>;
  /** A failed automatic update attempt for one machine and target build. */
  readonly updateLatch: (installationId: string) => Effect.Effect<MachineUpdateLatch | undefined, InstallOpsServiceError>;
  readonly recordUpdateLatch: (latch: MachineUpdateLatch) => Effect.Effect<void, InstallOpsServiceError>;
  readonly clearUpdateLatch: (installationId: string) => Effect.Effect<void, InstallOpsServiceError>;
  /** The record an S4 send left for this name, if its route has not changed. */
  readonly setupRefusal: (machineName: string) => Effect.Effect<MachineSetupRefusal | undefined, InstallOpsServiceError>;
  readonly recordSetupRefusal: (refusal: MachineSetupRefusal) => Effect.Effect<void, InstallOpsServiceError>;
  readonly clearSetupRefusal: (machineName: string) => Effect.Effect<void, InstallOpsServiceError>;
};

/**
 * Install-local ops plane: backfill ledgers only. Product work never lives
 * here. Seed scripts must not copy this database with junto.db.
 *
 * - Canonical id: `@junto/InstallOpsService` — single `Context.Service`.
 * - Layer: `InstallOpsLive` / `makeInstallOpsLive` (engine.ts).
 * - Product vs install-local split is law (AGENTS.md): install-ops.db is not
 *   product truth and must not be seeded with junto.db.
 */
export class InstallOpsService extends Context.Service<InstallOpsService,
  InstallOpsServiceShape>()("@junto/InstallOpsService") {}
