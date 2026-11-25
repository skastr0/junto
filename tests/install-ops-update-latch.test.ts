import { randomUUID } from "node:crypto";
import { chmod, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  InstallOpsService,
  makeInstallOpsLive,
} from "../src/core/install-ops/engine";
import { INSTALL_OPS_V1_SCHEMA_SQL, INSTALL_OPS_V2_SCHEMA_SQL } from "../src/core/install-ops/schema";

const homes: string[] = [];
const runtimes: Array<ManagedRuntime.ManagedRuntime<any, unknown>> = [];

const makePath = async (): Promise<string> => {
  const home = join(tmpdir(), `junto-install-ops-latch-${randomUUID()}`);
  homes.push(home);
  await rm(home, { recursive: true, force: true });
  await mkdir(home, { recursive: true, mode: 0o700 });
  await chmod(home, 0o700);
  return join(home, "install-ops.db");
};

afterEach(async () => {
  while (runtimes.length > 0) await runtimes.pop()!.dispose();
  while (homes.length > 0) await rm(homes.pop()!, { recursive: true, force: true });
});

const seed = async (path: string, version: 1 | 2): Promise<void> => {
  const database = new DatabaseSync(path);
  try {
    database.exec(version === 1 ? INSTALL_OPS_V1_SCHEMA_SQL : INSTALL_OPS_V2_SCHEMA_SQL);
    database.exec("PRAGMA application_id = 0");
    database.exec(`PRAGMA user_version = ${version}`);
    database.exec(
      "INSERT INTO backfill_markers(id, status, objects_ingested, completed_at) VALUES ('kept.v1', 'complete', 7, '2026-01-01T00:00:00.000Z')",
    );
    if (version === 2) {
      database.exec(
        `INSERT INTO machine_update_latches(machine_name, target_build, outcome, at) VALUES ('mini', '${"b".repeat(64)}', 'activated', '2026-01-01T00:00:00.000Z')`,
      );
    }
  } finally {
    database.close();
  }
  return chmod(path, 0o600);
};

describe("install-ops update latch", () => {
  it("migrates a version 1 ledger forward without touching its rows", async () => {
    const path = await makePath();
    await seed(path, 1);
    const runtime = ManagedRuntime.make(makeInstallOpsLive(path));
    runtimes.push(runtime);
    const service = await runtime.runPromise(InstallOpsService);

    expect(await Effect.runPromise(service.getBackfill("kept.v1"))).toMatchObject({
      id: "kept.v1",
      status: "complete",
      objectsIngested: 7,
    });
    expect(await Effect.runPromise(service.updateLatch("mini-install"))).toBeUndefined();

    const database = new DatabaseSync(path);
    try {
      const version = database.prepare("PRAGMA user_version").get() as { readonly user_version: number };
      expect(version.user_version).toBe(3);
      const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all() as Array<{ readonly name: string }>;
      expect(tables.map(row => row.name)).toEqual(["backfill_markers", "machine_update_attempts", "machine_update_latches"]);
    } finally {
      database.close();
    }
  });

  it("keeps a version 2 ledger's rows while adding the keyed attempt table", async () => {
    const path = await makePath();
    await seed(path, 2);
    const runtime = ManagedRuntime.make(makeInstallOpsLive(path));
    runtimes.push(runtime);
    const service = await runtime.runPromise(InstallOpsService);

    expect(await Effect.runPromise(service.getBackfill("kept.v1"))).toMatchObject({ status: "complete", objectsIngested: 7 });
    expect(await Effect.runPromise(service.updateLatch("mini-install"))).toBeUndefined();

    const database = new DatabaseSync(path);
    try {
      expect((database.prepare("PRAGMA user_version").get() as { readonly user_version: number }).user_version).toBe(3);
      expect(database.prepare("SELECT machine_name, outcome FROM machine_update_latches").all()).toEqual([{ machine_name: "mini", outcome: "activated" }]);
      expect(database.prepare("SELECT count(*) AS count FROM machine_update_attempts").get()).toEqual({ count: 0 });
    } finally {
      database.close();
    }
  });

  it("latches an attempt by installation id and clears it", async () => {
    const path = await makePath();
    const runtime = ManagedRuntime.make(makeInstallOpsLive(path));
    runtimes.push(runtime);
    const service = await runtime.runPromise(InstallOpsService);
    const latch = {
      installationId: "mini-install",
      targetBuild: "a".repeat(64),
      outcome: "rolled-back" as const,
      at: "2026-01-02T00:00:00.000Z",
    };

    await Effect.runPromise(service.recordUpdateLatch(latch));
    expect(await Effect.runPromise(service.updateLatch("mini-install"))).toEqual(latch);
    await Effect.runPromise(service.recordUpdateLatch({ ...latch, outcome: "activated" }));
    expect(await Effect.runPromise(service.updateLatch("mini-install"))).toMatchObject({ outcome: "activated" });
    await Effect.runPromise(service.clearUpdateLatch("mini-install"));
    expect(await Effect.runPromise(service.updateLatch("mini-install"))).toBeUndefined();
  });
});
