import { mkdtemp, readdir, rm } from "node:fs/promises";
import { lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  createVerifiedStateBackup,
  openStateBackupSource,
  STATE_BACKUP_ATTEMPTS,
} from "../src/main/junto/state/backup";
import { answerBackup } from "../src/main/junto/state/backup-worker";
import { runStateBackup } from "../src/main/junto/state/backup-host";
import { makeStateEngineLive, StateEngine } from "../src/main/junto/state/engine";

let root: string;
let stateDirectory: string;
let path: string;
let schemaSha256: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-state-backup-worker-"));
  stateDirectory = join(root, "state");
  path = join(stateDirectory, "junto.db");
  const runtime = ManagedRuntime.make(makeStateEngineLive(path));
  try {
    schemaSha256 = (await runtime.runPromise(Effect.map(StateEngine, (engine) => engine.info))).schemaSha256;
  } finally {
    await runtime.dispose();
  }
});

afterEach(() => rm(root, { recursive: true, force: true }));

const backupFiles = async (): Promise<ReadonlyArray<string>> =>
  (await readdir(join(stateDirectory, "backups"))).sort();
const finals = (files: ReadonlyArray<string>) => files.filter((name) => /^junto-backup-.*\.db$/u.test(name));

/** Runs `afterCopy` once the VACUUM INTO of each attempt has returned, as a writer on another thread would land. */
const watched = (database: DatabaseSync, afterCopy: (copies: number) => void): { database: DatabaseSync; copies: () => number } => {
  let copies = 0;
  const wrap = <T extends object>(target: T, intercept?: (key: string | symbol) => unknown): T =>
    new Proxy(target, {
      get(inner, key) {
        const intercepted = intercept?.(key);
        if (intercepted !== undefined) return intercepted;
        const value = Reflect.get(inner, key, inner);
        return typeof value === "function" ? value.bind(inner) : value;
      },
    });
  return {
    copies: () => copies,
    database: wrap(database, (key) => key !== "prepare" ? undefined : (sql: string) => {
      const statement = database.prepare(sql);
      if (sql !== "VACUUM INTO ?") return statement;
      return wrap(statement, (name) => name !== "run" ? undefined : (...args: Array<string>) => {
        const result = statement.run(...args);
        copies += 1;
        afterCopy(copies);
        return result;
      });
    }),
  };
};

describe("the state backup, off the thread that asked for it", () => {
  test("backs up a database that is open elsewhere, owner only, verified, nothing pending", async () => {
    const runtime = ManagedRuntime.make(makeStateEngineLive(path));
    try {
      await runtime.runPromise(Effect.map(StateEngine, (engine) => engine.info));
      const receipt = await runStateBackup(path, stateDirectory);

      expect(receipt.schemaSha256).toBe(schemaSha256);
      expect(receipt.path.startsWith(join(stateDirectory, "backups"))).toBe(true);
      expect(lstatSync(receipt.path).mode & 0o777).toBe(0o600);
      const copy = new DatabaseSync(receipt.path, { readOnly: true });
      try {
        expect(copy.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
        expect(copy.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
      } finally {
        copy.close();
      }
      expect(await backupFiles()).toEqual([receipt.path.split("/").at(-1)]);
    } finally {
      await runtime.dispose();
    }
  });

  test("one at a time: two requests at once publish two verified files and leave nothing pending", async () => {
    const [first, second] = await Promise.all([runStateBackup(path, stateDirectory), runStateBackup(path, stateDirectory)]);
    expect(first.path).not.toBe(second.path);
    expect(finals(await backupFiles())).toHaveLength(2);
    expect((await backupFiles()).filter((name) => name.includes(".pending"))).toEqual([]);
  });

  test("starts over when the source changed between the witness and the copy, and publishes the second copy", async () => {
    const writer = new DatabaseSync(path);
    const source = openStateBackupSource(path);
    try {
      const probe = watched(source, (copies) => {
        if (copies === 1) writer.exec("CREATE TABLE changed_between (n INTEGER)");
      });
      const receipt = createVerifiedStateBackup(probe.database, stateDirectory);

      expect(probe.copies()).toBe(2);
      expect(finals(await backupFiles())).toEqual([receipt.path.split("/").at(-1)]);
      expect((await backupFiles()).filter((name) => name.includes(".pending"))).toEqual([]);
      const copy = new DatabaseSync(receipt.path, { readOnly: true });
      try {
        expect(copy.prepare("SELECT name FROM sqlite_schema WHERE name = 'changed_between'").get()).toEqual({ name: "changed_between" });
      } finally {
        copy.close();
      }
    } finally {
      source.close();
      writer.close();
    }
  });

  test("refuses a source that changes during every attempt, and publishes nothing", async () => {
    const writer = new DatabaseSync(path);
    const source = openStateBackupSource(path);
    try {
      const probe = watched(source, (copies) => writer.exec(`CREATE TABLE changed_${copies} (n INTEGER)`));
      expect(() => createVerifiedStateBackup(probe.database, stateDirectory)).toThrow(
        `state backup source changed during each of ${STATE_BACKUP_ATTEMPTS} attempts`,
      );
      expect(probe.copies()).toBe(STATE_BACKUP_ATTEMPTS);
      expect(await backupFiles()).toEqual([]);
    } finally {
      source.close();
      writer.close();
    }
  });

  test("the worker answers with the receipt, or with the failure's message", async () => {
    const ok = answerBackup({ path, stateDirectory });
    expect(ok).toMatchObject({ ok: true, receipt: { schemaSha256 } });

    const missing = answerBackup({ path: join(root, "absent", "junto.db"), stateDirectory });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.error).toMatch(/unable to open database file/u);
  });
});
