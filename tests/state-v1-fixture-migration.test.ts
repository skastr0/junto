import { createHash } from "node:crypto";
import {
  copyFile,
  mkdtemp,
  readFile,
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
import { SqlClient } from "effect/unstable/sql";
import { describe, expect, it } from "vitest";
import {
  CanvasesLive,
  CanvasesService,
} from "../src/main/junto/canvases";
import {
  verifyCanvasIntentMaterial,
} from "../src/main/junto/canvas-intent-identity";
import { serializeCanvas } from "../src/shared/canvas";
import {
  makeSchedulerRepositoryLive,
} from "../src/main/junto/scheduler/repository";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/junto/state/engine";
import { withSqlRead } from "../src/main/junto/state/sql-read";
import {
  CURRENT_STATE_SCHEMA_VERSION,
  STATE_SCHEMA_V1_IDENTITY,
} from "../src/main/junto/state/migrations";
import {
  verifyRecordedStateSchemaIdentity,
} from "../src/main/junto/state/schema-identity";
import {
  StationFleetTargetRepositoryLive,
  StationFleetTargetRepository,
} from "../src/main/junto/station/fleet-target-repository";
import {
  decodeStationPortfolioBody,
} from "../src/main/junto/station/portfolio";
import {
  makeStationRepositoryLive,
  StationRepository,
} from "../src/main/junto/station/repository";
import {
  WorkRepositoryLive,
} from "../src/main/junto/work/repository";
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

const cases: ReadonlyArray<FixtureCase> = [
  {
    role: "command-center",
    fileName: "command-center-v1.db",
    sha256:
      "ba3fd2b90591bd83f3706b153799c0f325ab47bc10b273be5fdcccd9155a2615",
    preservedTables: [
      "canvas_documents",
      "canvas_edges",
      "canvas_nodes",
      "canvas_portfolio_head",
      "host_registry",
      "host_registry_state",
      "station_known_installations",
      "station_installation",
      "station_configuration",
      "station_fleet_targets",
      "station_peer_ack_cursors",
      "work_canvas_revisions",
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
      "2d9e0be7c9571292ad872e45b415efa8fbdfa91198ab0a178f1ae31d12c6588a",
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
      "work_canvas_revisions",
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
];

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
  ).toEqual({ name: "license_activation" });
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

const assertCommandCenterRepositories = async (
  runtime: ReturnType<typeof makeFixtureRuntime>,
): Promise<void> => {
  const { canvases, fleet, station } = await runtime.runPromise(
    Effect.gen(function* () {
      return {
        canvases: yield* CanvasesService,
        fleet: yield* StationFleetTargetRepository,
        station: yield* StationRepository,
      };
    }),
  );
  const authority = await runtime.runPromise(
    canvases.authorityMaterialSnapshot(),
  );
  const status = await runtime.runPromise(station.statusFacts);
  const targets = await runtime.runPromise(fleet.list);

  expect(authority).toMatchObject({
    generation: "9",
    documents: expect.any(Map),
  });
  expect(authority.documents.get("factory")?.nodes).toHaveLength(2);
  expect(() => verifyCanvasIntentMaterial(authority)).not.toThrow();
  const storedFactory = authority.storedDocuments.get("factory");
  // Authority is relational at the v1 baseline: the derived body is canonical
  // serialization and retired wire fields are absent from durable state.
  expect(storedFactory?.rawBody).not.toContain('"ports"');
  expect(storedFactory?.rawBody).toBe(
    serializeCanvas(storedFactory!.document),
  );
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
};

const assertRemoteRepositories = async (
  runtime: ReturnType<typeof makeFixtureRuntime>,
): Promise<void> => {
  const { canvases, sql, station } = await runtime.runPromise(
    Effect.gen(function* () {
      return {
        canvases: yield* CanvasesService,
        sql: yield* SqlClient.SqlClient,
        station: yield* StationRepository,
      };
    }),
  );
  const status = await runtime.runPromise(station.statusFacts);
  const projection = await runtime.runPromise(station.projection);
  const intent = await runtime.runPromise(canvases.activeIntentWitness());
  const durableRemoteWitness = await runtime.runPromise(
    withSqlRead(sql, Effect.gen(function* () {
      return {
        authorialRows: {
          blobTables: Number((yield* sql<{ count: number }>`
            SELECT COUNT(*) AS count
            FROM sqlite_schema
            WHERE type = 'table'
              AND name IN (
                'canvas_generations',
                'canvas_generation_documents',
                'canvas_head'
              )
          `)[0]?.count ?? -1),
          documents: Number((yield* sql<{ count: number }>`
            SELECT COUNT(*) AS count FROM canvas_documents
          `)[0]?.count ?? -1),
          heads: Number((yield* sql<{ count: number }>`
            SELECT COUNT(*) AS count FROM canvas_portfolio_head
          `)[0]?.count ?? -1),
        },
      };
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
  expect(decoded.documents.get("factory")?.nodes.map(({ id }) => id)).toContain(
    "agent",
  );
  expect(intent).toEqual({
    generation: projection.generation,
    contentSha256: projection.contentSha256,
  });
  expect(durableRemoteWitness).toEqual({
    authorialRows: {
      blobTables: 0,
      documents: 0,
      heads: 0,
    },
  });
};

describe("state schema v1 baseline fixtures", () => {
  it.each(cases)(
    "opens the copied $role fixture at the current baseline without changing rows",
    async (fixture) => {
      const sourcePath = fixturePath(fixture.fileName);
      expect(await fileSha256(sourcePath)).toBe(fixture.sha256);

      const source = openReadOnly(sourcePath);
      let baseline: PreservationWitness;
      try {
        expectHealthyVersionOne(source);
        baseline = capturePreservationWitness(source, fixture.preservedTables);
      } finally {
        source.close();
      }

      const root = await mkdtemp(join(tmpdir(), `junto-${fixture.role}-v1-`));
      const openedPath = join(root, fixture.fileName);
      await copyFile(sourcePath, openedPath);
      const runtime = makeFixtureRuntime(openedPath);
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
        const opened = openReadOnly(openedPath);
        try {
          expect(opened.prepare("PRAGMA user_version").get()).toEqual({
            user_version: CURRENT_STATE_SCHEMA_VERSION,
          });
          expect(readPreservedColumns(opened, baseline)).toEqual(baseline);
          expect(opened.prepare("PRAGMA quick_check").get()).toEqual({
            quick_check: "ok",
          });
          expect(opened.prepare("PRAGMA foreign_key_check").all()).toEqual(
            [],
          );
        } finally {
          opened.close();
        }
        expect(await fileSha256(sourcePath)).toBe(fixture.sha256);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
