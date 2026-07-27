import { lstat, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
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
const makeTempDir = (prefix: string): Promise<string> =>
  mkdtemp(join(tmpdir(), prefix));

const runtimes: Array<
  ManagedRuntime.ManagedRuntime<StateEngine, StateEngineError>
> = [];

const makeRuntime = (path: string) => {
  const runtime = ManagedRuntime.make(makeStateEngineLive(path));
  runtimes.push(runtime);
  return runtime;
};

afterEach(async () => {
  while (runtimes.length > 0) {
    await runtimes.pop()!.dispose();
  }
});

describe("StateEngine", () => {
  test("opens the sole database with WAL, NORMAL sync, foreign keys, and private permissions", async () => {
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

    const schema = await runtime.runPromise(
      Effect.flatMap(StateEngine, (engine) =>
        engine.read("test.schema", (reader) =>
          reader.get<{ value: string }>(
            "SELECT value FROM state_metadata WHERE key = ?",
            ["schema"],
          )?.value
        )
      ),
    );
    expect(schema).toBe("vellum/state/v1");
  });

  test("commits a complete transaction and rolls every write back on failure", async () => {
    const root = await makeTempDir("vellum-state-transaction-");
    const runtime = makeRuntime(join(root, "vellum.db"));
    const engine = await runtime.runPromise(StateEngine);

    await runtime.runPromise(
      engine.transaction("test.create", (writer) => {
        writer.run(
          "CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT",
        );
        writer.run("INSERT INTO records(id, value) VALUES (?, ?)", [1, "kept"]);
      }),
    );

    const failed = await runtime.runPromise(
      Effect.either(
        engine.transaction("test.rollback", (writer) => {
          writer.run("INSERT INTO records(id, value) VALUES (?, ?)", [2, "lost"]);
          throw new Error("stop");
        }),
      ),
    );
    expect(failed._tag).toBe("Left");

    const rows = await runtime.runPromise(
      engine.read("test.rows", (reader) =>
        reader.all<{ id: number; value: string }>(
          "SELECT id, value FROM records ORDER BY id",
        )
      ),
    );
    expect(rows).toEqual([{ id: 1, value: "kept" }]);
  });

  test("writes large resumable work in bounded chunks and preserves every row", async () => {
    const root = await makeTempDir("vellum-state-chunks-");
    const runtime = makeRuntime(join(root, "vellum.db"));
    const engine = await runtime.runPromise(StateEngine);
    await runtime.runPromise(
      engine.transaction("test.create", (writer) => {
        writer.run("CREATE TABLE rows (id INTEGER PRIMARY KEY) STRICT");
      }),
    );

    const values = Array.from({ length: 17 }, (_, index) => index + 1);
    const chunks: number[] = [];
    await runtime.runPromise(
      engine.chunkedWrite(
        "test.bulk",
        values,
        (writer, chunk) => {
          chunks.push(chunk.length);
          for (const value of chunk) {
            writer.run("INSERT INTO rows(id) VALUES (?)", [value]);
          }
        },
        { chunkRows: 4 },
      ),
    );

    expect(chunks).toEqual([4, 4, 4, 4, 1]);
    const count = await runtime.runPromise(
      engine.read("test.count", (reader) =>
        reader.get<{ count: number }>("SELECT count(*) AS count FROM rows")
          ?.count
      ),
    );
    expect(count).toBe(17);
  });

  test("VACUUM INTO produces a coherent private backup and refuses overwrite", async () => {
    const root = await makeTempDir("vellum-state-backup-");
    const runtime = makeRuntime(join(root, "live", "vellum.db"));
    const engine = await runtime.runPromise(StateEngine);
    await runtime.runPromise(
      engine.transaction("test.seed", (writer) => {
        writer.run(
          "INSERT INTO state_metadata(key, value, updated_at) VALUES (?, ?, ?)",
          ["receipt", "present", "2026-07-27T00:00:00.000Z"],
        );
      }),
    );

    const backupPath = join(root, "backups", "vellum.db");
    await runtime.runPromise(engine.backup(backupPath));
    expect((await lstat(backupPath)).mode & 0o777).toBe(0o600);

    const backup = new DatabaseSync(backupPath, { readOnly: true });
    try {
      expect(
        backup.prepare(
          "SELECT value FROM state_metadata WHERE key = ?",
        ).get("receipt"),
      ).toEqual({ value: "present" });
    } finally {
      backup.close();
    }

    const second = await runtime.runPromise(
      Effect.either(engine.backup(backupPath)),
    );
    expect(second._tag).toBe("Left");
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
});
