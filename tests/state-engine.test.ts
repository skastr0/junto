import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, ManagedRuntime } from "effect";
import { afterEach, describe, expect, test } from "vitest";
import {
  makeStateEngineLive,
  migrateLegacyStateDatabase,
  StateEngine,
  StateEngineError,
} from "../src/main/vellum/state/engine";
import { createVerifiedStateBackup } from "../src/main/vellum/state/backup";
import {
  STATE_SCHEMA_IDENTITY_SQL,
  STATE_SCHEMA_SQL,
  STATE_SCHEMA_V1_SQL,
} from "../src/main/vellum/state/schema";
import { CURRENT_STATE_SCHEMA_VERSION } from "../src/main/vellum/state/migrations";
import {
  RETIRED_SOURCE_SCHEMA_SHA256,
  verifyAndStampStateSchema,
} from "../src/main/vellum/state/schema-identity";
import { USAGE_STATE_SCHEMA_SQL } from "../src/main/vellum/usage/state-schema";
const makeTempDir = (prefix: string): Promise<string> =>
  mkdtemp(join(tmpdir(), prefix)).then((root) => {
    tempRoots.push(root);
    return root;
  });

const runtimes: Array<
  ManagedRuntime.ManagedRuntime<StateEngine, StateEngineError>
> = [];
const tempRoots: string[] = [];

const makeRuntime = (path: string) => {
  const runtime = ManagedRuntime.make(makeStateEngineLive(path));
  runtimes.push(runtime);
  return runtime;
};

const disposeRuntime = async (
  runtime: ManagedRuntime.ManagedRuntime<StateEngine, StateEngineError>,
): Promise<void> => {
  const index = runtimes.indexOf(runtime);
  if (index >= 0) runtimes.splice(index, 1);
  await runtime.dispose();
};

const seedCurrentStateSchema = async (path: string): Promise<void> => {
  const runtime = makeRuntime(path);
  await runtime.runPromise(StateEngine);
  await disposeRuntime(runtime);
};

const seedVersionOneStateSchema = (path: string, version = 1): void => {
  const database = new DatabaseSync(path);
  try {
    database.exec(STATE_SCHEMA_V1_SQL);
    verifyAndStampStateSchema(database, STATE_SCHEMA_V1_SQL);
    database.exec(`PRAGMA user_version = ${version}`);
  } finally {
    database.close();
  }
};

test("copies legacy Vellum Command state into the renamed home without deleting the source", async () => {
  const root = await makeTempDir("vellum-state-rename-");
  const legacyDir = join(root, ".vellum", "state");
  const targetDir = join(root, ".vellum-command", "state");
  await mkdir(legacyDir, { recursive: true });
  await mkdir(targetDir, { recursive: true });
  const legacyPath = join(legacyDir, "vellum.db");
  const targetPath = join(targetDir, "vellum.db");
  await writeFile(legacyPath, "legacy-db", { mode: 0o600 });
  await writeFile(`${legacyPath}-wal`, "legacy-wal", { mode: 0o600 });

  expect(migrateLegacyStateDatabase({ legacyPath, targetPath })).toBe(true);
  await expect(readFile(targetPath, "utf8")).resolves.toBe("legacy-db");
  await expect(readFile(`${targetPath}-wal`, "utf8")).resolves.toBe("legacy-wal");
  await expect(readFile(legacyPath, "utf8")).resolves.toBe("legacy-db");
  await expect(readFile(`${legacyPath}-wal`, "utf8")).resolves.toBe("legacy-wal");
  expect(migrateLegacyStateDatabase({ legacyPath, targetPath })).toBe(false);
});

const readAuthorityWitness = (path: string) => {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const journalMode = database
      .prepare("PRAGMA journal_mode")
      .get();
    const userVersion = database
      .prepare("PRAGMA user_version")
      .get();
    const schema = database
      .prepare(
        `
          SELECT type, name, tbl_name AS table_name, sql
          FROM sqlite_schema
          WHERE type IN ('table', 'index', 'view', 'trigger')
            AND name NOT GLOB 'sqlite_*'
          ORDER BY type COLLATE BINARY, name COLLATE BINARY
        `,
      )
      .all();
    const hasIdentityTable = database
      .prepare(
        `
          SELECT 1 AS present
          FROM sqlite_schema
          WHERE type = 'table'
            AND name = 'state_schema_identity'
        `,
      )
      .get() !== undefined;
    const identity = hasIdentityTable
      ? database
        .prepare(
          `
            SELECT
              singleton,
              actual_schema_sha256,
              source_schema_sha256,
              verified_at
            FROM state_schema_identity
            ORDER BY singleton
          `,
        )
        .all()
      : [];
    return { journalMode, userVersion, schema, identity };
  } finally {
    database.close();
  }
};

const expectSchemaRejectionWithoutMutation = async (
  path: string,
  error: RegExp,
): Promise<void> => {
  const before = readAuthorityWitness(path);
  const runtime = makeRuntime(path);
  try {
    await expect(runtime.runPromise(StateEngine)).rejects.toThrow(error);
  } finally {
    await disposeRuntime(runtime);
  }
  expect(readAuthorityWitness(path)).toEqual(before);
};

afterEach(async () => {
  while (runtimes.length > 0) {
    await runtimes.pop()!.dispose();
  }
  while (tempRoots.length > 0) {
    await rm(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe("StateEngine", () => {
  test("opens the sole database with exact schema identity and private SQLite settings", async () => {
    const root = await makeTempDir("vellum-state-engine-");
    const path = join(root, "state", "vellum.db");
    const runtime = makeRuntime(path);

    const info = await runtime.runPromise(
      Effect.map(StateEngine, (engine) => engine.info),
    );

    expect(info.path).toBe(path);
    expect(info.journalMode).toBe("wal");
    expect(info.synchronous).toBe(1);
    expect(info.foreignKeys).toBe(true);
    expect(info.schemaSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(info.schemaVersion).toBe(CURRENT_STATE_SCHEMA_VERSION);
    expect((await lstat(join(root, "state"))).mode & 0o777).toBe(0o700);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);

    const schemaIdentity = await runtime.runPromise(
      Effect.flatMap(StateEngine, (engine) =>
        engine.read("test.schema", (reader) => ({
          identity: reader.get<{
            singleton: number;
            actual_schema_sha256: string;
            source_schema_sha256: string;
          }>(
            `
                SELECT
                  singleton,
                  actual_schema_sha256,
                  source_schema_sha256
                FROM state_schema_identity
                WHERE singleton = 1
              `,
          ),
          userVersion: reader.get<{ user_version: number }>(
            "PRAGMA user_version",
          )?.user_version,
        }))
      ),
    );
    expect(schemaIdentity).toEqual({
      identity: {
        singleton: 1,
        actual_schema_sha256: info.schemaSha256,
        source_schema_sha256: RETIRED_SOURCE_SCHEMA_SHA256,
      },
      userVersion: CURRENT_STATE_SCHEMA_VERSION,
    });
  });

  test("treats SQLite-only implementation objects as a fresh authority schema", async () => {
    const root = await makeTempDir("vellum-state-sqlite-internal-");
    const path = join(root, "vellum.db");
    const sqliteOnly = new DatabaseSync(path);
    try {
      sqliteOnly.exec(`
        CREATE TABLE transient_sequence_owner (
          id INTEGER PRIMARY KEY AUTOINCREMENT
        );
        DROP TABLE transient_sequence_owner;
      `);
      expect(
        sqliteOnly
          .prepare(
            `
              SELECT name
              FROM sqlite_schema
              WHERE name GLOB 'sqlite_*'
            `,
          )
          .all(),
      ).toEqual([{ name: "sqlite_sequence" }]);
    } finally {
      sqliteOnly.close();
    }

    const runtime = makeRuntime(path);
    const info = await runtime.runPromise(
      Effect.map(StateEngine, (engine) => engine.info),
    );
    expect(info.schemaSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(readAuthorityWitness(path).schema).toContainEqual(
      expect.objectContaining({
        type: "table",
        name: "state_schema_identity",
      }),
    );
  });

  test("reopens idempotently without losing committed state", async () => {
    const root = await makeTempDir("vellum-state-reopen-");
    const path = join(root, "state", "vellum.db");
    const firstRuntime = makeRuntime(path);
    const firstEngine = await firstRuntime.runPromise(StateEngine);

    await firstRuntime.runPromise(
      firstEngine.transaction("test.persist", (writer) => {
        writer.run(
          `
            INSERT INTO factory_pause_canvases(
              canvas_name,
              playing,
              ever_played,
              updated_at
            ) VALUES (?, ?, ?, ?)
          `,
          ["reopen", 1, 1, "2026-07-27T00:00:00.000Z"],
        );
      }),
    );
    await disposeRuntime(firstRuntime);

    const secondRuntime = makeRuntime(path);
    const state = await secondRuntime.runPromise(
      Effect.flatMap(StateEngine, (engine) =>
        engine.read("test.reopen", (reader) => ({
          witness: reader.get<{
            playing: number;
            ever_played: number;
          }>(
            `
              SELECT playing, ever_played
              FROM factory_pause_canvases
              WHERE canvas_name = ?
            `,
            ["reopen"],
          ),
          identityRows: reader.get<{ count: number }>(
            "SELECT count(*) AS count FROM state_schema_identity",
          )?.count,
          integrity: reader.get<{ quick_check: string }>(
            "PRAGMA quick_check",
          )?.quick_check,
        }))
      ),
    );

    expect(state).toEqual({
      witness: { playing: 1, ever_played: 1 },
      identityRows: 1,
      integrity: "ok",
    });
  });

  test("adopts the exact unversioned baseline in place without losing state", async () => {
    const root = await makeTempDir("vellum-state-adopt-v1-");
    const path = join(root, "vellum.db");
    seedVersionOneStateSchema(path, 0);
    const unversioned = new DatabaseSync(path);
    try {
      unversioned
        .prepare(
          `
            INSERT INTO factory_pause_canvases(
              canvas_name,
              playing,
              ever_played,
              updated_at
            ) VALUES (?, ?, ?, ?)
          `,
        )
        .run(
          "adopted",
          1,
          1,
          "2026-07-28T00:00:00.000Z",
        );
    } finally {
      unversioned.close();
    }

    const runtime = makeRuntime(path);
    const engine = await runtime.runPromise(StateEngine);
    expect(engine.info.schemaVersion).toBe(CURRENT_STATE_SCHEMA_VERSION);
    expect(
      await runtime.runPromise(
        engine.read("test.adopt-v1", (reader) => ({
          userVersion: reader.get<{ user_version: number }>(
            "PRAGMA user_version",
          )?.user_version,
          row: reader.get<{
            playing: number;
            ever_played: number;
          }>(
            `
              SELECT playing, ever_played
              FROM factory_pause_canvases
              WHERE canvas_name = ?
            `,
            ["adopted"],
          ),
        })),
      ),
    ).toEqual({
      userVersion: CURRENT_STATE_SCHEMA_VERSION,
      row: { playing: 1, ever_played: 1 },
    });

    const backups = await readdir(join(root, "backups"));
    expect(backups).toHaveLength(1);
    const backupPath = join(root, "backups", backups[0]!);
    const backup = new DatabaseSync(backupPath, {
      readOnly: true,
      enableForeignKeyConstraints: true,
    });
    try {
      expect(backup.prepare("PRAGMA user_version").get()).toEqual({
        user_version: 0,
      });
      expect(
        backup
          .prepare(
            `
              SELECT playing, ever_played
              FROM factory_pause_canvases
              WHERE canvas_name = ?
            `,
          )
          .get("adopted"),
      ).toEqual({ playing: 1, ever_played: 1 });
      expect(backup.prepare("PRAGMA quick_check").get()).toEqual({
        quick_check: "ok",
      });
      expect(backup.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      backup.close();
    }
  });

  test("does not create a backup for fresh initialization or exact-current reopen", async () => {
    const root = await makeTempDir("vellum-state-no-startup-backup-");
    const path = join(root, "vellum.db");
    const fresh = makeRuntime(path);
    await fresh.runPromise(StateEngine);
    await disposeRuntime(fresh);
    await expect(readdir(join(root, "backups"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const reopened = makeRuntime(path);
    await reopened.runPromise(StateEngine);
    await disposeRuntime(reopened);
    await expect(readdir(join(root, "backups"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("aborts an installed schema advance before live mutation when backup verification cannot start", async () => {
    const root = await makeTempDir("vellum-state-migration-backup-failure-");
    const path = join(root, "vellum.db");
    seedVersionOneStateSchema(path);
    const external = join(root, "external");
    await mkdir(external, { mode: 0o755 });
    await symlink(external, join(root, "backups"));

    const runtime = makeRuntime(path);
    try {
      await expect(runtime.runPromise(StateEngine)).rejects.toThrow(
        "state backup path is not a real directory",
      );
    } finally {
      await disposeRuntime(runtime);
    }

    const after = new DatabaseSync(path, { readOnly: true });
    try {
      expect(after.prepare("PRAGMA user_version").get()).toEqual({
        user_version: 1,
      });
    } finally {
      after.close();
    }
    expect(await readdir(external)).toEqual([]);
  });

  test("commits a complete transaction and rolls every write back on failure", async () => {
    const root = await makeTempDir("vellum-state-transaction-");
    const runtime = makeRuntime(join(root, "vellum.db"));
    const engine = await runtime.runPromise(StateEngine);

    await runtime.runPromise(
      engine.transaction("test.create", (writer) => {
        writer.run(
          `
            INSERT INTO kernel_armed_regions(
              canvas_name,
              region_id,
              armed_at
            ) VALUES (?, ?, ?)
          `,
          ["transaction", "kept", "2026-07-27T00:00:00.000Z"],
        );
      }),
    );

    const failed = await runtime.runPromise(
      Effect.result(
        engine.transaction("test.rollback", (writer) => {
          writer.run(
            `
              INSERT INTO kernel_armed_regions(
                canvas_name,
                region_id,
                armed_at
              ) VALUES (?, ?, ?)
            `,
            ["transaction", "lost", "2026-07-27T00:01:00.000Z"],
          );
          throw new Error("stop");
        }),
      ),
    );
    expect(failed._tag).toBe("Failure");

    await runtime.runPromise(
      engine.transaction("test.after-rollback", (writer) => {
        writer.run(
          `
            INSERT INTO kernel_armed_regions(
              canvas_name,
              region_id,
              armed_at
            ) VALUES (?, ?, ?)
          `,
          ["transaction", "recovered", "2026-07-27T00:02:00.000Z"],
        );
      }),
    );

    const rows = await runtime.runPromise(
      engine.read("test.rows", (reader) =>
        reader.all<{ region_id: string }>(
          `
            SELECT region_id
            FROM kernel_armed_regions
            WHERE canvas_name = ?
            ORDER BY region_id
          `,
          ["transaction"],
        )
      ),
    );
    expect(rows).toEqual([
      { region_id: "kept" },
      { region_id: "recovered" },
    ]);
  });

  test("writes large resumable work in bounded chunks and preserves every row", async () => {
    const root = await makeTempDir("vellum-state-chunks-");
    const runtime = makeRuntime(join(root, "vellum.db"));
    const engine = await runtime.runPromise(StateEngine);
    const values = Array.from({ length: 17 }, (_, index) => index + 1);
    const chunks: number[] = [];
    await runtime.runPromise(
      engine.chunkedWrite(
        "test.bulk",
        values,
        (writer, chunk) => {
          chunks.push(chunk.length);
          for (const value of chunk) {
            writer.run(
              `
                INSERT INTO kernel_armed_regions(
                  canvas_name,
                  region_id,
                  armed_at
                ) VALUES (?, ?, ?)
              `,
              [
                "chunks",
                `region-${value.toString().padStart(2, "0")}`,
                "2026-07-27T00:00:00.000Z",
              ],
            );
          }
        },
        { chunkRows: 4 },
      ),
    );

    expect(chunks).toEqual([4, 4, 4, 4, 1]);
    const count = await runtime.runPromise(
      engine.read("test.count", (reader) =>
        reader.get<{ count: number }>(
          `
            SELECT count(*) AS count
            FROM kernel_armed_regions
            WHERE canvas_name = ?
          `,
          ["chunks"],
        )?.count
      ),
    );
    expect(count).toBe(17);
  });

  test("VACUUM INTO captures WAL commits in fresh engine-owned backup files", async () => {
    const root = await makeTempDir("vellum-state-backup-");
    const livePath = join(root, "live", "vellum.db");
    const runtime = makeRuntime(livePath);
    const engine = await runtime.runPromise(StateEngine);
    await runtime.runPromise(
      engine.transaction("test.seed", (writer) => {
        writer.run(
          `
            INSERT INTO factory_pause_canvases(
              canvas_name,
              playing,
              ever_played,
              updated_at
            ) VALUES (?, ?, ?, ?)
          `,
          ["backup", 1, 1, "2026-07-27T00:00:00.000Z"],
        );
        writer.run(
          `
            INSERT INTO factory_pause_scopes(
              canvas_name,
              scope_kind,
              scope_id,
              paused_at
            ) VALUES (?, ?, ?, ?)
          `,
          ["backup", "node", "receipt", "2026-07-27T00:01:00.000Z"],
        );
      }),
    );

    expect(engine.info.journalMode).toBe("wal");
    const wal = await lstat(`${livePath}-wal`);
    const shm = await lstat(`${livePath}-shm`);
    expect(wal.isFile()).toBe(true);
    expect(wal.size).toBeGreaterThan(0);
    expect(wal.mode & 0o777).toBe(0o600);
    expect(shm.isFile()).toBe(true);
    expect(shm.mode & 0o777).toBe(0o600);

    const firstReceipt = await runtime.runPromise(engine.backup());
    const backupPath = firstReceipt.path;
    expect(firstReceipt.schemaSha256).toBe(engine.info.schemaSha256);
    expect(firstReceipt.schemaVersion).toBe(engine.info.schemaVersion);
    expect(dirname(backupPath)).toBe(join(root, "live", "backups"));
    expect(basename(backupPath)).toMatch(
      /^vellum-backup-[a-f0-9-]{36}\.db$/u,
    );
    expect((await lstat(join(root, "live", "backups"))).mode & 0o777).toBe(
      0o700,
    );
    expect((await lstat(backupPath)).mode & 0o777).toBe(0o600);

    const backup = new DatabaseSync(backupPath, {
      readOnly: true,
      enableForeignKeyConstraints: true,
    });
    try {
      expect(
        backup.prepare(`
          SELECT actual_schema_sha256
          FROM state_schema_identity
          WHERE singleton = 1
        `).get(),
      ).toEqual({ actual_schema_sha256: engine.info.schemaSha256 });
      expect(
        backup.prepare(
          `
            SELECT canvas_name, scope_kind
            FROM factory_pause_scopes
            WHERE scope_id = ?
          `,
        ).get("receipt"),
      ).toEqual({ canvas_name: "backup", scope_kind: "node" });
      expect(backup.prepare("PRAGMA quick_check").get()).toEqual({
        quick_check: "ok",
      });
      expect(backup.prepare("PRAGMA foreign_keys").get()).toEqual({
        foreign_keys: 1,
      });
      expect(backup.prepare("PRAGMA user_version").get()).toEqual({
        user_version: CURRENT_STATE_SCHEMA_VERSION,
      });
      expect(backup.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      backup.close();
    }

    const firstBytes = await readFile(backupPath);
    const secondReceipt = await runtime.runPromise(engine.backup());
    expect(secondReceipt.path).not.toBe(backupPath);
    expect(await readFile(backupPath)).toEqual(firstBytes);
    expect((await lstat(secondReceipt.path)).mode & 0o777).toBe(0o600);
  });

  test("failed backup verification removes only the newly minted invalid file", async () => {
    const root = await makeTempDir("vellum-state-backup-failure-cleanup-");
    const stateDirectory = join(root, "state");
    await mkdir(stateDirectory);
    const database = new DatabaseSync(join(stateDirectory, "vellum.db"));
    try {
      database.exec(`
        PRAGMA foreign_keys = OFF;
        ${STATE_SCHEMA_IDENTITY_SQL}
        CREATE TABLE parent (id TEXT PRIMARY KEY) STRICT;
        CREATE TABLE child (
          id TEXT PRIMARY KEY,
          parent_id TEXT NOT NULL REFERENCES parent(id)
        ) STRICT;
        INSERT INTO state_schema_identity(
          singleton,
          actual_schema_sha256,
          source_schema_sha256,
          verified_at
        ) VALUES (
          1,
          '${"a".repeat(64)}',
          '${"b".repeat(64)}',
          '2026-07-28T00:00:00.000Z'
        );
        INSERT INTO child(id, parent_id) VALUES ('orphan', 'missing');
        PRAGMA user_version = 1;
      `);

      expect(() =>
        createVerifiedStateBackup(database, stateDirectory)
      ).toThrow(/foreign-key violation/u);
      expect(await readdir(join(stateDirectory, "backups"))).toEqual([]);
    } finally {
      database.close();
    }
  });

  test("caller input cannot redirect backup writes or chmod a shared directory", async () => {
    const root = await makeTempDir("vellum-state-backup-authority-");
    const shared = join(root, "shared");
    await mkdir(shared, { mode: 0o755 });
    await chmod(shared, 0o755);
    const forgedPath = join(shared, "forged.db");
    const runtime = makeRuntime(join(root, "owned", "vellum.db"));
    const engine = await runtime.runPromise(StateEngine);

    const forgedBackup = engine.backup as unknown as (
      ignoredDestination: string,
    ) => ReturnType<typeof engine.backup>;
    const receipt = await runtime.runPromise(forgedBackup(forgedPath));

    expect((await lstat(shared)).mode & 0o777).toBe(0o755);
    expect(await readdir(shared)).toEqual([]);
    expect(dirname(receipt.path)).toBe(join(root, "owned", "backups"));
    expect((await lstat(receipt.path)).mode & 0o777).toBe(0o600);
  });

  test("rejects a symlinked backup directory without touching its target", async () => {
    const root = await makeTempDir("vellum-state-backup-symlink-");
    const stateDirectory = join(root, "state");
    const external = join(root, "external");
    await mkdir(external, { mode: 0o755 });
    await chmod(external, 0o755);
    const runtime = makeRuntime(join(stateDirectory, "vellum.db"));
    const engine = await runtime.runPromise(StateEngine);
    await symlink(external, join(stateDirectory, "backups"));

    const result = await runtime.runPromise(Effect.result(engine.backup()));

    expect(result._tag).toBe("Failure");
    expect((await lstat(external)).mode & 0o777).toBe(0o755);
    expect(await readdir(external)).toEqual([]);
  });

  test("rejects an unknown schema object before committing current DDL", async () => {
    const root = await makeTempDir("vellum-state-unknown-schema-");
    const path = join(root, "vellum.db");
    const drifted = new DatabaseSync(path);
    try {
      drifted.exec("CREATE TABLE unexpected_state (value TEXT) STRICT");
    } finally {
      drifted.close();
    }

    const runtime = makeRuntime(path);
    await expect(runtime.runPromise(StateEngine)).rejects.toThrow(
      "state schema identity table is missing",
    );

    const after = new DatabaseSync(path, { readOnly: true });
    try {
      expect(
        after.prepare(
          `
            SELECT name
            FROM sqlite_schema
            WHERE type = 'table'
            ORDER BY name
          `,
        ).all(),
      ).toEqual([{ name: "unexpected_state" }]);
    } finally {
      after.close();
    }
  });

  test("rejects a newer database without persisting WAL or other mutations", async () => {
    const root = await makeTempDir("vellum-state-newer-version-");
    const path = join(root, "vellum.db");
    await seedCurrentStateSchema(path);

    const newer = new DatabaseSync(path);
    try {
      newer.exec(`
        PRAGMA journal_mode = DELETE;
        PRAGMA user_version = ${CURRENT_STATE_SCHEMA_VERSION + 1};
      `);
    } finally {
      newer.close();
    }

    await expectSchemaRejectionWithoutMutation(
      path,
      /newer than supported version/,
    );
  });

  test("rejects a current database missing a table without repairing it", async () => {
    const root = await makeTempDir("vellum-state-missing-table-");
    const path = join(root, "vellum.db");
    await seedCurrentStateSchema(path);

    const drifted = new DatabaseSync(path);
    try {
      drifted.exec("DROP TABLE usage_state");
    } finally {
      drifted.close();
    }

    await expectSchemaRejectionWithoutMutation(
      path,
      /state schema identity mismatch.*missing=table:usage_state/,
    );
  });

  test("rejects a current database missing an index without repairing it", async () => {
    const root = await makeTempDir("vellum-state-missing-index-");
    const path = join(root, "vellum.db");
    await seedCurrentStateSchema(path);

    const drifted = new DatabaseSync(path);
    try {
      drifted.exec("DROP INDEX work_tasks_node");
    } finally {
      drifted.close();
    }

    await expectSchemaRejectionWithoutMutation(
      path,
      /state schema identity mismatch.*missing=index:work_tasks_node/,
    );
  });

  test("rejects a current database missing a trigger without repairing it", async () => {
    const root = await makeTempDir("vellum-state-missing-trigger-");
    const path = join(root, "vellum.db");
    await seedCurrentStateSchema(path);

    const drifted = new DatabaseSync(path);
    try {
      drifted.exec("DROP TRIGGER host_registry_retain_local");
    } finally {
      drifted.close();
    }

    await expectSchemaRejectionWithoutMutation(
      path,
      /state schema identity mismatch.*missing=trigger:host_registry_retain_local/,
    );
  });

  test("rejects a current table missing constraints without replacing it", async () => {
    const root = await makeTempDir("vellum-state-shape-drift-");
    const path = join(root, "vellum.db");
    await seedCurrentStateSchema(path);

    const drifted = new DatabaseSync(path);
    try {
      drifted.exec(`
        DROP TABLE usage_state;

        CREATE TABLE usage_state (
          singleton INTEGER PRIMARY KEY,
          snapshots_json TEXT NOT NULL,
          last_live_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
      `);
    } finally {
      drifted.close();
    }

    await expectSchemaRejectionWithoutMutation(
      path,
      /state schema identity mismatch.*changed=table:usage_state/,
    );
  });

  test("rejects a partial current database without completing or stamping it", async () => {
    const root = await makeTempDir("vellum-state-partial-schema-");
    const path = join(root, "vellum.db");
    const partial = new DatabaseSync(path);
    try {
      partial.exec(`
        ${STATE_SCHEMA_IDENTITY_SQL}
        ${USAGE_STATE_SCHEMA_SQL}
      `);
      partial
        .prepare(
          `
            INSERT INTO state_schema_identity(
              singleton,
              actual_schema_sha256,
              source_schema_sha256,
              verified_at
            ) VALUES (1, ?, ?, ?)
          `,
        )
        .run(
          "0".repeat(64),
          "1".repeat(64),
          "partial-witness",
        );
    } finally {
      partial.close();
    }

    await expectSchemaRejectionWithoutMutation(
      path,
      /state schema changed after its recorded identity was stamped/,
    );
  });

  test("fails closed on a corrupt pre-existing database", async () => {
    const root = await makeTempDir("vellum-state-path-");
    const fakeDatabase = join(root, "vellum.db");
    await writeFile(fakeDatabase, "not sqlite");
    const bytes = await readFile(fakeDatabase);
    expect(bytes.byteLength).toBeGreaterThan(0);

    const runtime = makeRuntime(fakeDatabase);
    await expect(runtime.runPromise(StateEngine)).rejects.toThrow(
      "file is not a database",
    );
    expect(await readFile(fakeDatabase, "utf8")).toBe("not sqlite");
  });

  test("refuses a symlinked database without touching its target", async () => {
    const root = await makeTempDir("vellum-state-symlink-");
    const target = join(root, "operator-file");
    const databasePath = join(root, "vellum.db");
    await writeFile(target, "keep");
    await symlink(target, databasePath);

    const runtime = makeRuntime(databasePath);
    await expect(runtime.runPromise(StateEngine)).rejects.toThrow(
      "state database is not a regular file",
    );
    expect(await readFile(target, "utf8")).toBe("keep");
  });

  test("refuses a dangling database symlink without creating its target", async () => {
    const root = await makeTempDir("vellum-state-dangling-symlink-");
    const target = join(root, "operator-file");
    const databasePath = join(root, "vellum.db");
    await symlink(target, databasePath);

    const runtime = makeRuntime(databasePath);
    await expect(runtime.runPromise(StateEngine)).rejects.toThrow(
      "state database is not a regular file",
    );
    expect(await readdir(root)).toEqual(["vellum.db"]);
  });

  test("refuses a symlinked state directory without creating a database", async () => {
    const root = await makeTempDir("vellum-state-root-symlink-");
    const target = join(root, "operator-directory");
    const linkedState = join(root, "state");
    await mkdir(target, { mode: 0o755 });
    await symlink(target, linkedState);

    const runtime = makeRuntime(join(linkedState, "vellum.db"));
    await expect(runtime.runPromise(StateEngine)).rejects.toThrow(
      "state path is not a real directory",
    );
    expect(await readdir(target)).toEqual([]);
    expect((await lstat(target)).mode & 0o777).toBe(0o755);
  });

  test("closes the captured service when its scoped runtime is disposed", async () => {
    const root = await makeTempDir("vellum-state-disposal-");
    const runtime = makeRuntime(join(root, "vellum.db"));
    const engine = await runtime.runPromise(StateEngine);
    await disposeRuntime(runtime);

    const result = await Effect.runPromise(
      Effect.result(
        engine.read("test.closed", (reader) =>
          reader.get(
            "SELECT actual_schema_sha256 FROM state_schema_identity WHERE singleton = 1",
          )
        ),
      ),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toMatchObject({
        _tag: "StateEngineError",
        operation: "test.closed",
        message: "state engine is closed",
      });
    }
  });
});
