import { randomUUID } from "node:crypto";
import {
  chmod,
  link,
  lstat,
  mkdir,
  readFile,
  readdir,
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
} from "../src/main/vellum/install-ops/engine";
import { ContentService, makeContentServiceLive } from "../src/main/vellum/content/service";
import { StateEngine, makeStateEngineLive } from "../src/main/vellum/state/engine";
import { CURRENT_STATE_SCHEMA_VERSION } from "../src/main/vellum/state/migrations";

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
    runtime.runPromise(service.markComplete("test.backfill", 1)),
  ).rejects.toMatchObject({
    _tag: "InstallOpsDeferredError",
    operation: "markComplete",
    path,
  });
  return service;
};

describe("install-ops filesystem safety", () => {
  it("precreates a missing owner-only single-link database and persists markers", async () => {
    const root = await makeRoot();
    const stateDirectory = join(root, "state");
    const path = join(stateDirectory, "install-ops.db");
    const runtime = trackRuntime(ManagedRuntime.make(makeInstallOpsLive(path)));

    const service = await runtime.runPromise(InstallOpsService);
    expect(service.availability).toEqual({ status: "available" });
    await runtime.runPromise(service.ensurePending("test.backfill"));
    await runtime.runPromise(service.markComplete("test.backfill", 7));
    await expect(
      runtime.runPromise(service.getBackfill("test.backfill")),
    ).resolves.toMatchObject({
      id: "test.backfill",
      status: "complete",
      objectsIngested: 7,
    });

    const directoryInfo = await lstat(stateDirectory);
    const fileInfo = await lstat(path);
    expect(directoryInfo.isDirectory()).toBe(true);
    expect(directoryInfo.mode & 0o777).toBe(0o700);
    expect(fileInfo.isFile()).toBe(true);
    expect(fileInfo.nlink).toBe(1);
    expect(fileInfo.mode & 0o777).toBe(0o600);
  });

  it("admits the exact version 1 schema emitted by the prior opener", async () => {
    const root = await makeRoot();
    const path = join(root, "install-ops.db");
    const prior = new DatabaseSync(path);
    try {
      prior.exec(`
        PRAGMA user_version = 1;
        CREATE TABLE IF NOT EXISTS backfill_markers (
          id TEXT PRIMARY KEY
            CHECK (length(id) BETWEEN 1 AND 128),
          status TEXT NOT NULL
            CHECK (status IN ('pending', 'complete')),
          objects_ingested INTEGER NOT NULL DEFAULT 0
            CHECK (
              typeof(objects_ingested) = 'integer'
              AND objects_ingested >= 0
            ),
          completed_at TEXT
            CHECK (
              completed_at IS NULL
              OR length(completed_at) BETWEEN 1 AND 64
            )
        ) STRICT;
      `);
    } finally {
      prior.close();
    }

    const runtime = trackRuntime(ManagedRuntime.make(makeInstallOpsLive(path)));
    const service = await runtime.runPromise(InstallOpsService);
    expect(service.availability).toEqual({ status: "available" });
    await runtime.runPromise(service.ensurePending("test.prior-schema"));
    await expect(
      runtime.runPromise(service.getBackfill("test.prior-schema")),
    ).resolves.toMatchObject({ status: "pending" });
  });

  it("does not open or mutate a product database reached through a symlink", async () => {
    const root = await makeRoot();
    const productPath = join(root, "vellum-command.db");
    const opsPath = join(root, "install-ops.db");
    seedOperatorDatabase(productPath, 18);
    await chmod(productPath, 0o640);
    const bytesBefore = await readFile(productPath);
    const modeBefore = (await lstat(productPath)).mode & 0o777;
    await symlink("vellum-command.db", opsPath);

    const runtime = trackRuntime(
      ManagedRuntime.make(makeInstallOpsLive(opsPath)),
    );
    await expectDeferred(runtime, opsPath);

    expect(await readFile(productPath)).toEqual(bytesBefore);
    expect((await lstat(productPath)).mode & 0o777).toBe(modeBefore);
    expect(readOperatorFacts(productPath)).toEqual({
      version: 18,
      tables: ["operator_canary"],
      canary: "preserve-me",
    });
    expect((await readdir(root)).sort()).toEqual([
      "install-ops.db",
      "vellum-command.db",
    ]);
  });

  it("does not open or mutate a hard-linked product database", async () => {
    const root = await makeRoot();
    const productPath = join(root, "vellum-command.db");
    const opsPath = join(root, "install-ops.db");
    seedOperatorDatabase(productPath, 18);
    const bytesBefore = await readFile(productPath);
    const modeBefore = (await lstat(productPath)).mode & 0o777;
    await link(productPath, opsPath);

    const runtime = trackRuntime(
      ManagedRuntime.make(makeInstallOpsLive(opsPath)),
    );
    await expectDeferred(runtime, opsPath);

    expect(await readFile(productPath)).toEqual(bytesBefore);
    expect((await lstat(productPath)).mode & 0o777).toBe(modeBefore);
    expect((await lstat(productPath)).nlink).toBe(2);
    expect(readOperatorFacts(productPath)).toEqual({
      version: 18,
      tables: ["operator_canary"],
      canary: "preserve-me",
    });
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

describe("install-ops degraded runtime acquisition", () => {
  it("opens product state and content with a corrupt ledger, then retries a repaired ledger next boot", async () => {
    const root = await makeRoot();
    const stateDirectory = join(root, "state");
    const productPath = join(stateDirectory, "vellum-command.db");
    const opsPath = join(stateDirectory, "install-ops.db");
    const contentRoot = join(root, "content");
    await mkdir(stateDirectory, { recursive: true });
    await writeFile(opsPath, "not sqlite");

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
  });

  it("degrades on an unsupported ledger schema without changing its bytes", async () => {
    const root = await makeRoot();
    const productPath = join(root, "vellum-command.db");
    const opsPath = join(root, "install-ops.db");
    seedOperatorDatabase(opsPath, 2);
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
