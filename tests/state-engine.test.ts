import { createHash } from "node:crypto";
import {
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
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, ManagedRuntime } from "effect";
import { afterEach, describe, expect, test } from "vitest";
import {
  makeStateEngineLive,
  StateEngine,
  StateEngineError,
} from "../src/main/vellum/state/engine";
import { STATE_SCHEMA_SQL } from "../src/main/vellum/state/schema";
const makeTempDir = (prefix: string): Promise<string> =>
  mkdtemp(join(tmpdir(), prefix)).then((root) => {
    tempRoots.push(root);
    return root;
  });

const runtimes: Array<
  ManagedRuntime.ManagedRuntime<StateEngine, StateEngineError>
> = [];
const tempRoots: string[] = [];

const PRE_POLICY_SCHEDULER_SCHEMA_SQL = `
  CREATE TABLE scheduler_interval_state (
    home_station TEXT NOT NULL
      CHECK (
        length(home_station) BETWEEN 1 AND 64
        AND substr(home_station, 1, 1) <> '-'
        AND home_station GLOB '[A-Za-z0-9]*'
        AND home_station NOT GLOB '*[^A-Za-z0-9._-]*'
      ),
    timer_key TEXT NOT NULL CHECK (length(timer_key) BETWEEN 1 AND 512),
    schedule_id TEXT NOT NULL CHECK (length(schedule_id) BETWEEN 1 AND 256),
    interval_milliseconds INTEGER NOT NULL
      CHECK (interval_milliseconds > 0),
    next_due_at_epoch_ms INTEGER NOT NULL
      CHECK (next_due_at_epoch_ms >= 0),
    next_due_slot TEXT NOT NULL
      CHECK (
        length(next_due_slot) > 0
        AND next_due_slot NOT GLOB '*[^0-9]*'
        AND (
          next_due_slot = '0'
          OR substr(next_due_slot, 1, 1) <> '0'
        )
      ),
    last_fired_slot TEXT
      CHECK (
        last_fired_slot IS NULL
        OR (
          length(last_fired_slot) > 0
          AND last_fired_slot NOT GLOB '*[^0-9]*'
          AND (
            last_fired_slot = '0'
            OR substr(last_fired_slot, 1, 1) <> '0'
          )
        )
      ),
    updated_at TEXT NOT NULL CHECK (length(updated_at) BETWEEN 1 AND 64),
    PRIMARY KEY (home_station, timer_key)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE scheduler_interval_firings (
    home_station TEXT NOT NULL
      CHECK (length(home_station) BETWEEN 1 AND 64),
    timer_key TEXT NOT NULL CHECK (length(timer_key) BETWEEN 1 AND 512),
    schedule_id TEXT NOT NULL CHECK (length(schedule_id) BETWEEN 1 AND 256),
    claim_slot TEXT NOT NULL
      CHECK (
        length(claim_slot) > 0
        AND claim_slot NOT GLOB '*[^0-9]*'
        AND (
          claim_slot = '0'
          OR substr(claim_slot, 1, 1) <> '0'
        )
      ),
    due_slot TEXT NOT NULL
      CHECK (
        length(due_slot) > 0
        AND due_slot NOT GLOB '*[^0-9]*'
        AND (
          due_slot = '0'
          OR substr(due_slot, 1, 1) <> '0'
        )
      ),
    scheduled_for_epoch_ms INTEGER NOT NULL
      CHECK (scheduled_for_epoch_ms >= 0),
    observed_at_epoch_ms INTEGER NOT NULL
      CHECK (observed_at_epoch_ms >= 0),
    coalesced_missed_slots TEXT NOT NULL
      CHECK (
        length(coalesced_missed_slots) > 0
        AND coalesced_missed_slots NOT GLOB '*[^0-9]*'
        AND (
          coalesced_missed_slots = '0'
          OR substr(coalesced_missed_slots, 1, 1) <> '0'
        )
      ),
    claimed_at TEXT NOT NULL CHECK (length(claimed_at) BETWEEN 1 AND 64),
    PRIMARY KEY (
      home_station,
      timer_key,
      schedule_id,
      claim_slot
    )
  ) STRICT, WITHOUT ROWID;

  CREATE INDEX scheduler_interval_due
    ON scheduler_interval_state(
      home_station,
      next_due_at_epoch_ms,
      timer_key
    );
`;

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
    expect((await lstat(join(root, "state"))).mode & 0o777).toBe(0o700);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);

    const schemaIdentity = await runtime.runPromise(
      Effect.flatMap(StateEngine, (engine) =>
        engine.read("test.schema", (reader) =>
          reader.get<{
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
          )
        )
      ),
    );
    expect(schemaIdentity).toEqual({
      singleton: 1,
      actual_schema_sha256: info.schemaSha256,
      source_schema_sha256: createHash("sha256")
        .update(STATE_SCHEMA_SQL)
        .digest("hex"),
    });
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

  test("replaces the obsolete scheduler shape once and preserves current cursors on reopen", async () => {
    const root = await makeTempDir("vellum-state-scheduler-cutover-");
    const path = join(root, "vellum.db");
    const obsolete = new DatabaseSync(path);
    try {
      obsolete.exec(PRE_POLICY_SCHEDULER_SCHEMA_SQL);
      obsolete.exec(`
        CREATE TABLE state_metadata (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        ) STRICT;
        INSERT INTO state_metadata(key, value, updated_at)
        VALUES ('schema', 'retired', '2026-07-27T00:00:00.000Z');
        INSERT INTO scheduler_interval_state(
          home_station,
          timer_key,
          schedule_id,
          interval_milliseconds,
          next_due_at_epoch_ms,
          next_due_slot,
          last_fired_slot,
          updated_at
        ) VALUES (
          'mini',
          'factory::timer',
          'obsolete-schedule',
          60000,
          1060000,
          '0',
          NULL,
          '2026-07-27T00:00:00.000Z'
        );
        INSERT INTO scheduler_interval_firings(
          home_station,
          timer_key,
          schedule_id,
          claim_slot,
          due_slot,
          scheduled_for_epoch_ms,
          observed_at_epoch_ms,
          coalesced_missed_slots,
          claimed_at
        ) VALUES (
          'mini',
          'factory::timer',
          'obsolete-schedule',
          '0',
          '0',
          1060000,
          1060000,
          '0',
          '2026-07-27T00:01:00.000Z'
        );
      `);
    } finally {
      obsolete.close();
    }

    const firstRuntime = makeRuntime(path);
    const firstEngine = await firstRuntime.runPromise(StateEngine);
    const consolidated = await firstRuntime.runPromise(
      firstEngine.read("test.scheduler-cutover", (reader) => ({
        stateColumns: reader
          .all<{ name: string }>(
            "PRAGMA table_info(scheduler_interval_state)",
          )
          .map(({ name }) => name),
        firingColumns: reader
          .all<{ name: string }>(
            "PRAGMA table_info(scheduler_interval_firings)",
          )
          .map(({ name }) => name),
        stateRows: reader.get<{ count: number }>(
          "SELECT count(*) AS count FROM scheduler_interval_state",
        )?.count,
        firingRows: reader.get<{ count: number }>(
          "SELECT count(*) AS count FROM scheduler_interval_firings",
        )?.count,
        retiredMetadataTables: reader.get<{ count: number }>(
          `
            SELECT count(*) AS count
            FROM sqlite_schema
            WHERE type = 'table' AND name = 'state_metadata'
          `,
        )?.count,
      })),
    );
    expect(consolidated.stateColumns).toContain("catch_up_policy");
    expect(consolidated.firingColumns).toContain("catch_up_policy");
    expect(consolidated).toMatchObject({
      stateRows: 0,
      firingRows: 0,
      retiredMetadataTables: 0,
    });

    await firstRuntime.runPromise(
      firstEngine.transaction("test.seed-current-scheduler", (writer) => {
        writer.run(
          `
            INSERT INTO scheduler_interval_state(
              home_station,
              timer_key,
              schedule_id,
              interval_milliseconds,
              catch_up_policy,
              next_due_at_epoch_ms,
              next_due_slot,
              last_fired_slot,
              updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            "mini",
            "factory::timer",
            "current-schedule",
            60_000,
            "coalesce-latest",
            1_120_000,
            "1",
            "0",
            "2026-07-27T00:02:00.000Z",
          ],
        );
      }),
    );
    await disposeRuntime(firstRuntime);

    const secondRuntime = makeRuntime(path);
    const persisted = await secondRuntime.runPromise(
      Effect.flatMap(StateEngine, (engine) =>
        engine.read("test.scheduler-current-reopen", (reader) =>
          reader.get<{
            schedule_id: string;
            catch_up_policy: string;
            next_due_slot: string;
          }>(
            `
              SELECT schedule_id, catch_up_policy, next_due_slot
              FROM scheduler_interval_state
              WHERE home_station = ? AND timer_key = ?
            `,
            ["mini", "factory::timer"],
          )
        )
      ),
    );
    expect(persisted).toEqual({
      schedule_id: "current-schedule",
      catch_up_policy: "coalesce-latest",
      next_due_slot: "1",
    });
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
      Effect.either(
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
    expect(failed._tag).toBe("Left");

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

  test("VACUUM INTO captures WAL commits, passes integrity checks, and refuses overwrite", async () => {
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

    const backupPath = join(root, "backups", "vellum.db");
    await runtime.runPromise(engine.backup(backupPath));
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
      expect(backup.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    } finally {
      backup.close();
    }

    const beforeRefusal = await readFile(backupPath);
    const second = await runtime.runPromise(
      Effect.either(engine.backup(backupPath)),
    );
    expect(second._tag).toBe("Left");
    expect(await readFile(backupPath)).toEqual(beforeRefusal);
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
      /state schema identity mismatch.*unexpected=table:unexpected_state/,
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

  test("rejects a current table name with a stale constrained shape", async () => {
    const root = await makeTempDir("vellum-state-shape-drift-");
    const path = join(root, "vellum.db");
    const drifted = new DatabaseSync(path);
    try {
      drifted.exec(`
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

    const runtime = makeRuntime(path);
    await expect(runtime.runPromise(StateEngine)).rejects.toThrow(
      /state schema identity mismatch.*changed=table:usage_state/,
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
      Effect.either(
        engine.read("test.closed", (reader) =>
          reader.get(
            "SELECT actual_schema_sha256 FROM state_schema_identity WHERE singleton = 1",
          )
        ),
      ),
    );

    expect(result._tag).toBe("Left");
    if (result._tag === "Left") {
      expect(result.left).toMatchObject({
        _tag: "StateEngineError",
        operation: "test.closed",
        message: "state engine is closed",
      });
    }
  });
});
