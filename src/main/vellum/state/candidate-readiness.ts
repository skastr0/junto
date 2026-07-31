import { basename } from "node:path";
import { Effect, Layer, Schema } from "effect";
import { InstallationId } from "@shared/installation-id";
import type { LogicalSequence } from "@shared/work-protocol";
import { CanvasesLive, CanvasesService } from "../canvases";
import {
  KernelStateRepository,
  KernelStateRepositoryLive,
} from "../kernel/repository";
import {
  LicenseRepository,
  LicenseRepositoryLive,
} from "../license/repository";
import {
  SchedulerRepository,
  SchedulerRepositoryLive,
} from "../scheduler/repository";
import {
  StationRepository,
  StationRepositoryLive,
} from "../station/repository";
import {
  WorkRepository,
  WorkRepositoryLive,
} from "../work/repository";
import { makeStateEngineLive, StateEngine } from "./engine";
import {
  StateUpdateCandidateError,
  type PreparedStateUpdateCandidate,
} from "./update-candidate";

export const STATE_UPDATE_PREFLIGHT_PROTOCOL =
  "vellum-state-update-preflight/v1" as const;

/** CLI switch for sealed candidate preflight — single string site for packaging audit. */
export const STATE_UPDATE_PREFLIGHT_SWITCH =
  "--vellum-state-preflight" as const;

export const StateUpdatePreflightReceipt = Schema.Struct({
  protocol: Schema.Literal(STATE_UPDATE_PREFLIGHT_PROTOCOL),
  candidateId: Schema.UUID,
  source: Schema.Literal("fresh", "installed"),
  sourceSchemaVersion: Schema.Number.pipe(
    Schema.int(),
    Schema.nonNegative(),
  ),
  targetSchemaVersion: Schema.Number.pipe(
    Schema.int(),
    Schema.positive(),
  ),
  targetSchemaSha256: Schema.String.pipe(
    Schema.pattern(/^[0-9a-f]{64}$/),
  ),
  backupFile: Schema.optionalWith(
    Schema.String.pipe(
      Schema.pattern(/^vellum-backup-[0-9a-f-]{36}\.db$/),
    ),
    { exact: true },
  ),
  installationId: InstallationId,
  role: Schema.Literal("unenrolled", "command-center", "remote"),
  canvasCount: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  actorSeatCount: Schema.Number.pipe(Schema.int(), Schema.nonNegative()),
  workSnapshotCount: Schema.Number.pipe(
    Schema.int(),
    Schema.nonNegative(),
  ),
  pendingCommandCount: Schema.Number.pipe(
    Schema.int(),
    Schema.nonNegative(),
  ),
  armedRegionCount: Schema.Number.pipe(
    Schema.int(),
    Schema.nonNegative(),
  ),
  schedulerCursorCount: Schema.Number.pipe(
    Schema.int(),
    Schema.nonNegative(),
  ),
  activeIntent: Schema.optionalWith(
    Schema.Struct({
      generation: Schema.String.pipe(Schema.pattern(/^[1-9][0-9]*$/)),
      contentSha256: Schema.String.pipe(
        Schema.pattern(/^[0-9a-f]{64}$/),
      ),
    }),
    { exact: true },
  ),
  ready: Schema.Literal(true),
});
export type StateUpdatePreflightReceipt =
  typeof StateUpdatePreflightReceipt.Type;

type SchedulerCursorKey = {
  readonly home_station: string;
  readonly timer_key: string;
};

type WorkRouteKey = {
  readonly event_home: string;
  readonly entity_home: string;
};

const readinessError = (
  cause: unknown,
): StateUpdateCandidateError =>
  StateUpdateCandidateError.make({
    operation: "readiness",
    message: cause instanceof Error ? cause.message : String(cause),
    cause,
  });

/**
 * Prove that the candidate's migrated clone is consumable through the same
 * repositories and active-intent compiler used by the product.
 *
 * This deliberately performs no physical actor, browser, SSH, or terminal
 * action. Package activation proves those host surfaces after the one-way
 * cutover. Clone preflight proves the part that could otherwise strand the
 * installed database: schema admission, migration, Station state, Work state,
 * scheduler/kernel persistence, and portfolio compilation.
 */
export const inspectStateUpdateCandidate = (
  candidate: PreparedStateUpdateCandidate,
): Effect.Effect<
  StateUpdatePreflightReceipt,
  StateUpdateCandidateError
> => {
  const state = makeStateEngineLive(candidate.databasePath);
  const repositories = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      StationRepositoryLive,
      KernelStateRepositoryLive,
      SchedulerRepositoryLive,
      LicenseRepositoryLive,
    ),
    state,
  );
  const readinessLayer = Layer.provideMerge(
    CanvasesLive,
    repositories,
  );

  return Effect.gen(function* () {
    const engine = yield* StateEngine;
    const canvases = yield* CanvasesService;
    const station = yield* StationRepository;
    const work = yield* WorkRepository;
    const kernel = yield* KernelStateRepository;
    const scheduler = yield* SchedulerRepository;
    const license = yield* LicenseRepository;

    // license.read may return ActivatedLicense | undefined — both OK.
    // Corrupt or persistence failure fails preflight. No Dodo call; no
    // license gate on update activation.
    yield* license.read;

    const {
      canvasSummaries,
      actorRefs,
      stationFacts,
      pendingCommands,
      armedRegions,
      debugPulseRing,
      schedulerKeys,
      workRoutes,
    } = yield* Effect.all({
      canvasSummaries: canvases.list,
      actorRefs: canvases.activeActorRefs(),
      stationFacts: station.statusFacts,
      pendingCommands: work.pendingCommands,
      armedRegions: kernel.listArmedRegions,
      debugPulseRing: kernel.readDebugPulseRing,
      schedulerKeys: engine.read(
        "state-update.scheduler-keys",
        (reader) =>
          reader.all<SchedulerCursorKey>(
            `
              SELECT home_station, timer_key
              FROM scheduler_interval_state
              ORDER BY home_station, timer_key
            `,
          ),
      ),
      workRoutes: engine.read(
        "state-update.work-routes",
        (reader) =>
          reader.all<WorkRouteKey>(
            `
              SELECT event_home, entity_home
              FROM work_events
              UNION
              SELECT event_home, entity_home
              FROM work_proposal_events
              ORDER BY event_home, entity_home
            `,
          ),
      ),
    });
    // Reading every material snapshot forces current Work decoders across the
    // migrated clone rather than proving only that its tables exist.
    const workSnapshots = yield* Effect.forEach(
      canvasSummaries,
      (canvas) => work.snapshotsForCanvas(canvas.name),
      { concurrency: 1 },
    );
    // A current material snapshot does not prove already-resolved history.
    // Walk every immutable route through the public repository decoder so a
    // corrupt historical fact, command, or disposition blocks activation.
    yield* Effect.forEach(
      workRoutes,
      (key) =>
        Effect.gen(function* () {
          const eventHome = Schema.decodeUnknownSync(InstallationId)(
            key.event_home,
          );
          const entityHome = Schema.decodeUnknownSync(InstallationId)(
            key.entity_home,
          );
          let after: LogicalSequence | undefined;
          while (true) {
            const page = yield* work.recordsAfter({
              route: { eventHome, entityHome },
              ...(after === undefined ? {} : { after }),
              limit: 256,
            });
            if (page.length === 0) break;
            after = page.at(-1)!.id.seq;
            if (page.length < 256) break;
          }
        }),
      { concurrency: 1 },
    );
    // Likewise, exercise the scheduler's typed decoder for every retained
    // cursor. A malformed historical row must fail preflight.
    yield* Effect.forEach(
      schedulerKeys,
      (key) =>
        scheduler.readIntervalState(
          key.home_station,
          key.timer_key,
        ).pipe(
          Effect.flatMap((state) =>
            state === undefined
              ? Effect.fail(
                  new Error(
                    "scheduler cursor disappeared during candidate preflight",
                  ),
                )
              : Effect.void,
          ),
        ),
      { concurrency: 1 },
    );
    // Decoding the retained ring above is itself the readiness proof. Keep
    // the value observed so an optimizer or future refactor cannot silently
    // drop that repository read as "unused".
    void debugPulseRing;

    const activeIntent =
      canvasSummaries.length === 0
        ? undefined
        : yield* canvases.activeIntentWitness();
    const configuration = stationFacts.configuration;
    const role =
      configuration === undefined ? "unenrolled" : configuration.role;
    const receipt = {
      protocol: STATE_UPDATE_PREFLIGHT_PROTOCOL,
      candidateId: candidate.id,
      source: candidate.source._tag,
      sourceSchemaVersion:
        candidate.source._tag === "installed"
          ? candidate.source.backup.schemaVersion
          : 0,
      targetSchemaVersion: engine.info.schemaVersion,
      targetSchemaSha256: engine.info.schemaSha256,
      ...(candidate.source._tag === "installed"
        ? { backupFile: basename(candidate.source.backup.path) }
        : {}),
      installationId: stationFacts.installationId,
      role,
      canvasCount: canvasSummaries.length,
      actorSeatCount: actorRefs.length,
      workSnapshotCount: workSnapshots.reduce(
        (count, snapshots) => count + snapshots.length,
        0,
      ),
      pendingCommandCount: pendingCommands.length,
      armedRegionCount: armedRegions.length,
      schedulerCursorCount: schedulerKeys.length,
      ...(activeIntent === undefined ? {} : { activeIntent }),
      ready: true,
    } as const;
    // Keep the proof surface closed even though every field above is already
    // typed. The packaged helper prints only this strict receipt.
    return Schema.decodeUnknownSync(StateUpdatePreflightReceipt)(receipt);
  }).pipe(
    Effect.provide(readinessLayer),
    Effect.scoped,
    Effect.mapError(readinessError),
    Effect.withSpan("state.update.candidate-readiness"),
  );
};
