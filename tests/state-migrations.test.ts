import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  STATE_SCHEMA_CONSOLIDATE_SAFETY,
  STATE_SCHEMA_MIGRATION_SAFETY,
  STATE_SCHEMA_MIGRATION_PLAN,
  STATE_SCHEMA_MIGRATIONS,
  STATE_SCHEMA_V76_IDENTITY,
  STATE_SCHEMA_V83_IDENTITY,
  migrateStateSchema,
  validateStateSchemaMigrationPlan,
  type StateSchemaMigrationDatabase,
  type StateSchemaMigrationPlan,
} from "../src/core/state/migrations";
import { migrateMachineNames } from "../src/core/state/migrate-machine-names";
import { analyzeTables } from "../src/core/state/maintenance-worker";
import {
  STATE_SCHEMA_IDENTITY_SQL,
  STATE_SCHEMA_SQL,
} from "../src/core/state/schema";
import {
  expectedStateSchemaIdentity,
  verifyAndStampStateSchema,
} from "../src/core/state/schema-identity";
import { STATE_SCHEMA_V76_SQL } from "./fixtures/state-v13/schema";

const VERSION_ONE_SQL = `
  ${STATE_SCHEMA_IDENTITY_SQL}
  CREATE TABLE migration_items (
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL
  ) STRICT;
`;

const VERSION_TWO_SQL = `
  ${STATE_SCHEMA_IDENTITY_SQL}
  CREATE TABLE migration_items (
    id TEXT PRIMARY KEY,
    payload TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT 'migrated'
  ) STRICT;
`;

const openDatabase = (): DatabaseSync => {
  const database = new DatabaseSync(":memory:", {
    open: true,
    readOnly: false,
    allowExtension: false,
    enableForeignKeyConstraints: true,
  });
  database.exec("PRAGMA foreign_keys = ON");
  return database;
};

const seedVersionOne = (
  database: DatabaseSync,
  version = 1,
): void => {
  database.exec(VERSION_ONE_SQL);
  database
    .prepare(
      "INSERT INTO migration_items(id, payload) VALUES (?, ?)",
    )
    .run("preserved", "before");
  verifyAndStampStateSchema(database, VERSION_ONE_SQL);
  database.exec(`PRAGMA user_version = ${version}`);
};

const migrationPlan = (
  migrate: StateSchemaMigrationPlan["migrations"][number]["migrate"],
): StateSchemaMigrationPlan => {
  const versionOne = expectedStateSchemaIdentity(VERSION_ONE_SQL);
  return {
    baselineVersion: 1,
    baselineIdentity: versionOne,
    currentVersion: 2,
    currentSchemaSql: VERSION_TWO_SQL,
    migrations: [
      {
        fromVersion: 1,
        toVersion: 2,
        name: "add-migration-note",
        safety: STATE_SCHEMA_MIGRATION_SAFETY,
        fromIdentity: versionOne,
        migrate,
      },
    ],
  };
};

const databaseWitness = (database: DatabaseSync) => ({
  version: database.prepare("PRAGMA user_version").get(),
  schema: database
    .prepare(
      `
        SELECT type, name, sql
        FROM sqlite_schema
        WHERE name NOT GLOB 'sqlite_*'
        ORDER BY type, name
      `,
    )
    .all(),
  identity: database
    .prepare(
      `
        SELECT actual_schema_sha256, verified_at
        FROM state_schema_identity
        WHERE singleton = 1
      `,
    )
    .get(),
  rows: database
    .prepare("SELECT * FROM migration_items ORDER BY id")
    .all(),
});

describe("State schema migrations", () => {
  it("opens nothing older than version 13", () => {
    expect(STATE_SCHEMA_MIGRATION_PLAN.baselineVersion).toBe(13);
    expect(STATE_SCHEMA_MIGRATION_PLAN.migrations[0]?.fromVersion).toBe(13);
    const database = openDatabase();
    seedVersionOne(database, 12);
    expect(() => migrateStateSchema(database, STATE_SCHEMA_MIGRATION_PLAN)).toThrow(
      "state schema version 12 predates the supported baseline 13",
    );
    expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 12 });
  });

  it("rejects a branching or incomplete forward migration registry", () => {
    const identity = expectedStateSchemaIdentity(STATE_SCHEMA_SQL);
    expect(() =>
      validateStateSchemaMigrationPlan({
        baselineVersion: 1,
        baselineIdentity: identity,
        currentVersion: 3,
        currentSchemaSql: STATE_SCHEMA_SQL,
        migrations: [
          {
            fromVersion: 1,
            toVersion: 2,
            name: "one-to-two",
            safety: STATE_SCHEMA_MIGRATION_SAFETY,
            fromIdentity: identity,
            migrate: () => undefined,
          },
        ],
      })
    ).toThrow("missing state schema migration 2 -> 3");
    expect(() =>
      validateStateSchemaMigrationPlan({
        baselineVersion: 1,
        baselineIdentity: identity,
        currentVersion: 2,
        currentSchemaSql: STATE_SCHEMA_SQL,
        migrations: [
          {
            fromVersion: 1,
            toVersion: 2,
            name: "first",
            safety: STATE_SCHEMA_MIGRATION_SAFETY,
            fromIdentity: identity,
            migrate: () => undefined,
          },
          {
            fromVersion: 1,
            toVersion: 2,
            name: "branch",
            safety: STATE_SCHEMA_MIGRATION_SAFETY,
            fromIdentity: identity,
            migrate: () => undefined,
          },
        ],
      })
    ).toThrow("duplicate state schema migration from version 1");
  });

  it("migrates forward in place and preserves existing rows", () => {
    const database = openDatabase();
    try {
      seedVersionOne(database);
      const result = migrateStateSchema(
        database,
        migrationPlan((connection) => {
          connection.exec(`
            ALTER TABLE migration_items
            ADD COLUMN note TEXT NOT NULL DEFAULT 'migrated';
            UPDATE migration_items
            SET note = 'copied:' || payload
          `);
        }),
      );

      expect(result).toMatchObject({
        previousVersion: 1,
        schemaVersion: 2,
        initialized: false,
      });
      expect(database.prepare("PRAGMA user_version").get()).toEqual({
        user_version: 2,
      });
      expect(
        database
          .prepare(
            "SELECT id, payload, note FROM migration_items",
          )
          .all(),
      ).toEqual([
        {
          id: "preserved",
          payload: "before",
          note: "copied:before",
        },
      ]);
    } finally {
      database.close();
    }
  });

  it("adopts only the frozen unversioned baseline before migrating", () => {
    const database = openDatabase();
    try {
      seedVersionOne(database, 0);
      const result = migrateStateSchema(
        database,
        migrationPlan((connection) => {
          connection.exec(`
            ALTER TABLE migration_items
            ADD COLUMN note TEXT NOT NULL DEFAULT 'migrated'
          `);
        }),
      );
      expect(result.previousVersion).toBe(0);
      expect(database.prepare("PRAGMA user_version").get()).toEqual({
        user_version: 2,
      });
      expect(
        database
          .prepare(
            "SELECT payload, note FROM migration_items WHERE id = 'preserved'",
          )
          .get(),
      ).toEqual({ payload: "before", note: "migrated" });
    } finally {
      database.close();
    }
  });

  it("rejects an unversioned database with a forged baseline witness", () => {
    const database = openDatabase();
    try {
      seedVersionOne(database, 0);
      database
        .prepare(
          `
            UPDATE state_schema_identity
            SET actual_schema_sha256 = ?
            WHERE singleton = 1
          `,
        )
        .run("f".repeat(64));
      const before = databaseWitness(database);
      expect(() =>
        migrateStateSchema(
          database,
          migrationPlan((connection) => {
            connection.exec(`
              ALTER TABLE migration_items
              ADD COLUMN note TEXT NOT NULL DEFAULT 'migrated'
            `);
          }),
        )
      ).toThrow(
        /state schema changed after its recorded identity was stamped|not a recognized Junto schema/,
      );
      expect(databaseWitness(database)).toEqual(before);
    } finally {
      database.close();
    }
  });

  it("admits migration when only the retired source column differs", () => {
    const database = openDatabase();
    try {
      seedVersionOne(database, 1);
      database
        .prepare(
          `
            UPDATE state_schema_identity
            SET source_schema_sha256 = ?
            WHERE singleton = 1
          `,
        )
        .run("f".repeat(64));
      const result = migrateStateSchema(
        database,
        migrationPlan((connection) => {
          connection.exec(`
            ALTER TABLE migration_items
            ADD COLUMN note TEXT NOT NULL DEFAULT 'migrated'
          `);
        }),
      );
      expect(result.schemaVersion).toBe(2);
      expect(result.previousVersion).toBe(1);
    } finally {
      database.close();
    }
  });

  it("rolls back DDL, data, identity, and version when a migration throws", () => {
    const database = openDatabase();
    try {
      seedVersionOne(database);
      const before = databaseWitness(database);
      expect(() =>
        migrateStateSchema(
          database,
          migrationPlan((connection) => {
            connection.exec(`
              ALTER TABLE migration_items
              ADD COLUMN note TEXT NOT NULL DEFAULT 'migrated';
              UPDATE migration_items
              SET note = 'transient'
              WHERE id = 'preserved';
            `);
            throw new Error("synthetic migration failure");
          }),
        )
      ).toThrow("synthetic migration failure");
      expect(databaseWitness(database)).toEqual(before);
    } finally {
      database.close();
    }
  });

  it.each(["COMMIT", "ROLLBACK"])(
    "denies migration-owned %s so the startup transaction remains atomic",
    (transactionSql) => {
      const database = openDatabase();
      try {
        seedVersionOne(database);
        const before = databaseWitness(database);
        expect(() =>
          migrateStateSchema(
            database,
            migrationPlan((connection) => {
              connection.exec(`
                ALTER TABLE migration_items
                ADD COLUMN note TEXT NOT NULL DEFAULT 'migrated';
                INSERT INTO migration_items(id, payload, note)
                VALUES ('transient', 'during', 'migration');
                ${transactionSql};
              `);
            }),
          )
        ).toThrow();
        expect(databaseWitness(database)).toEqual(before);
      } finally {
        database.close();
      }
    },
  );

  it.each([
    ["row deletion", "DELETE FROM migration_items"],
    [
      "existing row insertion",
      "INSERT INTO migration_items(id, payload) VALUES ('second', 'new')",
    ],
    [
      "existing column rewrite",
      "UPDATE migration_items SET payload = 'lost'",
    ],
    ["table removal", "DROP TABLE migration_items"],
    [
      "table rename",
      "ALTER TABLE migration_items RENAME TO retired_items",
    ],
    [
      "column removal",
      "ALTER TABLE migration_items DROP COLUMN payload",
    ],
    [
      "row replacement",
      "INSERT OR REPLACE INTO migration_items(id, payload) VALUES ('preserved', 'lost')",
    ],
    ["version rewriting", "PRAGMA user_version = 99"],
  ])(
    "rejects destructive startup migration operation: %s",
    (_label, sql) => {
      const database = openDatabase();
      try {
        seedVersionOne(database);
        const before = databaseWitness(database);
        expect(() =>
          migrateStateSchema(
            database,
            migrationPlan((connection) => connection.exec(sql)),
          )
        ).toThrow();
        expect(databaseWitness(database)).toEqual(before);
      } finally {
        database.close();
      }
    },
  );

  it("rolls back a completed step when the final schema is not exact", () => {
    const database = openDatabase();
    try {
      seedVersionOne(database);
      const before = databaseWitness(database);
      expect(() =>
        migrateStateSchema(
          database,
          migrationPlan((connection) => {
            connection.exec(`
              ALTER TABLE migration_items
              ADD COLUMN unexpected TEXT
            `);
          }),
        )
      ).toThrow("state schema identity mismatch");
      expect(databaseWitness(database)).toEqual(before);
    } finally {
      database.close();
    }
  });

  it("rolls back a migration that leaves foreign-key violations", () => {
    const database = openDatabase();
    try {
      seedVersionOne(database);
      const before = databaseWitness(database);
      const versionOne = expectedStateSchemaIdentity(VERSION_ONE_SQL);
      const versionTwoWithChild = `
        ${VERSION_TWO_SQL}
        CREATE TABLE migration_children (
          id TEXT PRIMARY KEY,
          item_id TEXT NOT NULL
            REFERENCES migration_items(id) ON DELETE RESTRICT
        ) STRICT;
      `;
      expect(() =>
        migrateStateSchema(database, {
          baselineVersion: 1,
          baselineIdentity: versionOne,
          currentVersion: 2,
          currentSchemaSql: versionTwoWithChild,
          migrations: [
            {
              fromVersion: 1,
              toVersion: 2,
              name: "add-invalid-child",
              safety: STATE_SCHEMA_MIGRATION_SAFETY,
              fromIdentity: versionOne,
              migrate: (connection) => {
                connection.exec(`
                  ALTER TABLE migration_items
                  ADD COLUMN note TEXT NOT NULL DEFAULT 'migrated';
                  CREATE TABLE migration_children (
                    id TEXT PRIMARY KEY,
                    item_id TEXT NOT NULL
                      REFERENCES migration_items(id) ON DELETE RESTRICT
                  ) STRICT;
                  PRAGMA defer_foreign_keys = ON;
                  INSERT INTO migration_children(id, item_id)
                  VALUES ('invalid', 'missing');
                `);
              },
            },
          ],
        })
      ).toThrow("foreign-key violation");
      expect(databaseWitness(database)).toEqual(before);
    } finally {
      database.close();
    }
  });

  describe("a step that renames a table", () => {
    const BEFORE_SQL = `
      ${STATE_SCHEMA_IDENTITY_SQL}
      CREATE TABLE old_owners (id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE owned (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        FOREIGN KEY (owner) REFERENCES old_owners(id) ON DELETE RESTRICT
      ) STRICT;
      CREATE TABLE doomed (id TEXT PRIMARY KEY) STRICT;
    `;
    const AFTER_SQL = `
      ${STATE_SCHEMA_IDENTITY_SQL}
      CREATE TABLE owners (id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE owned (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        FOREIGN KEY (owner) REFERENCES owners(id) ON DELETE RESTRICT
      ) STRICT;
    `;
    const seeded = (): DatabaseSync => {
      const database = openDatabase();
      database.exec(BEFORE_SQL);
      database.exec("INSERT INTO old_owners VALUES ('a'); INSERT INTO owned VALUES ('row', 'a');");
      verifyAndStampStateSchema(database, BEFORE_SQL);
      database.exec("PRAGMA user_version = 1");
      return database;
    };
    const renamePlan = (
      step: Partial<StateSchemaMigrationPlan["migrations"][number]>,
      migrate: StateSchemaMigrationPlan["migrations"][number]["migrate"],
    ): StateSchemaMigrationPlan => {
      const from = expectedStateSchemaIdentity(BEFORE_SQL);
      return {
        baselineVersion: 1,
        baselineIdentity: from,
        currentVersion: 2,
        currentSchemaSql: AFTER_SQL,
        migrations: [
          {
            fromVersion: 1,
            toVersion: 2,
            name: "rename-owners",
            safety: STATE_SCHEMA_CONSOLIDATE_SAFETY,
            fromIdentity: from,
            removesTables: ["doomed"],
            renamesTables: { old_owners: "owners" },
            ...step,
            migrate,
          },
        ],
      };
    };
    const rename = "ALTER TABLE old_owners RENAME TO owners; DROP TABLE doomed;";
    const schema = (database: DatabaseSync) =>
      database.prepare("SELECT name, sql FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*' ORDER BY name").all();

    it("keeps the rows, and every reference follows the new name", () => {
      const database = seeded();
      try {
        migrateStateSchema(database, renamePlan({}, (connection) => connection.exec(rename)));
        expect(database.prepare("SELECT id FROM owners").all()).toEqual([{ id: "a" }]);
        expect(database.prepare("SELECT id, owner FROM owned").all()).toEqual([{ id: "row", owner: "a" }]);
        expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
        expect(() => database.exec("INSERT INTO owned VALUES ('stray', 'nobody')")).toThrow(/FOREIGN KEY/u);
        expect(() => database.exec("DELETE FROM owners WHERE id = 'a'")).toThrow(/FOREIGN KEY/u);
      } finally {
        database.close();
      }
    });

    it.each([
      ["a rename it did not declare", {}, "ALTER TABLE owned RENAME TO possessed;", /may not rename/u],
      ["a declared table renamed to another name", {}, "ALTER TABLE old_owners RENAME TO masters;", /may not rename/u],
      ["a column rename", {}, "ALTER TABLE old_owners RENAME COLUMN id TO key;", /may not rename/u],
      ["dropping the table under its new name", {}, `${rename} DROP TABLE owners;`, /not authorized/u],
      ["emptying the table under its new name", {}, `${rename} DELETE FROM owners;`, /not authorized/u],
    ] as const)("refuses %s and leaves the database as it was", (_label, step, sql, reason) => {
      const database = seeded();
      try {
        const before = schema(database);
        expect(() => migrateStateSchema(database, renamePlan(step, (connection) => connection.exec(sql)))).toThrow(reason);
        expect(schema(database)).toEqual(before);
        expect(database.prepare("SELECT id FROM old_owners").all()).toEqual([{ id: "a" }]);
        expect(database.prepare("PRAGMA user_version").get()).toEqual({ user_version: 1 });
      } finally {
        database.close();
      }
    });

    it("is only for a consolidating step", () => {
      const database = seeded();
      try {
        expect(() =>
          migrateStateSchema(
            database,
            renamePlan({ safety: STATE_SCHEMA_MIGRATION_SAFETY, removesTables: undefined }, (connection) => connection.exec(rename)),
          ),
        ).toThrow(/invalid state schema migration/u);
      } finally {
        database.close();
      }
    });
  });

  it("allows table-rebuild migrations after ANALYZE creates sqlite_stat1", () => {
    const database = openDatabase();
    try {
      seedVersionOne(database, 1);
      database.exec("ANALYZE");
      expect(
        database
          .prepare("SELECT name FROM sqlite_schema WHERE name = 'sqlite_stat1'")
          .get(),
      ).toEqual({ name: "sqlite_stat1" });

      const versionOne = expectedStateSchemaIdentity(VERSION_ONE_SQL);
      const plan: StateSchemaMigrationPlan = {
        baselineVersion: 1,
        baselineIdentity: versionOne,
        currentVersion: 2,
        currentSchemaSql: VERSION_TWO_SQL,
        migrations: [
          {
            fromVersion: 1,
            toVersion: 2,
            name: "rebuild-migration-items-after-analyze",
            safety: STATE_SCHEMA_CONSOLIDATE_SAFETY,
            fromIdentity: versionOne,
            replacesTables: ["migration_items"],
            migrate: (connection) => {
              const rows = connection
                .prepare("SELECT id, payload FROM migration_items ORDER BY id")
                .all() as Array<{ id: string; payload: string }>;
              connection.exec("DROP TABLE migration_items");
              connection.exec(`
                CREATE TABLE migration_items (
                  id TEXT PRIMARY KEY,
                  payload TEXT NOT NULL,
                  note TEXT NOT NULL DEFAULT 'migrated'
                ) STRICT;
              `);
              const insert = connection.prepare(
                "INSERT INTO migration_items(id, payload) VALUES (?, ?)",
              );
              for (const row of rows) {
                insert.run(row.id, row.payload);
              }
            },
          },
        ],
      };

      const result = migrateStateSchema(database, plan);
      expect(result.schemaVersion).toBe(2);
      expect(
        database.prepare("SELECT * FROM migration_items ORDER BY id").all(),
      ).toEqual([{ id: "preserved", payload: "before", note: "migrated" }]);
    } finally {
      database.close();
    }
  });

  it("allows table-rebuild migrations on an AUTOINCREMENT table when sqlite_stat1 and sqlite_sequence both exist", () => {
    const database = openDatabase();
    try {
      const v1Sql = `
        ${STATE_SCHEMA_IDENTITY_SQL}
        CREATE TABLE auto_items (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          payload TEXT NOT NULL
        ) STRICT;
      `;
      const v2Sql = `
        ${STATE_SCHEMA_IDENTITY_SQL}
        CREATE TABLE auto_items (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          payload TEXT NOT NULL,
          note TEXT NOT NULL DEFAULT 'migrated'
        ) STRICT;
      `;
      database.exec(v1Sql);
      database.prepare("INSERT INTO auto_items(payload) VALUES (?)").run("first");
      verifyAndStampStateSchema(database, v1Sql);
      database.exec("PRAGMA user_version = 1");
      database.exec("ANALYZE");
      expect(
        database.prepare("SELECT name FROM sqlite_schema WHERE name IN ('sqlite_stat1', 'sqlite_sequence') ORDER BY name").all(),
      ).toEqual([{ name: "sqlite_sequence" }, { name: "sqlite_stat1" }]);

      const v1Identity = expectedStateSchemaIdentity(v1Sql);
      const result = migrateStateSchema(database, {
        baselineVersion: 1,
        baselineIdentity: v1Identity,
        currentVersion: 2,
        currentSchemaSql: v2Sql,
        migrations: [
          {
            fromVersion: 1,
            toVersion: 2,
            name: "rebuild-auto-items-with-stat-and-sequence",
            safety: STATE_SCHEMA_CONSOLIDATE_SAFETY,
            fromIdentity: v1Identity,
            replacesTables: ["auto_items"],
            migrate: (connection) => {
              const rows = connection
                .prepare("SELECT seq, payload FROM auto_items ORDER BY seq")
                .all() as Array<{ seq: number; payload: string }>;
              connection.exec("DROP TABLE auto_items");
              connection.exec(`
                CREATE TABLE auto_items (
                  seq INTEGER PRIMARY KEY AUTOINCREMENT,
                  payload TEXT NOT NULL,
                  note TEXT NOT NULL DEFAULT 'migrated'
                ) STRICT;
              `);
              const insert = connection.prepare("INSERT INTO auto_items(seq, payload) VALUES (?, ?)");
              for (const row of rows) insert.run(row.seq, row.payload);
            },
          },
        ],
      });
      expect(result.schemaVersion).toBe(2);
      expect(database.prepare("SELECT * FROM auto_items ORDER BY seq").all()).toEqual([
        { seq: 1, payload: "first", note: "migrated" },
      ]);
      database.prepare("INSERT INTO auto_items(payload) VALUES (?)").run("second");
      expect(database.prepare("SELECT seq, payload FROM auto_items ORDER BY seq").all()).toEqual([
        { seq: 1, payload: "first" },
        { seq: 2, payload: "second" },
      ]);
    } finally {
      database.close();
    }
  });

  it.each([
    ["sqlite_stat1", "DELETE FROM sqlite_stat1"],
    ["sqlite_sequence", "DELETE FROM sqlite_sequence"],
  ])("still denies direct %s deletion during an expand-only migration", (_table, sql) => {
    const database = openDatabase();
    try {
      const v1Sql = `
        ${STATE_SCHEMA_IDENTITY_SQL}
        CREATE TABLE migration_items (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          payload TEXT NOT NULL
        ) STRICT;
      `;
      const v2Sql = `
        ${STATE_SCHEMA_IDENTITY_SQL}
        CREATE TABLE migration_items (
          seq INTEGER PRIMARY KEY AUTOINCREMENT,
          payload TEXT NOT NULL,
          note TEXT NOT NULL DEFAULT 'migrated'
        ) STRICT;
      `;
      database.exec(v1Sql);
      database.prepare("INSERT INTO migration_items(payload) VALUES (?)").run("before");
      verifyAndStampStateSchema(database, v1Sql);
      database.exec("PRAGMA user_version = 1");
      database.exec("ANALYZE");
      const v1Identity = expectedStateSchemaIdentity(v1Sql);
      expect(() =>
        migrateStateSchema(database, {
          baselineVersion: 1,
          baselineIdentity: v1Identity,
          currentVersion: 2,
          currentSchemaSql: v2Sql,
          migrations: [
            {
              fromVersion: 1,
              toVersion: 2,
              name: "deny-internal-metadata-delete-on-expand-only",
              safety: STATE_SCHEMA_MIGRATION_SAFETY,
              fromIdentity: v1Identity,
              migrate: (connection) => {
                connection.exec(sql);
              },
            },
          ],
        }),
      ).toThrow(/not authorized/u);
    } finally {
      database.close();
    }
  });

  describe("real steps 76 -> 83 on an ANALYZE-populated production-mode database", () => {
    let dir: string | undefined;
    afterEach(async () => {
      if (dir !== undefined) await rm(dir, { recursive: true, force: true });
      dir = undefined;
    });

    const fixturePath = (name: string) =>
      fileURLToPath(new URL(`./fixtures/state-v13/${name}`, import.meta.url));

    const upTo76: StateSchemaMigrationPlan = {
      ...STATE_SCHEMA_MIGRATION_PLAN,
      currentVersion: 76,
      currentSchemaSql: STATE_SCHEMA_V76_SQL,
      migrations: STATE_SCHEMA_MIGRATIONS.filter((step) => step.toVersion <= 76).map((step) =>
        step.toVersion === 21
          ? { ...step, migrate: (db: StateSchemaMigrationDatabase) => migrateMachineNames(db, "macbook") }
          : step,
      ),
    };

    const allRows = (database: DatabaseSync, sql: string) =>
      database.prepare(sql).all() as unknown as ReadonlyArray<Record<string, SQLOutputValue>>;

    it.each(["command-center-v13.db", "remote-v13.db"])(
      "migrates %s from 76 -> 83 with WAL, trusted_schema=OFF, ANALYZE/optimize sqlite_stat1, sqlite_sequence, FTS5 and triggers active",
      async (fixtureName) => {
        dir = await mkdtemp(join(tmpdir(), "junto-migrate-76-83-analyze-"));
        const dbPath = join(dir, "junto.db");
        await copyFile(fixturePath(fixtureName), dbPath);
        const database = new DatabaseSync(dbPath, {
          open: true,
          readOnly: false,
          allowExtension: false,
          enableForeignKeyConstraints: true,
          enableDoubleQuotedStringLiterals: false,
          allowBareNamedParameters: false,
          allowUnknownNamedParameters: false,
        });
        try {
          database.exec(`
            PRAGMA foreign_keys = ON;
            PRAGMA trusted_schema = OFF;
          `);
          expect(migrateStateSchema(database, upTo76)).toMatchObject({
            schemaVersion: 76,
            ...STATE_SCHEMA_V76_IDENTITY,
          });
          // Match StateEngine's runtime WAL + synchronous configuration before populating stats.
          database.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
          `);

          // Seed rows across every table rebuilt or read by steps 76..83, plus
          // AUTOINCREMENT (sqlite_sequence) and FTS5 (harness_models_search).
          const signalA = "01M8S0000000000000000000A0";
          const signalB = "01M8S0000000000000000000B0";
          const threadId = "01M8T00000000000000000000A";
          const messageId = "01M8M00000000000000000000A";
          const seatId = "agent-01M8AAAAAAAAAAAAAAAAAAAAAA";
          database.exec(`
            INSERT INTO agent_signals(
              signal_id, canvas_name, node_id, kind, text, detail, source_json, created_at, state,
              response_text, response_at, closed_at, thread_id, message_id, follows_signal_id
            ) VALUES
              ('${signalA}', 'factory', '${seatId}', 'blocked', 'need token', '## context', NULL, 1, 'open', NULL, NULL, NULL, NULL, NULL, NULL),
              ('${signalB}', 'factory', '${seatId}', 'escalate', 'pick engine', NULL, NULL, 2, 'answered', 'sqlite', 5, 5, '${threadId}', '${messageId}', '${signalA}');
            INSERT INTO agent_signal_parts(signal_id, position, kind, body_json, caption)
              VALUES ('${signalA}', 0, 'link', '{"url":"https://example.com"}', 'receipt');
            INSERT INTO agent_signal_attachments(signal_id, position, sha256, byte_length, media_type, display_name, caption)
              VALUES ('${signalA}', 0, '${"a".repeat(64)}', 42, 'image/png', 'shot.png', NULL);
            INSERT INTO agent_signal_depends(signal_id, position, depends_on_signal_id)
              VALUES ('${signalA}', 0, '${signalB}');

            INSERT INTO seat_sessions(seat_id, session_id, harness, started_at, binding_id)
              VALUES ('seat-76-83', 'sess-76-83', 'claude', 100, 'bind-76-83');
            INSERT INTO seat_session_drains(seat_id, session_id, detached_at)
              VALUES ('seat-76-83', 'sess-76-83', 105);

            INSERT INTO overseer_live_sessions(
              session_id, seat_node_ref, occupant_generation, authority_epoch, status, created_at, updated_at
            ) VALUES (
              'live-sess-1', 'junto://canvas/factory?node=${seatId}', 'gen-1', 'epoch-1', 'active',
              '2026-11-25T00:00:00.000Z', '2026-11-25T00:00:00.000Z'
            );
            INSERT INTO overseer_live_events(session_id, kind, detail_json, created_at)
              VALUES ('live-sess-1', 'started', '{"ok":true}', '2026-11-25T00:00:00.000Z');

            INSERT INTO harness_scans(harness, fingerprint, version, source, scanned_at)
              VALUES ('codex', 'fp-1', '1.0.0', 'command', 200);
            INSERT INTO harness_models(harness, model, provider, label, description, position)
              VALUES ('codex', 'gpt-5-codex', 'openai', 'GPT 5 Codex', 'reasoning coding model', 0);

            INSERT INTO canvas_copies_sent(canvas_name, target, seq, sent_at)
              VALUES ('removed-before-83', 'mini-install', 1, '2026-11-20T00:00:00.000Z');
          `);
          const liveCanvas = database
            .prepare("SELECT canvas_name FROM canvases ORDER BY canvas_name LIMIT 1")
            .get() as { canvas_name: string } | undefined;
          if (liveCanvas !== undefined) {
            database
              .prepare("INSERT INTO canvas_copies_sent(canvas_name, target, seq, sent_at) VALUES (?, 'mini-install', 1, '2026-11-20T00:00:00.000Z')")
              .run(liveCanvas.canvas_name);
          }

          // Run the real maintenance-worker per-table ANALYZE + full ANALYZE + PRAGMA optimize.
          database.exec("PRAGMA analysis_limit = 1000");
          const analyzed = analyzeTables(database);
          expect(analyzed.analyzed).toBeGreaterThan(0);
          database.exec("ANALYZE");
          database.exec("PRAGMA optimize");

          const statTables = new Set(
            allRows(database, "SELECT DISTINCT tbl FROM sqlite_stat1").map((row) => String(row.tbl)),
          );
          expect(statTables.has("agent_signals")).toBe(true);
          expect(statTables.has("seat_sessions")).toBe(true);
          expect(
            allRows(database, "SELECT name, seq FROM sqlite_sequence WHERE name = 'overseer_live_events'"),
          ).toEqual([{ name: "overseer_live_events", seq: 1 }]);

          const triggersBefore = allRows(
            database,
            "SELECT name, tbl_name, sql FROM sqlite_schema WHERE type = 'trigger' AND name NOT GLOB 'sqlite_*' ORDER BY name",
          );
          expect(triggersBefore.length).toBeGreaterThan(0);

          // Execute the real 76 -> 83 chain in one transaction.
          const result = migrateStateSchema(database, STATE_SCHEMA_MIGRATION_PLAN);
          expect(result).toMatchObject({
            previousVersion: 76,
            schemaVersion: 83,
            ...STATE_SCHEMA_V83_IDENTITY,
          });

          // Foreign keys restored and clean; DB intact.
          expect(database.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
          expect(database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
          expect(database.prepare("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });

          // Step 77 rebuilt agent_signals without losing rows or FK children.
          const signalsAfter = allRows(database, "SELECT signal_id, state, withdrawn_at FROM agent_signals ORDER BY signal_id");
          expect(signalsAfter).toEqual([
            { signal_id: signalA, state: "open", withdrawn_at: null },
            { signal_id: signalB, state: "answered", withdrawn_at: null },
          ]);
          expect(allRows(database, `SELECT count(*) AS n FROM agent_signal_parts WHERE signal_id = '${signalA}'`)[0]!.n).toBe(1);
          expect(allRows(database, `SELECT count(*) AS n FROM agent_signal_attachments WHERE signal_id = '${signalA}'`)[0]!.n).toBe(1);
          expect(allRows(database, `SELECT count(*) AS n FROM agent_signal_depends WHERE signal_id = '${signalA}'`)[0]!.n).toBe(1);

          // Step 79 rebuilt seat_sessions without losing rows or draining children, and admits 'removed'.
          expect(allRows(database, "SELECT seat_id, session_id, end_reason FROM seat_sessions WHERE seat_id = 'seat-76-83'")).toEqual([
            { seat_id: "seat-76-83", session_id: "sess-76-83", end_reason: null },
          ]);
          expect(allRows(database, "SELECT seat_id, session_id, detached_at FROM seat_session_drains WHERE seat_id = 'seat-76-83'")).toEqual([
            { seat_id: "seat-76-83", session_id: "sess-76-83", detached_at: 105 },
          ]);
          database
            .prepare("UPDATE seat_sessions SET ended_at = 110, end_reason = 'removed' WHERE seat_id = 'seat-76-83'")
            .run();

          // Step 83 populated canvas_removed_earlier only for the gone canvas.
          expect(allRows(database, "SELECT canvas_name, target FROM canvas_removed_earlier ORDER BY canvas_name, target")).toEqual([
            { canvas_name: "removed-before-83", target: "mini-install" },
          ]);

          // AUTOINCREMENT sequence, FTS5 search, and all triggers survived intact.
          expect(
            allRows(database, "SELECT name, seq FROM sqlite_sequence WHERE name = 'overseer_live_events'"),
          ).toEqual([{ name: "overseer_live_events", seq: 1 }]);
          expect(
            allRows(database, "SELECT model FROM harness_models_search WHERE harness_models_search MATCH 'codex'"),
          ).toEqual([{ model: "gpt-5-codex" }]);
          expect(
            allRows(
              database,
              "SELECT name, tbl_name, sql FROM sqlite_schema WHERE type = 'trigger' AND name NOT GLOB 'sqlite_*' ORDER BY name",
            ),
          ).toEqual(triggersBefore);
          expect(() => database.exec("DELETE FROM work_events")).toThrow(/immutable/u);

          // Post-migration ANALYZE re-populates stats cleanly.
          database.exec("ANALYZE");
        } finally {
          database.close();
        }
      },
      60_000,
    );
  });

  it("rejects a database from a newer release without mutation", () => {
    const database = openDatabase();
    try {
      seedVersionOne(database, 3);
      const before = databaseWitness(database);
      expect(() =>
        migrateStateSchema(
          database,
          migrationPlan(() => undefined),
        )
      ).toThrow("newer than supported version 2");
      expect(databaseWitness(database)).toEqual(before);
    } finally {
      database.close();
    }
  });
});
