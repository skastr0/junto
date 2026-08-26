import { createHash } from "node:crypto";
import {
  copyFile,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DatabaseSync,
  type SQLOutputValue,
} from "node:sqlite";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  CanvasesLive,
  CanvasesService,
} from "../src/main/vellum/canvases";
import {
  verifyCanvasIntentMaterial,
} from "../src/main/vellum/canvas-intent-identity";
import { serializeCanvas } from "../src/shared/canvas";
import {
  makeSchedulerRepositoryLive,
  SchedulerRepository,
} from "../src/main/vellum/scheduler/repository";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/vellum/state/engine";
import {
  CURRENT_STATE_SCHEMA_VERSION,
  STATE_SCHEMA_V1_IDENTITY,
} from "../src/main/vellum/state/migrations";
import {
  verifyRecordedStateSchemaIdentity,
} from "../src/main/vellum/state/schema-identity";
import {
  StationFleetTargetRepositoryLive,
  StationFleetTargetRepository,
} from "../src/main/vellum/station/fleet-target-repository";
import {
  decodeStationPortfolioBody,
} from "../src/main/vellum/station/portfolio";
import {
  makeStationRepositoryLive,
  StationRepository,
} from "../src/main/vellum/station/repository";
import {
  WorkRepository,
  WorkRepositoryLive,
} from "../src/main/vellum/work/repository";
import { InstallationId } from "../src/shared/installation-id";

const COMMAND_CENTER_ID = Schema.decodeUnknownSync(InstallationId)(
  "command-center-v1",
);
const REMOTE_ID = Schema.decodeUnknownSync(InstallationId)("remote-v1");

type FixtureCase = {
  readonly role: "command-center" | "remote";
  readonly fileName: string;
  readonly sha256: string;
  readonly preservedTables: ReadonlyArray<string>;
};

const cases = [
  {
    role: "command-center",
    fileName: "command-center-v1.db",
    sha256:
      "e1c12bcf3a662f52854936bfee1c0ef5fd41e024e80d7223bd3c90e0a1d00d2c",
    preservedTables: [
      "canvas_generations",
      "canvas_generation_documents",
      "canvas_head",
      "host_registry",
      "host_registry_state",
      "station_known_installations",
      "station_installation",
      "station_configuration",
      "station_fleet_targets",
      "station_peer_ack_cursors",
      "work_event_sequences",
      "work_events",
      "work_facts",
      "work_tasks",
      "work_task_messages",
      "work_task_transitions",
    ],
  },
  {
    role: "remote",
    fileName: "remote-v1.db",
    sha256:
      "23db672fe4f4fbc7fbe0fe4a5c9efd3f009f93f4500462aa036b9aa57ac19cc9",
    preservedTables: [
      "host_registry",
      "host_registry_state",
      "station_known_installations",
      "station_installation",
      "station_pairing",
      "station_configuration",
      "station_projection_versions",
      "station_projection_head",
      "station_received_cursors",
      "station_peer_ack_cursors",
      "work_event_sequences",
      "work_events",
      "work_commands",
      "work_facts",
      "work_dispositions",
      "work_tasks",
      "work_task_messages",
      "work_task_transitions",
      "scheduler_interval_state",
      "scheduler_interval_firings",
    ],
  },
] as const satisfies ReadonlyArray<FixtureCase>;

type PreservedTable = {
  readonly columns: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<
    Readonly<Record<string, SQLOutputValue>>
  >;
};

type PreservationWitness = Readonly<Record<string, PreservedTable>>;

const fixturePath = (fileName: string): string =>
  fileURLToPath(
    new URL(`./fixtures/state-v1/${fileName}`, import.meta.url),
  );

const fileSha256 = async (path: string): Promise<string> =>
  createHash("sha256").update(await readFile(path)).digest("hex");

const quotedIdentifier = (identifier: string): string =>
  `"${identifier.replaceAll('"', '""')}"`;

const readTable = (
  database: DatabaseSync,
  table: string,
  columns?: ReadonlyArray<string>,
): PreservedTable => {
  const admittedColumns =
    columns ??
    (
      database
        .prepare(
          `
            SELECT name
            FROM pragma_table_info(?)
            ORDER BY cid
          `,
        )
        .all(table) as unknown as ReadonlyArray<{
          readonly name: SQLOutputValue;
        }>
    ).map(({ name }) => String(name));
  if (admittedColumns.length === 0) {
    throw new Error(`fixture table ${table} is missing`);
  }
  const projection = admittedColumns.map(quotedIdentifier).join(", ");
  return {
    columns: admittedColumns,
    rows: database
      .prepare(
        `SELECT ${projection}
           FROM ${quotedIdentifier(table)}
          ORDER BY ${projection}`,
      )
      .all() as unknown as ReadonlyArray<
        Readonly<Record<string, SQLOutputValue>>
      >,
  };
};

const capturePreservationWitness = (
  database: DatabaseSync,
  tables: ReadonlyArray<string>,
): PreservationWitness => {
  const nonEmptyTables = (
    database
      .prepare(
        `
          SELECT name
          FROM sqlite_schema
          WHERE type = 'table'
            AND name NOT LIKE 'sqlite_%'
            AND name <> 'state_schema_identity'
          ORDER BY name
        `,
      )
      .all() as unknown as ReadonlyArray<{
        readonly name: SQLOutputValue;
      }>
  )
    .map(({ name }) => String(name))
    .filter((table) => readTable(database, table).rows.length > 0);
  expect([...tables].sort()).toEqual(nonEmptyTables);
  return Object.fromEntries(
    tables.map((table) => [table, readTable(database, table)]),
  );
};

const readPreservedColumns = (
  database: DatabaseSync,
  baseline: PreservationWitness,
): PreservationWitness =>
  Object.fromEntries(
    Object.entries(baseline).map(([table, witness]) => [
      table,
      readTable(database, table, witness.columns),
    ]),
  );

const openReadOnly = (path: string): DatabaseSync =>
  new DatabaseSync(path, {
    open: true,
    readOnly: true,
    allowExtension: false,
    enableForeignKeyConstraints: true,
  });

const expectHealthyVersionOne = (database: DatabaseSync): void => {
  expect(database.prepare("PRAGMA user_version").get()).toEqual({
    user_version: 1,
  });
  expect(verifyRecordedStateSchemaIdentity(database)).toMatchObject(
    STATE_SCHEMA_V1_IDENTITY,
  );
  expect(database.prepare("PRAGMA quick_check").get()).toEqual({
    quick_check: "ok",
  });
  expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  expect(
    database
      .prepare(
        `
          SELECT name
          FROM sqlite_schema
          WHERE type = 'table'
            AND name = 'license_activation'
        `,
      )
      .get(),
  ).toBeUndefined();
};

const makeFixtureRuntime = (path: string) => {
  const state = makeStateEngineLive(path);
  const repositories = Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive,
      makeStationRepositoryLive({
        now: () => "2026-07-28T13:00:00.000Z",
      }),
      StationFleetTargetRepositoryLive,
      makeSchedulerRepositoryLive({
        now: (epochMilliseconds) =>
          new Date(epochMilliseconds).toISOString(),
      }),
    ),
    state,
  );
  return ManagedRuntime.make(
    Layer.provideMerge(CanvasesLive, repositories),
  );
};

const assertCommonWorkProjection = async (
  runtime: ReturnType<typeof makeFixtureRuntime>,
  expectedTaskId: string,
): Promise<void> => {
  const { canvases, work } = await runtime.runPromise(
    Effect.gen(function* () {
      return {
        canvases: yield* CanvasesService,
        work: yield* WorkRepository,
      };
    }),
  );
  const canvas = await runtime.runPromise(canvases.read("factory"));
  const snapshot = await runtime.runPromise(
    work.readSnapshot("factory", "tasks"),
  );

  expect(canvas.name).toBe("factory");
  expect(canvas.actorRefs).toHaveLength(1);
  expect(snapshot.tasks.items).toHaveLength(1);
  expect(snapshot.tasks.items[0]).toMatchObject({
    id: expectedTaskId,
    state: "working",
    claimedBy: canvas.actorRefs[0]!.seatId,
  });
  const taskNode = canvas.doc.nodes.find(({ id }) => id === "tasks");
  expect(taskNode?.ether?.tasks?.items[0]).toMatchObject({
    id: expectedTaskId,
    state: "working",
    claimedBy: canvas.actorRefs[0]!.seatId,
  });
};

const assertCommandCenterRepositories = async (
  runtime: ReturnType<typeof makeFixtureRuntime>,
): Promise<void> => {
  const { canvases, fleet, station, work } = await runtime.runPromise(
    Effect.gen(function* () {
      return {
        canvases: yield* CanvasesService,
        fleet: yield* StationFleetTargetRepository,
        station: yield* StationRepository,
        work: yield* WorkRepository,
      };
    }),
  );
  const authority = await runtime.runPromise(
    canvases.authorityMaterialSnapshot(),
  );
  const status = await runtime.runPromise(station.statusFacts);
  const targets = await runtime.runPromise(fleet.list);
  const records = await runtime.runPromise(
    work.recordsAfter({
      route: {
        eventHome: COMMAND_CENTER_ID,
        entityHome: COMMAND_CENTER_ID,
      },
    }),
  );

  expect(authority).toMatchObject({
    generation: "9",
    documents: expect.any(Map),
  });
  expect(authority.documents.get("factory")?.nodes).toHaveLength(2);
  expect(() => verifyCanvasIntentMaterial(authority)).not.toThrow();
  const storedFactory = authority.storedDocuments.get("factory");
  expect(storedFactory?.rawBody).toContain('"ports"');
  expect(storedFactory?.rawBody).not.toBe(
    serializeCanvas(storedFactory!.document),
  );
  expect(storedFactory?.document.edges[0]?.ether).toEqual({
    verb: "contributes",
  });
  expect(status).toMatchObject({
    installationId: COMMAND_CENTER_ID,
    configuration: {
      role: "command-center",
      hostId: "local",
      supervisedPreferred: true,
    },
    peerAcknowledgedThrough: [
      {
        peerInstallationId: REMOTE_ID,
        acknowledgement: {
          eventHome: COMMAND_CENTER_ID,
          entityHome: COMMAND_CENTER_ID,
          through: "2",
        },
      },
    ],
  });
  expect(status.pairing).toBeUndefined();
  expect(status.projection).toBeUndefined();
  expect(targets).toEqual([
    {
      hostId: "studio",
      stationInstallationId: REMOTE_ID,
      boundAt: "2026-07-28T12:00:00.000Z",
    },
  ]);
  expect(
    records.map((record) => ({
      recordType: record.recordType,
      operation: record.operation,
      seq: record.id.seq,
    })),
  ).toEqual([
    { recordType: "fact", operation: "task.create", seq: "1" },
    { recordType: "fact", operation: "task.claim", seq: "2" },
  ]);
  await assertCommonWorkProjection(runtime, "task-v1-cc");
};

const assertRemoteRepositories = async (
  runtime: ReturnType<typeof makeFixtureRuntime>,
): Promise<void> => {
  const { canvases, scheduler, state, station, work } = await runtime.runPromise(
    Effect.gen(function* () {
      return {
        canvases: yield* CanvasesService,
        scheduler: yield* SchedulerRepository,
        state: yield* StateEngine,
        station: yield* StationRepository,
        work: yield* WorkRepository,
      };
    }),
  );
  const status = await runtime.runPromise(station.statusFacts);
  const projection = await runtime.runPromise(station.projection);
  const intent = await runtime.runPromise(canvases.activeIntentWitness());
  const commandRecords = await runtime.runPromise(
    work.recordsAfter({
      route: {
        eventHome: COMMAND_CENTER_ID,
        entityHome: REMOTE_ID,
      },
    }),
  );
  const localRecords = await runtime.runPromise(
    work.recordsAfter({
      route: { eventHome: REMOTE_ID, entityHome: REMOTE_ID },
    }),
  );
  const schedulerState = await runtime.runPromise(
    scheduler.readIntervalState("studio", "factory::timer-v1"),
  );
  const durableRemoteWitness = await runtime.runPromise(
    state.read("state-v1-fixture.remote-witness", (reader) => ({
      authorialRows: {
        generations: Number(
          reader.get<{ count: number }>(
            "SELECT COUNT(*) AS count FROM canvas_generations",
          )?.count ?? -1,
        ),
        documents: Number(
          reader.get<{ count: number }>(
            "SELECT COUNT(*) AS count FROM canvas_generation_documents",
          )?.count ?? -1,
        ),
        heads: Number(
          reader.get<{ count: number }>(
            "SELECT COUNT(*) AS count FROM canvas_head",
          )?.count ?? -1,
        ),
      },
      intervalFiring: reader.get<{
        claim_slot: string;
        due_slot: string;
        scheduled_for_epoch_ms: number;
        observed_at_epoch_ms: number;
        missed_intervals: string;
      }>(
        `
          SELECT claim_slot,
                 due_slot,
                 scheduled_for_epoch_ms,
                 observed_at_epoch_ms,
                 coalesced_missed_slots AS missed_intervals
          FROM scheduler_interval_firings
          WHERE home_station = 'studio'
            AND timer_key = 'factory::timer-v1'
        `,
      ),
    })),
  );

  expect(status).toMatchObject({
    installationId: REMOTE_ID,
    pairing: {
      commandCenterInstallationId: COMMAND_CENTER_ID,
      stationLabel: "Studio Mini",
      appVersion: "0.1.0-v1",
    },
    configuration: {
      role: "remote",
      hostId: "studio",
      agentHostId: "studio",
      commandCenterInstallationId: COMMAND_CENTER_ID,
      supervisedPreferred: true,
    },
    projection: {
      generation: "3",
    },
    receivedThrough: [
      {
        eventHome: COMMAND_CENTER_ID,
        entityHome: REMOTE_ID,
        through: "1",
      },
    ],
    peerAcknowledgedThrough: [
      {
        peerInstallationId: COMMAND_CENTER_ID,
        acknowledgement: {
          eventHome: REMOTE_ID,
          entityHome: REMOTE_ID,
          through: "2",
        },
      },
    ],
  });
  expect(projection).toMatchObject({
    scope: "full",
    generation: "3",
    sourceCanvasGeneration: "9",
  });
  if (projection === undefined) {
    throw new Error("Remote fixture projection is missing");
  }
  const decoded = decodeStationPortfolioBody(projection.body);
  expect(decoded.documents.get("factory")?.nodes.map(({ id }) => id)).toEqual(
    ["tasks", "agent", "timer-v1"],
  );
  expect(
    decoded.documents
      .get("factory")
      ?.nodes.find(({ id }) => id === "timer-v1")
      ?.ether?.host,
  ).toBe("studio");
  expect(intent).toEqual({
    generation: projection.generation,
    contentSha256: projection.contentSha256,
  });
  expect(
    commandRecords.map((record) => ({
      recordType: record.recordType,
      operation: record.operation,
      seq: record.id.seq,
    })),
  ).toEqual([
    { recordType: "command", operation: "task.claim", seq: "1" },
  ]);
  expect(
    localRecords.map((record) => ({
      recordType: record.recordType,
      operation: record.operation,
      seq: record.id.seq,
    })),
  ).toEqual([
    { recordType: "fact", operation: "task.claim", seq: "1" },
    {
      recordType: "disposition",
      operation: "task.claim",
      seq: "2",
    },
  ]);
  expect(schedulerState).toEqual({
    version: 1,
    scheduleId: "schedule-v1",
    intervalMilliseconds: 60_000,
    catchUpPolicy: "coalesce-latest",
    nextDueAtEpochMs: 1_300_000,
    nextDueSlot: "4",
    lastFiredSlot: "3",
  });
  expect(durableRemoteWitness).toEqual({
    authorialRows: {
      generations: 0,
      documents: 0,
      heads: 0,
    },
    intervalFiring: {
      claim_slot: "0",
      due_slot: "3",
      scheduled_for_epoch_ms: 1_240_000,
      observed_at_epoch_ms: 1_250_000,
      missed_intervals: "3",
    },
  });
  await assertCommonWorkProjection(runtime, "task-v1-remote");
};

describe("frozen state schema v1 compatibility fixtures", () => {
  it.each(cases)(
    "migrates the copied $role fixture without changing v1 rows",
    async (fixture) => {
      const sourcePath = fixturePath(fixture.fileName);
      expect(await fileSha256(sourcePath)).toBe(fixture.sha256);

      const source = openReadOnly(sourcePath);
      let baseline: PreservationWitness;
      try {
        expectHealthyVersionOne(source);
        baseline = capturePreservationWitness(
          source,
          fixture.preservedTables,
        );
      } finally {
        source.close();
      }

      const root = await mkdtemp(join(tmpdir(), `vellum-${fixture.role}-v1-`));
      const migratedPath = join(root, fixture.fileName);
      await copyFile(sourcePath, migratedPath);
      const runtime = makeFixtureRuntime(migratedPath);
      try {
        const state = await runtime.runPromise(StateEngine);
        expect(state.info.schemaVersion).toBe(CURRENT_STATE_SCHEMA_VERSION);
        if (fixture.role === "command-center") {
          await assertCommandCenterRepositories(runtime);
        } else {
          await assertRemoteRepositories(runtime);
        }
      } finally {
        await runtime.dispose();
      }

      try {
        const migrated = openReadOnly(migratedPath);
        try {
          expect(migrated.prepare("PRAGMA user_version").get()).toEqual({
            user_version: CURRENT_STATE_SCHEMA_VERSION,
          });
          expect(
            readPreservedColumns(migrated, baseline),
          ).toEqual(baseline);
          expect(migrated.prepare("PRAGMA quick_check").get()).toEqual({
            quick_check: "ok",
          });
          expect(migrated.prepare("PRAGMA foreign_key_check").all()).toEqual(
            [],
          );
          expect(
            migrated
              .prepare(
                `
                  SELECT name
                  FROM sqlite_schema
                  WHERE type = 'table'
                    AND name = 'license_activation'
                `,
              )
              .get(),
          ).toEqual({ name: "license_activation" });
        } finally {
          migrated.close();
        }

        const backups = await readdir(join(root, "backups"));
        expect(backups).toHaveLength(1);
        const backup = openReadOnly(join(root, "backups", backups[0]!));
        try {
          expectHealthyVersionOne(backup);
          expect(readPreservedColumns(backup, baseline)).toEqual(baseline);
        } finally {
          backup.close();
        }
        expect(await fileSha256(sourcePath)).toBe(fixture.sha256);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
