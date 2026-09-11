import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BACKFILL_INLINE_MEDIA_V1,
  InstallOpsService,
  makeInstallOpsLive,
} from "../src/main/vellum-command/install-ops/engine";
import {
  INSTALL_OPS_SCHEMA_SQL,
  INSTALL_OPS_SCHEMA_VERSION,
} from "../src/main/vellum-command/install-ops/schema";
import { ContentService, makeContentServiceLive } from "../src/main/vellum-command/content/service";
import { StateEngine, makeStateEngineLive } from "../src/main/vellum-command/state/engine";
import { CURRENT_STATE_SCHEMA_VERSION } from "../src/main/vellum-command/state/migrations";

const FAMILY_SUFFIXES = ["", "-journal", "-wal", "-shm"] as const;
type FamilySuffix = (typeof FAMILY_SUFFIXES)[number];
const roots: string[] = [];
const runtimes: Array<ManagedRuntime.ManagedRuntime<any, unknown>> = [];

beforeEach(() => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  while (runtimes.length > 0) {
    await runtimes.pop()!.dispose();
  }
  while (roots.length > 0) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

const makeRoot = async (): Promise<string> => {
  const root = join(tmpdir(), `vellum-install-ops-safety-${randomUUID()}`);
  roots.push(root);
  await mkdir(root, { recursive: true });
  return root;
};

const trackRuntime = <R, E>(
  runtime: ManagedRuntime.ManagedRuntime<R, E>,
): ManagedRuntime.ManagedRuntime<R, E> => {
  runtimes.push(runtime as ManagedRuntime.ManagedRuntime<any, unknown>);
  return runtime;
};

const disposeRuntime = async (
  runtime: ManagedRuntime.ManagedRuntime<any, unknown>,
): Promise<void> => {
  await runtime.dispose();
  const index = runtimes.indexOf(runtime);
  if (index >= 0) runtimes.splice(index, 1);
};

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return false;
    }
    throw error;
  }
};

const seedOperatorDatabase = (path: string, version = 18): void => {
  const database = new DatabaseSync(path);
  try {
    database.exec(`
      PRAGMA journal_mode = DELETE;
      PRAGMA user_version = ${version};
      CREATE TABLE operator_canary (
        id INTEGER PRIMARY KEY,
        value TEXT NOT NULL
      ) STRICT;
      INSERT INTO operator_canary(id, value) VALUES (1, 'preserve-me');
    `);
  } finally {
    database.close();
  }
};

const seedInstallOpsDatabase = (
  path: string,
  marker?: { readonly id: string; readonly status: "pending" | "complete" },
): void => {
  const database = new DatabaseSync(path);
  try {
    database.exec("PRAGMA journal_mode = DELETE");
    database.exec(INSTALL_OPS_SCHEMA_SQL);
    database.exec(`PRAGMA user_version = ${INSTALL_OPS_SCHEMA_VERSION}`);
    if (marker !== undefined) {
      database
        .prepare(
          `
            INSERT INTO backfill_markers(id, status, objects_ingested, completed_at)
            VALUES (?, ?, 0, NULL)
          `,
        )
        .run(marker.id, marker.status);
    }
  } finally {
    database.close();
  }
};

const readOperatorFacts = (path: string) => {
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const version = database.prepare("PRAGMA user_version").get() as {
      readonly user_version: number;
    };
    const tables = database
      .prepare(
        `
          SELECT name
          FROM sqlite_schema
          WHERE type = 'table'
          ORDER BY name
        `,
      )
      .all() as Array<{ readonly name: string }>;
    const canary = database
      .prepare("SELECT value FROM operator_canary WHERE id = 1")
      .get() as { readonly value: string };
    return {
      version: Number(version.user_version),
      tables: tables.map((row) => row.name),
      canary: canary.value,
    };
  } finally {
    database.close();
  }
};

const readOperatorFactsFromMainBytes = async (path: string): Promise<
  ReturnType<typeof readOperatorFacts>
> => {
  const copy = join(tmpdir(), `vellum-product-facts-${randomUUID()}.db`);
  try {
    await writeFile(copy, await readFile(path), { mode: 0o600 });
    return readOperatorFacts(copy);
  } finally {
    await rm(copy, { force: true });
  }
};

type LeafSnapshot = {
  readonly sha256: string;
  readonly size: number;
  readonly dev: number;
  readonly ino: number;
  readonly mode: number;
  readonly nlink: number;
};

type FamilySnapshot = Readonly<Record<string, LeafSnapshot | undefined>>;

const snapshotPath = async (path: string): Promise<LeafSnapshot> => {
  const info = await lstat(path);
  const bytes = await readFile(path);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    size: bytes.length,
    dev: info.dev,
    ino: info.ino,
    mode: info.mode & 0o777,
    nlink: info.nlink,
  };
};

const snapshotFamily = async (mainPath: string): Promise<FamilySnapshot> => {
  const snapshot: Record<string, LeafSnapshot | undefined> = {};
  for (const suffix of FAMILY_SUFFIXES) {
    const path = `${mainPath}${suffix}`;
    if (!(await pathExists(path))) {
      snapshot[suffix] = undefined;
      continue;
    }
    const info = await lstat(path);
    const bytes = await readFile(path);
    snapshot[suffix] = {
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size: bytes.length,
      dev: info.dev,
      ino: info.ino,
      mode: info.mode & 0o777,
      nlink: info.nlink,
    };
  }
  return snapshot;
};

const expectFamilyUnchanged = async (
  mainPath: string,
  before: FamilySnapshot,
): Promise<void> => {
  expect(await snapshotFamily(mainPath)).toEqual(before);
};

const seedProductFamily = async (root: string): Promise<string> => {
  const productPath = join(root, "vellum-command.db");
  seedOperatorDatabase(productPath, 18);
  await chmod(productPath, 0o640);
  for (const suffix of FAMILY_SUFFIXES.slice(1)) {
    await writeFile(
      `${productPath}${suffix}`,
      `product-sidecar-canary:${suffix}`,
      { mode: 0o640 },
    );
  }
  return productPath;
};

const expectProductFacts = async (productPath: string): Promise<void> => {
  await expect(readOperatorFactsFromMainBytes(productPath)).resolves.toEqual({
    version: 18,
    tables: ["operator_canary"],
    canary: "preserve-me",
  });
};

const expectDeferred = async (
  runtime: ManagedRuntime.ManagedRuntime<any, unknown>,
  path: string,
) => {
  const service = await runtime.runPromise(InstallOpsService);
  expect(service.availability).toMatchObject({
    status: "unavailable",
    reason: {
      _tag: "InstallOpsDeferredError",
      operation: "acquire",
      path,
      cause: { _tag: "InstallOpsError", operation: "open" },
    },
  });
  await expect(
    runtime.runPromise(service.ensurePending("test.backfill")),
  ).rejects.toMatchObject({
    _tag: "InstallOpsDeferredError",
    operation: "ensurePending",
    path,
  });
  await expect(
    runtime.runPromise(service.markComplete("test.backfill", 1)),
  ).rejects.toMatchObject({
    _tag: "InstallOpsDeferredError",
    operation: "markComplete",
    path,
  });
  return service;
};

const expectNoOpsSidecars = async (path: string): Promise<void> => {
  await expect(pathExists(`${path}-journal`)).resolves.toBe(false);
  await expect(pathExists(`${path}-wal`)).resolves.toBe(false);
  await expect(pathExists(`${path}-shm`)).resolves.toBe(false);
};

describe("install-ops rollback ledger and restart", () => {
  it("creates an owner-only ledger, leaves no sidecars, and persists markers across restarts", async () => {
    const root = await makeRoot();
    const stateDirectory = join(root, "state");
    const path = join(stateDirectory, "install-ops.db");

    const firstRuntime = trackRuntime(
      ManagedRuntime.make(makeInstallOpsLive(path)),
    );
    const first = await firstRuntime.runPromise(InstallOpsService);
    expect(first.availability).toEqual({ status: "available" });
    expect((await readdir(stateDirectory)).sort()).toEqual(["install-ops.db"]);
    await firstRuntime.runPromise(first.ensurePending("test.restart"));
    await firstRuntime.runPromise(first.markComplete("test.restart", 7));
    await expect(
      firstRuntime.runPromise(first.getBackfill("test.restart")),
    ).resolves.toMatchObject({
      id: "test.restart",
      status: "complete",
      objectsIngested: 7,
    });
    await expectNoOpsSidecars(path);
    await disposeRuntime(firstRuntime);
    await expectNoOpsSidecars(path);

    const secondRuntime = trackRuntime(
      ManagedRuntime.make(makeInstallOpsLive(path)),
    );
    const second = await secondRuntime.runPromise(InstallOpsService);
    expect(second.availability).toEqual({ status: "available" });
    await expect(
      secondRuntime.runPromise(second.getBackfill("test.restart")),
    ).resolves.toMatchObject({
      status: "complete",
      objectsIngested: 7,
    });
    await secondRuntime.runPromise(second.reopenPending("test.restart"));
    await expect(
      secondRuntime.runPromise(second.getBackfill("test.restart")),
    ).resolves.toMatchObject({ status: "pending", objectsIngested: 7 });
    await expectNoOpsSidecars(path);
    await disposeRuntime(secondRuntime);

    const thirdRuntime = trackRuntime(
      ManagedRuntime.make(makeInstallOpsLive(path)),
    );
    const third = await thirdRuntime.runPromise(InstallOpsService);
    await expect(
      thirdRuntime.runPromise(third.getBackfill("test.restart")),
    ).resolves.toMatchObject({ status: "pending", objectsIngested: 7 });
    await expectNoOpsSidecars(path);

    const directoryInfo = await lstat(stateDirectory);
    const fileInfo = await lstat(path);
    expect(directoryInfo.isDirectory()).toBe(true);
    expect(directoryInfo.mode & 0o777).toBe(0o700);
    expect(fileInfo.isFile()).toBe(true);
    expect(fileInfo.nlink).toBe(1);
    expect(fileInfo.mode & 0o777).toBe(0o600);
  });

  it("preserves a non-hot leftover journal instead of guessing that it is owned", async () => {
    const root = await makeRoot();
    const path = join(root, "install-ops.db");
    seedInstallOpsDatabase(path, {
      id: "test.leftover-journal",
      status: "pending",
    });
    await chmod(path, 0o600);
    const child = spawnSync(
      process.execPath,
      [
        "-e",
        `
          const { DatabaseSync } = require("node:sqlite");
          const database = new DatabaseSync(process.argv[1]);
          database.exec("PRAGMA journal_mode = DELETE");
          database.exec("PRAGMA synchronous = FULL");
          database.exec("BEGIN IMMEDIATE");
          database.prepare(
            "UPDATE backfill_markers SET status = 'complete', objects_ingested = 99 WHERE id = ?",
          ).run("test.leftover-journal");
          process.exit(0);
        `,
        path,
      ],
      { encoding: "utf8" },
    );
    expect(child.status).toBe(0);
    expect(await pathExists(`${path}-journal`)).toBe(true);
    const before = await snapshotFamily(path);
    const entriesBefore = (await readdir(root)).sort();

    const runtime = trackRuntime(ManagedRuntime.make(makeInstallOpsLive(path)));
    await expectDeferred(runtime, path);

    await expectFamilyUnchanged(path, before);
    expect((await readdir(root)).sort()).toEqual(entriesBefore);
  });

  it("clone-validates and recovers a genuinely hot rollback journal", async () => {
    const root = await makeRoot();
    const path = join(root, "install-ops.db");
    await writeFile(path, "", { mode: 0o600 });
    const child = spawnSync(
      process.execPath,
      [
        "-e",
        `
          const { DatabaseSync } = require("node:sqlite");
          const database = new DatabaseSync(process.argv[1]);
          database.exec(${JSON.stringify(INSTALL_OPS_SCHEMA_SQL)});
          database.exec("PRAGMA user_version = ${INSTALL_OPS_SCHEMA_VERSION}");
          const insert = database.prepare(
            "INSERT INTO backfill_markers(id, status, objects_ingested, completed_at) VALUES (?, 'pending', 0, NULL)",
          );
          database.exec("BEGIN");
          for (let index = 0; index < 1024; index += 1) {
            insert.run("test.hot." + String(index).padStart(4, "0"));
          }
          database.exec("COMMIT");
          database.exec("PRAGMA journal_mode = DELETE");
          database.exec("PRAGMA synchronous = FULL");
          database.exec("PRAGMA cache_size = 1");
          database.exec("BEGIN IMMEDIATE");
          database.exec(
            "UPDATE backfill_markers SET status = 'complete', objects_ingested = 9",
          );
          process.exit(0);
        `,
        path,
      ],
      { encoding: "utf8" },
    );
    expect(child.status).toBe(0);
    expect(await pathExists(`${path}-journal`)).toBe(true);

    const firstRuntime = trackRuntime(
      ManagedRuntime.make(makeInstallOpsLive(path)),
    );
    const first = await firstRuntime.runPromise(InstallOpsService);
    expect(first.availability).toEqual({ status: "available" });
    await expect(
      firstRuntime.runPromise(first.getBackfill("test.hot.0000")),
    ).resolves.toMatchObject({ status: "pending", objectsIngested: 0 });
    await firstRuntime.runPromise(first.markComplete("test.hot.0000", 6));
    await expectNoOpsSidecars(path);
    expect(
      (await readdir(root)).filter((name) =>
        name.startsWith(".install-ops-recovery-")
      ),
    ).toEqual([]);
    await disposeRuntime(firstRuntime);

    const secondRuntime = trackRuntime(
      ManagedRuntime.make(makeInstallOpsLive(path)),
    );
    const second = await secondRuntime.runPromise(InstallOpsService);
    await expect(
      secondRuntime.runPromise(second.getBackfill("test.hot.0000")),
    ).resolves.toMatchObject({ status: "complete", objectsIngested: 6 });
    await expect(
      secondRuntime.runPromise(second.getBackfill("test.hot.0001")),
    ).resolves.toMatchObject({ status: "pending", objectsIngested: 0 });
    await expectNoOpsSidecars(path);
  });

  it("preserves a zero-origin hot journal without app-minted provenance", async () => {
    const root = await makeRoot();
    const path = join(root, "install-ops.db");
    await writeFile(path, "", { mode: 0o600 });
    const child = spawnSync(
      process.execPath,
      [
        "-e",
        `
          const { DatabaseSync } = require("node:sqlite");
          const database = new DatabaseSync(process.argv[1]);
          database.exec("PRAGMA journal_mode = DELETE");
          database.exec("PRAGMA synchronous = FULL");
          database.exec("PRAGMA cache_size = 1");
          database.exec("BEGIN IMMEDIATE");
          database.exec(${JSON.stringify(INSTALL_OPS_SCHEMA_SQL)});
          database.exec("PRAGMA user_version = ${INSTALL_OPS_SCHEMA_VERSION}");
          process.exit(0);
        `,
        path,
      ],
      { encoding: "utf8" },
    );
    expect(child.status).toBe(0);
    expect(await pathExists(`${path}-journal`)).toBe(true);
    const before = await snapshotFamily(path);
    const entriesBefore = (await readdir(root)).sort();

    const runtime = trackRuntime(ManagedRuntime.make(makeInstallOpsLive(path)));
    await expectDeferred(runtime, path);

    await expectFamilyUnchanged(path, before);
    expect((await readdir(root)).sort()).toEqual(entriesBefore);
  });

  it("admits the exact prior v1 schema and converts a crash-left WAL family to DELETE", async () => {
    const root = await makeRoot();
    const path = join(root, "install-ops.db");
    await writeFile(path, "", { mode: 0o600 });
    const child = spawnSync(
      process.execPath,
      [
        "-e",
        `
          const { DatabaseSync } = require("node:sqlite");
          const database = new DatabaseSync(process.argv[1]);
          database.exec("PRAGMA journal_mode = WAL");
          database.exec("PRAGMA wal_autocheckpoint = 0");
          database.exec(${JSON.stringify(INSTALL_OPS_SCHEMA_SQL)});
          database.exec("PRAGMA user_version = ${INSTALL_OPS_SCHEMA_VERSION}");
          database.prepare(
            "INSERT INTO backfill_markers(id, status, objects_ingested, completed_at) VALUES (?, 'pending', 4, NULL)",
          ).run("test.legacy-wal");
          process.exit(0);
        `,
        path,
      ],
      { encoding: "utf8" },
    );
    expect(child.status).toBe(0);
    expect(await pathExists(`${path}-wal`)).toBe(true);
    expect(await pathExists(`${path}-shm`)).toBe(true);
    for (const suffix of FAMILY_SUFFIXES) {
      if (await pathExists(`${path}${suffix}`)) {
        expect((await lstat(`${path}${suffix}`)).mode & 0o777).toBe(0o600);
      }
    }

    const firstRuntime = trackRuntime(
      ManagedRuntime.make(makeInstallOpsLive(path)),
    );
    const first = await firstRuntime.runPromise(InstallOpsService);
    expect(first.availability).toEqual({ status: "available" });
    await expect(
      firstRuntime.runPromise(first.getBackfill("test.legacy-wal")),
    ).resolves.toMatchObject({ status: "pending", objectsIngested: 4 });
    await firstRuntime.runPromise(first.markComplete("test.legacy-wal", 9));
    await expectNoOpsSidecars(path);
    await disposeRuntime(firstRuntime);

    const secondRuntime = trackRuntime(
      ManagedRuntime.make(makeInstallOpsLive(path)),
    );
    const second = await secondRuntime.runPromise(InstallOpsService);
    await expect(
      secondRuntime.runPromise(second.getBackfill("test.legacy-wal")),
    ).resolves.toMatchObject({ status: "complete", objectsIngested: 9 });
    await expectNoOpsSidecars(path);
  });

  it("preserves a header-shaped SHM that is detached from its WAL", async () => {
    const root = await makeRoot();
    const path = join(root, "install-ops.db");
    await writeFile(path, "", { mode: 0o600 });
    const child = spawnSync(
      process.execPath,
      [
        "-e",
        `
          const { DatabaseSync } = require("node:sqlite");
          const database = new DatabaseSync(process.argv[1]);
          database.exec("PRAGMA journal_mode = WAL");
          database.exec("PRAGMA wal_autocheckpoint = 0");
          database.exec(${JSON.stringify(INSTALL_OPS_SCHEMA_SQL)});
          database.exec("PRAGMA user_version = ${INSTALL_OPS_SCHEMA_VERSION}");
          database.prepare(
            "INSERT INTO backfill_markers(id, status, objects_ingested, completed_at) VALUES ('test.wal-shm', 'pending', 1, NULL)",
          ).run();
          process.exit(0);
        `,
        path,
      ],
      { encoding: "utf8" },
    );
    expect(child.status).toBe(0);
    const detachedShm = Buffer.from(await readFile(`${path}-shm`));
    detachedShm[32] ^= 0xff;
    detachedShm[80] ^= 0xff;
    await writeFile(`${path}-shm`, detachedShm, { mode: 0o600 });
    const before = await snapshotFamily(path);
    const entriesBefore = (await readdir(root)).sort();

    const runtime = trackRuntime(ManagedRuntime.make(makeInstallOpsLive(path)));
    await expectDeferred(runtime, path);

    await expectFamilyUnchanged(path, before);
    expect((await readdir(root)).sort()).toEqual(entriesBefore);
  });

  it("rejects a rollback journal that names an external master journal", async () => {
    const root = await makeRoot();
    const path = join(root, "install-ops.db");
    await writeFile(path, "", { mode: 0o600 });
    const child = spawnSync(
      process.execPath,
      [
        "-e",
        `
          const { DatabaseSync } = require("node:sqlite");
          const database = new DatabaseSync(process.argv[1]);
          database.exec(${JSON.stringify(INSTALL_OPS_SCHEMA_SQL)});
          database.exec("PRAGMA user_version = ${INSTALL_OPS_SCHEMA_VERSION}");
          database.exec("PRAGMA synchronous = FULL");
          database.exec("PRAGMA cache_size = 1");
          database.exec("BEGIN IMMEDIATE");
          for (let index = 0; index < 512; index += 1) {
            database.prepare(
              "INSERT INTO backfill_markers(id, status, objects_ingested, completed_at) VALUES (?, 'pending', 0, NULL)",
            ).run("test.master." + String(index).padStart(4, "0"));
          }
          process.exit(0);
        `,
        path,
      ],
      { encoding: "utf8" },
    );
    expect(child.status).toBe(0);
    const external = join(root, "external-master-canary");
    await writeFile(external, "preserve-external-master", { mode: 0o600 });
    const externalBefore = await snapshotPath(external);
    const name = Buffer.from(external, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32BE(name.length);
    const checksum = Buffer.alloc(4);
    const magic = Buffer.from([
      0xd9, 0xd5, 0x05, 0xf9, 0x20, 0xa1, 0x63, 0xd7,
    ]);
    await writeFile(
      `${path}-journal`,
      Buffer.concat([name, length, checksum, magic]),
      { flag: "a" },
    );
    const before = await snapshotFamily(path);
    const entriesBefore = (await readdir(root)).sort();

    const runtime = trackRuntime(ManagedRuntime.make(makeInstallOpsLive(path)));
    await expectDeferred(runtime, path);

    await expectFamilyUnchanged(path, before);
    expect(await snapshotPath(external)).toEqual(externalBefore);
    expect((await readdir(root)).sort()).toEqual(entriesBefore);
  });
});

describe("install-ops complete SQLite-family admission", () => {
  for (const ledgerState of ["fresh", "existing"] as const) {
    for (const suffix of FAMILY_SUFFIXES) {
      for (const aliasKind of ["symlink", "hardlink"] as const) {
        it(`rejects a ${aliasKind} product-family alias at ${suffix || "main"} for a ${ledgerState} ledger without mutation`, async () => {
          const root = await makeRoot();
          const productPath = await seedProductFamily(root);
          const opsPath = join(root, "install-ops.db");
          let displacedPath: string | undefined;

          if (ledgerState === "existing") {
            seedInstallOpsDatabase(opsPath, {
              id: "test.existing",
              status: "pending",
            });
            await chmod(opsPath, 0o600);
          }

          const attackPath = `${opsPath}${suffix}`;
          if (ledgerState === "existing" && suffix === "") {
            displacedPath = `${opsPath}.displaced`;
            await rename(opsPath, displacedPath);
          }
          const productMember = `${productPath}${suffix}`;
          if (aliasKind === "symlink") {
            await symlink(productMember, attackPath);
          } else {
            await link(productMember, attackPath);
          }

          const productBefore = await snapshotFamily(productPath);
          const displacedBefore = displacedPath === undefined
            ? undefined
            : await readFile(displacedPath);
          const entriesBefore = (await readdir(root)).sort();
          const runtime = trackRuntime(
            ManagedRuntime.make(makeInstallOpsLive(opsPath)),
          );
          await expectDeferred(runtime, opsPath);

          await expectFamilyUnchanged(productPath, productBefore);
          await expectProductFacts(productPath);
          expect((await readdir(root)).sort()).toEqual(entriesBefore);
          if (displacedPath !== undefined) {
            expect(await readFile(displacedPath)).toEqual(displacedBefore);
          }
          const attackInfo = await lstat(attackPath);
          expect(
            aliasKind === "symlink"
              ? attackInfo.isSymbolicLink()
              : attackInfo.nlink === 2,
          ).toBe(true);
        });
      }
    }
  }

  for (const ledgerState of ["fresh", "existing"] as const) {
    for (const suffix of FAMILY_SUFFIXES.slice(1)) {
      it(`rejects the product main hard-linked as ${suffix} for a ${ledgerState} ledger`, async () => {
        const root = await makeRoot();
        const productPath = await seedProductFamily(root);
        const opsPath = join(root, "install-ops.db");
        if (ledgerState === "existing") {
          seedInstallOpsDatabase(opsPath, {
            id: "test.product-main-alias",
            status: "pending",
          });
          await chmod(opsPath, 0o600);
        }
        await link(productPath, `${opsPath}${suffix}`);
        const productBefore = await snapshotFamily(productPath);
        const entriesBefore = (await readdir(root)).sort();

        const runtime = trackRuntime(
          ManagedRuntime.make(makeInstallOpsLive(opsPath)),
        );
        await expectDeferred(runtime, opsPath);

        await expectFamilyUnchanged(productPath, productBefore);
        await expectProductFacts(productPath);
        expect((await readdir(root)).sort()).toEqual(entriesBefore);
        expect((await lstat(productPath)).nlink).toBe(2);
        expect((await lstat(`${opsPath}${suffix}`)).nlink).toBe(2);
      });
    }
  }

  for (const productSuffix of FAMILY_SUFFIXES) {
    it(`rejects a reverse alias from product ${productSuffix || "main"} to the install-ops inode`, async () => {
      const root = await makeRoot();
      const path = join(root, "install-ops.db");
      const productPath = join(root, "vellum-command.db");
      seedInstallOpsDatabase(path, {
        id: "test.reverse-alias",
        status: "pending",
      });
      await chmod(path, 0o600);
      await symlink(path, `${productPath}${productSuffix}`);
      const opsBefore = await snapshotFamily(path);
      const productLinkBefore = await lstat(`${productPath}${productSuffix}`);
      const entriesBefore = (await readdir(root)).sort();

      const runtime = trackRuntime(ManagedRuntime.make(makeInstallOpsLive(path)));
      await expectDeferred(runtime, path);

      await expectFamilyUnchanged(path, opsBefore);
      expect((await readdir(root)).sort()).toEqual(entriesBefore);
      const productLinkAfter = await lstat(`${productPath}${productSuffix}`);
      expect(productLinkAfter.isSymbolicLink()).toBe(true);
      expect(productLinkAfter.ino).toBe(productLinkBefore.ino);
      expect(productLinkAfter.mode).toBe(productLinkBefore.mode);
    });
  }

  it("rejects two install-ops family names that share one inode", async () => {
    const root = await makeRoot();
    const path = join(root, "install-ops.db");
    seedInstallOpsDatabase(path);
    await chmod(path, 0o600);
    await link(path, `${path}-wal`);
    const before = await snapshotFamily(path);
    const entriesBefore = (await readdir(root)).sort();

    const runtime = trackRuntime(ManagedRuntime.make(makeInstallOpsLive(path)));
    await expectDeferred(runtime, path);

    await expectFamilyUnchanged(path, before);
    expect((await readdir(root)).sort()).toEqual(entriesBefore);
    expect((await lstat(path)).nlink).toBe(2);
    expect((await lstat(`${path}-wal`)).nlink).toBe(2);
  });

  for (const suffix of FAMILY_SUFFIXES.slice(1)) {
    it(`preserves an opaque owner-only file at ${suffix}`, async () => {
      const root = await makeRoot();
      const path = join(root, "install-ops.db");
      seedInstallOpsDatabase(path);
      await chmod(path, 0o600);
      await writeFile(`${path}${suffix}`, `opaque-sidecar:${suffix}`, {
        mode: 0o600,
      });
      const before = await snapshotFamily(path);
      const entriesBefore = (await readdir(root)).sort();

      const runtime = trackRuntime(ManagedRuntime.make(makeInstallOpsLive(path)));
      await expectDeferred(runtime, path);

      await expectFamilyUnchanged(path, before);
      expect((await readdir(root)).sort()).toEqual(entriesBefore);
    });
  }

  for (const suffix of FAMILY_SUFFIXES.slice(1)) {
    it(`rejects an unsafe owner mode on ${suffix} without cleanup`, async () => {
      const root = await makeRoot();
      const path = join(root, "install-ops.db");
      seedInstallOpsDatabase(path);
      await chmod(path, 0o600);
      await writeFile(`${path}${suffix}`, `unsafe-mode:${suffix}`, {
        mode: 0o640,
      });
      const before = await snapshotFamily(path);
      const entriesBefore = (await readdir(root)).sort();

      const runtime = trackRuntime(ManagedRuntime.make(makeInstallOpsLive(path)));
      await expectDeferred(runtime, path);

      await expectFamilyUnchanged(path, before);
      expect((await readdir(root)).sort()).toEqual(entriesBefore);
      expect((await lstat(`${path}${suffix}`)).mode & 0o777).toBe(0o640);
    });
  }

  it("rejects an unsafe owner mode without chmod or deletion", async () => {
    const root = await makeRoot();
    const path = join(root, "install-ops.db");
    seedInstallOpsDatabase(path);
    await chmod(path, 0o640);
    const before = await snapshotFamily(path);
    const entriesBefore = (await readdir(root)).sort();

    const runtime = trackRuntime(ManagedRuntime.make(makeInstallOpsLive(path)));
    await expectDeferred(runtime, path);

    await expectFamilyUnchanged(path, before);
    expect((await readdir(root)).sort()).toEqual(entriesBefore);
    expect((await lstat(path)).mode & 0o777).toBe(0o640);
  });

  it("does not adopt a caller-created empty file as an app-created ledger", async () => {
    const root = await makeRoot();
    const path = join(root, "install-ops.db");
    await writeFile(path, "", { mode: 0o600 });
    const before = await snapshotFamily(path);

    const runtime = trackRuntime(ManagedRuntime.make(makeInstallOpsLive(path)));
    await expectDeferred(runtime, path);

    await expectFamilyUnchanged(path, before);
  });

  it("rejects the product pathname itself and a non-regular ledger leaf", async () => {
    const root = await makeRoot();
    const productPath = join(root, "vellum-command.db");
    seedOperatorDatabase(productPath, 18);
    const productBytes = await readFile(productPath);

    const directRuntime = trackRuntime(
      ManagedRuntime.make(makeInstallOpsLive(productPath)),
    );
    await expectDeferred(directRuntime, productPath);
    expect(await readFile(productPath)).toEqual(productBytes);
    expect(readOperatorFacts(productPath).version).toBe(18);

    const directoryPath = join(root, "install-ops.db");
    await mkdir(directoryPath);
    const directoryRuntime = trackRuntime(
      ManagedRuntime.make(makeInstallOpsLive(directoryPath)),
    );
    await expectDeferred(directoryRuntime, directoryPath);
    expect((await lstat(directoryPath)).isDirectory()).toBe(true);
    expect(await readFile(productPath)).toEqual(productBytes);
  });
});

describe("install-ops exact read-only fingerprint", () => {
  it("rejects a case-changed CHECK schema that a lowercase SQL comparison would admit", async () => {
    const root = await makeRoot();
    const path = join(root, "install-ops.db");
    const database = new DatabaseSync(path);
    try {
      database.exec(
        INSTALL_OPS_SCHEMA_SQL.replace("'pending'", "'PENDING'")
          .replace("'complete'", "'COMPLETE'"),
      );
      database.exec(`PRAGMA user_version = ${INSTALL_OPS_SCHEMA_VERSION}`);
    } finally {
      database.close();
    }
    await chmod(path, 0o600);
    const before = await snapshotFamily(path);

    const runtime = trackRuntime(ManagedRuntime.make(makeInstallOpsLive(path)));
    await expectDeferred(runtime, path);
    await expectFamilyUnchanged(path, before);
  });

  it("rejects an exact schema with the wrong application id without changing bytes", async () => {
    const root = await makeRoot();
    const path = join(root, "install-ops.db");
    seedInstallOpsDatabase(path);
    const database = new DatabaseSync(path);
    try {
      database.exec("PRAGMA application_id = 1447382095");
    } finally {
      database.close();
    }
    await chmod(path, 0o600);
    const before = await snapshotFamily(path);

    const runtime = trackRuntime(ManagedRuntime.make(makeInstallOpsLive(path)));
    await expectDeferred(runtime, path);
    await expectFamilyUnchanged(path, before);
  });

  it("rejects physical corruption behind an exact schema without recovery writes", async () => {
    const root = await makeRoot();
    const path = join(root, "install-ops.db");
    seedInstallOpsDatabase(path, { id: "test.corrupt", status: "pending" });
    await chmod(path, 0o600);
    const corrupted = Buffer.from(await readFile(path));
    expect(corrupted.length).toBeGreaterThan(4_097);
    corrupted[4_097] = (corrupted[4_097] ?? 0) ^ 0xff;
    await writeFile(path, corrupted, { mode: 0o600 });
    const before = await snapshotFamily(path);

    const runtime = trackRuntime(ManagedRuntime.make(makeInstallOpsLive(path)));
    await expectDeferred(runtime, path);
    await expectFamilyUnchanged(path, before);
  });
});

describe("install-ops live family revalidation", () => {
  for (const suffix of FAMILY_SUFFIXES) {
    for (const operation of ["ensurePending", "markComplete"] as const) {
      it(`fails closed when ${suffix || "main"} is replaced between operations before ${operation}`, async () => {
        const root = await makeRoot();
        const productPath = await seedProductFamily(root);
        const opsPath = join(root, "install-ops.db");
        const runtime = trackRuntime(
          ManagedRuntime.make(makeInstallOpsLive(opsPath)),
        );
        const service = await runtime.runPromise(InstallOpsService);
        expect(service.availability).toEqual({ status: "available" });
        await runtime.runPromise(service.ensurePending("test.live-swap"));
        await expectNoOpsSidecars(opsPath);

        let displacedPath: string | undefined;
        const attackPath = `${opsPath}${suffix}`;
        if (suffix === "") {
          displacedPath = `${opsPath}.admitted`;
          await rename(opsPath, displacedPath);
        }
        await link(productPath, attackPath);
        const productBefore = await snapshotFamily(productPath);
        const entriesBefore = (await readdir(root)).sort();
        const displacedBefore = displacedPath === undefined
          ? undefined
          : await readFile(displacedPath);

        const effect = operation === "ensurePending"
          ? service.ensurePending("test.after-swap")
          : service.markComplete("test.live-swap", 5);
        await expect(runtime.runPromise(effect)).rejects.toMatchObject({
          _tag: "InstallOpsDeferredError",
          operation,
          path: opsPath,
        });
        expect(service.availability).toMatchObject({
          status: "unavailable",
          reason: { _tag: "InstallOpsDeferredError", operation },
        });
        await expect(
          runtime.runPromise(service.getBackfill("test.live-swap")),
        ).rejects.toMatchObject({
          _tag: "InstallOpsDeferredError",
          operation: "getBackfill",
        });

        await expectFamilyUnchanged(productPath, productBefore);
        await expectProductFacts(productPath);
        expect((await readdir(root)).sort()).toEqual(entriesBefore);
        expect((await lstat(attackPath)).nlink).toBe(2);
        if (displacedPath !== undefined) {
          expect(await readFile(displacedPath)).toEqual(displacedBefore);
        }
      });
    }
  }
});

describe("install-ops degraded runtime acquisition", () => {
  it("opens product state and content with a corrupt ledger, then retries a repaired ledger next boot", async () => {
    const root = await makeRoot();
    const stateDirectory = join(root, "state");
    const productPath = join(stateDirectory, "vellum-command.db");
    const opsPath = join(stateDirectory, "install-ops.db");
    const contentRoot = join(root, "content");
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(opsPath, "not sqlite", { mode: 0o600 });

    const makeRuntime = () =>
      trackRuntime(
        ManagedRuntime.make(
          Layer.provideMerge(
            makeContentServiceLive({ root: contentRoot }),
            Layer.mergeAll(
              makeStateEngineLive(productPath),
              makeInstallOpsLive(opsPath),
            ),
          ),
        ),
      );

    const firstRuntime = makeRuntime();
    const [state, content] = await Promise.all([
      firstRuntime.runPromise(StateEngine),
      firstRuntime.runPromise(ContentService),
    ]);
    expect(state.info.schemaVersion).toBe(CURRENT_STATE_SCHEMA_VERSION);
    await expect(
      firstRuntime.runPromise(
        state.read("test.product-open", (reader) =>
          reader.get<{ readonly answer: number }>("SELECT 42 AS answer")
        ),
      ),
    ).resolves.toEqual({ answer: 42 });
    expect(content).toBeDefined();
    await expectDeferred(firstRuntime, opsPath);
    expect(console.error).toHaveBeenCalledWith(
      "[content] inline media backfill deferred to next boot:",
      expect.objectContaining({ name: "InlineMediaMigrationError" }),
    );

    await disposeRuntime(firstRuntime);
    await rm(opsPath);

    const secondRuntime = makeRuntime();
    const secondState = await secondRuntime.runPromise(StateEngine);
    const secondOps = await secondRuntime.runPromise(InstallOpsService);
    expect(secondState.info.schemaVersion).toBe(CURRENT_STATE_SCHEMA_VERSION);
    expect(secondOps.availability).toEqual({ status: "available" });
    await secondRuntime.runPromise(secondOps.ensurePending("test.retry"));
    await secondRuntime.runPromise(secondOps.markComplete("test.retry", 3));
    await expect(
      secondRuntime.runPromise(secondOps.getBackfill("test.retry")),
    ).resolves.toMatchObject({
      status: "complete",
      objectsIngested: 3,
    });
    await expect(
      secondRuntime.runPromise(
        secondOps.getBackfill(BACKFILL_INLINE_MEDIA_V1),
      ),
    ).resolves.toMatchObject({ status: "complete" });
    await expectNoOpsSidecars(opsPath);
  });

  it("degrades on an unsupported ledger schema without changing its bytes", async () => {
    const root = await makeRoot();
    const productPath = join(root, "vellum-command.db");
    const opsPath = join(root, "install-ops.db");
    seedOperatorDatabase(opsPath, 2);
    await chmod(opsPath, 0o600);
    const bytesBefore = await readFile(opsPath);

    const runtime = trackRuntime(
      ManagedRuntime.make(
        Layer.mergeAll(
          makeStateEngineLive(productPath),
          makeInstallOpsLive(opsPath),
        ),
      ),
    );
    const state = await runtime.runPromise(StateEngine);
    expect(state.info.schemaVersion).toBe(CURRENT_STATE_SCHEMA_VERSION);
    await expectDeferred(runtime, opsPath);
    expect(await readFile(opsPath)).toEqual(bytesBefore);
    expect(readOperatorFacts(opsPath)).toEqual({
      version: 2,
      tables: ["operator_canary"],
      canary: "preserve-me",
    });
  });
});
