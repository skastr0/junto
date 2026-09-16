import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { PathLike } from "node:fs";
import type {
  DatabaseSync as ActualDatabaseSync,
  DatabaseSyncOptions,
} from "node:sqlite";
import { ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const abaControl = vi.hoisted(() => ({
  armed: false,
  phase: "read-only" as "read-only" | "writable" | "missing-writable",
  opsPath: "",
  productPath: "",
  swaps: 0,
  recreatedMissingMain: false,
}));

vi.mock("node:sqlite", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:sqlite")>();
  const DatabaseSync = new Proxy(actual.DatabaseSync, {
    construct(target, argumentsList) {
      const [location, options] = argumentsList as [
        PathLike,
        DatabaseSyncOptions | undefined,
      ];
      const readOnly = options?.readOnly === true;
      const matchingPhase = abaControl.phase === "read-only" ? readOnly : !readOnly;
      const openedPath = location instanceof URL
        ? fileURLToPath(location)
        : Buffer.isBuffer(location)
          ? location.toString("utf8")
          : String(location);

      if (
        abaControl.armed &&
        matchingPhase &&
        openedPath === abaControl.opsPath
      ) {
        abaControl.armed = false;
        abaControl.swaps += 1;
        const admittedAway = `${abaControl.opsPath}.aba-admitted`;
        renameSync(abaControl.opsPath, admittedAway);
        if (abaControl.phase === "missing-writable") {
          try {
            const database = Reflect.construct(
              target,
              argumentsList,
            ) as ActualDatabaseSync;
            abaControl.recreatedMissingMain = true;
            database.close();
            rmSync(abaControl.opsPath, { force: true });
            renameSync(admittedAway, abaControl.opsPath);
            throw new Error("SQLite recreated a missing mode=rw pathname");
          } catch (error) {
            if (existsSync(admittedAway)) {
              renameSync(admittedAway, abaControl.opsPath);
            }
            throw error;
          }
        }
        renameSync(abaControl.productPath, abaControl.opsPath);
        try {
          const database = Reflect.construct(
            target,
            argumentsList,
          ) as ActualDatabaseSync;
          renameSync(abaControl.opsPath, abaControl.productPath);
          renameSync(admittedAway, abaControl.opsPath);
          return database;
        } catch (error) {
          renameSync(abaControl.opsPath, abaControl.productPath);
          renameSync(admittedAway, abaControl.opsPath);
          throw error;
        }
      }

      return Reflect.construct(target, argumentsList) as ActualDatabaseSync;
    },
  });

  return { ...actual, DatabaseSync };
});

import { DatabaseSync } from "node:sqlite";
import {
  InstallOpsService,
  makeInstallOpsLive,
} from "../src/main/junto/install-ops/engine";
import {
  INSTALL_OPS_SCHEMA_SQL,
  INSTALL_OPS_SCHEMA_VERSION,
} from "../src/main/junto/install-ops/schema";

const roots: string[] = [];
const runtimes: Array<ManagedRuntime.ManagedRuntime<any, unknown>> = [];

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  abaControl.armed = false;
  abaControl.swaps = 0;
  abaControl.recreatedMissingMain = false;
  while (runtimes.length > 0) await runtimes.pop()!.dispose();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

const seedInstallOps = (path: string): void => {
  const database = new DatabaseSync(path);
  try {
    database.exec(INSTALL_OPS_SCHEMA_SQL);
    database.exec(`PRAGMA user_version = ${INSTALL_OPS_SCHEMA_VERSION}`);
    database.prepare(
      `
        INSERT INTO backfill_markers(id, status, objects_ingested, completed_at)
        VALUES ('test.aba-ledger', 'pending', 2, NULL)
      `,
    ).run();
  } finally {
    database.close();
  }
  chmodSync(path, 0o600);
};

const seedProduct = (path: string): void => {
  const database = new DatabaseSync(path);
  try {
    database.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA user_version = 1;
      CREATE TABLE operator_canary (
        id INTEGER PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      INSERT INTO operator_canary(id, value) VALUES (1, 'preserve-me');
    `);
  } finally {
    database.close();
  }
  chmodSync(path, 0o640);
  for (const suffix of ["-journal", "-wal", "-shm"] as const) {
    writeFileSync(`${path}${suffix}`, `product-sidecar-canary:${suffix}`, {
      mode: 0o640,
    });
  }
};

const productFacts = (path: string) => {
  const copy = join(tmpdir(), `junto-aba-product-copy-${randomUUID()}.db`);
  writeFileSync(copy, readFileSync(path), { mode: 0o600 });
  const database = new DatabaseSync(copy, { readOnly: true });
  try {
    const version = database.prepare("PRAGMA user_version").get() as {
      readonly user_version: number;
    };
    const tables = database.prepare(
      `
        SELECT name
        FROM sqlite_schema
        WHERE type = 'table'
        ORDER BY name
      `,
    ).all() as Array<{ readonly name: string }>;
    const canary = database.prepare(
      "SELECT value FROM operator_canary WHERE id = 1",
    ).get() as { readonly value: string };
    return {
      version: Number(version.user_version),
      tables: tables.map((row) => row.name),
      canary: canary.value,
    };
  } finally {
    database.close();
    rmSync(copy, { force: true });
  }
};

const fileWitness = (path: string) => {
  const info = lstatSync(path);
  const bytes = readFileSync(path);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
    dev: info.dev,
    ino: info.ino,
    mode: info.mode & 0o777,
    nlink: info.nlink,
  };
};

const familyWitness = (path: string) => ({
  main: fileWitness(path),
  journal: fileWitness(`${path}-journal`),
  wal: fileWitness(`${path}-wal`),
  shm: fileWitness(`${path}-shm`),
});

describe("install-ops actual-connection constructor ABA", () => {
  for (const phase of ["read-only", "writable"] as const) {
    it(`fingerprints and rejects product state swapped only during the ${phase} constructor`, async () => {
      const root = join(tmpdir(), `junto-install-ops-aba-${randomUUID()}`);
      roots.push(root);
      mkdirSync(root, { recursive: true });
      const opsPath = join(root, "install-ops.db");
      const productPath = join(root, "junto.db");
      seedInstallOps(opsPath);
      seedProduct(productPath);

      const productBefore = familyWitness(productPath);
      const opsBefore = fileWitness(opsPath);
      const entriesBefore = readdirSync(root).sort();
      abaControl.phase = phase;
      abaControl.opsPath = opsPath;
      abaControl.productPath = productPath;
      abaControl.armed = true;

      const runtime = ManagedRuntime.make(makeInstallOpsLive(opsPath));
      runtimes.push(runtime);
      const service = await runtime.runPromise(InstallOpsService);
      expect(abaControl.swaps).toBe(1);
      expect(service.availability).toMatchObject({
        status: "unavailable",
        reason: {
          _tag: "InstallOpsDeferredError",
          operation: "acquire",
          cause: { _tag: "InstallOpsError", operation: "open" },
        },
      });
      await expect(
        runtime.runPromise(service.ensurePending("test.must-not-write")),
      ).rejects.toMatchObject({
        _tag: "InstallOpsDeferredError",
        operation: "ensurePending",
      });
      await expect(
        runtime.runPromise(service.markComplete("test.aba-ledger", 8)),
      ).rejects.toMatchObject({
        _tag: "InstallOpsDeferredError",
        operation: "markComplete",
      });

      expect(familyWitness(productPath)).toEqual(productBefore);
      expect(fileWitness(opsPath)).toEqual(opsBefore);
      expect(readdirSync(root).sort()).toEqual(entriesBefore);
      expect(productFacts(productPath)).toEqual({
        version: 1,
        tables: ["operator_canary"],
        canary: "preserve-me",
      });
      expect(readdirSync(root).sort()).toEqual(entriesBefore);
    });
  }

  it("does not recreate a main pathname removed before writable construction", async () => {
    const root = join(tmpdir(), `junto-install-ops-existing-${randomUUID()}`);
    roots.push(root);
    mkdirSync(root, { recursive: true });
    const opsPath = join(root, "install-ops.db");
    seedInstallOps(opsPath);
    const before = fileWitness(opsPath);
    const entriesBefore = readdirSync(root).sort();

    abaControl.phase = "missing-writable";
    abaControl.opsPath = opsPath;
    abaControl.productPath = "";
    abaControl.armed = true;

    const runtime = ManagedRuntime.make(makeInstallOpsLive(opsPath));
    runtimes.push(runtime);
    const service = await runtime.runPromise(InstallOpsService);
    expect(abaControl.swaps).toBe(1);
    expect(abaControl.recreatedMissingMain).toBe(false);
    expect(service.availability.status).toBe("unavailable");
    expect(fileWitness(opsPath)).toEqual(before);
    expect(readdirSync(root).sort()).toEqual(entriesBefore);
  });

});
