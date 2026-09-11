import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  STATE_SCHEMA_MIGRATION_SAFETY,
  STATE_SCHEMA_V1_IDENTITY,
  STATE_SCHEMA_V2_IDENTITY,
  migrateStateSchema,
  validateStateSchemaMigrationPlan,
  type StateSchemaMigrationPlan,
} from "../src/main/vellum-command/state/migrations";
import {
  STATE_SCHEMA_IDENTITY_SQL,
  STATE_SCHEMA_SQL,
  STATE_SCHEMA_V1_SQL,
  STATE_SCHEMA_V2_SQL,
} from "../src/main/vellum-command/state/schema";
import {
  expectedStateSchemaIdentity,
  verifyAndStampStateSchema,
} from "../src/main/vellum-command/state/schema-identity";

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
  it("freezes the exact version-one schema witness", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V1_SQL)).toEqual(
      STATE_SCHEMA_V1_IDENTITY,
    );
  });

  it("freezes the exact version-two schema witness", () => {
    expect(expectedStateSchemaIdentity(STATE_SCHEMA_V2_SQL)).toEqual(
      STATE_SCHEMA_V2_IDENTITY,
    );
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
        /state schema changed after its recorded identity was stamped|not a recognized Vellum Command schema/,
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
