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
import { INSTALL_OPS_V1_SCHEMA_SQL } from "../src/core/install-ops/schema";

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

const seedV1 = async (path: string): Promise<void> => {
  const database = new DatabaseSync(path);
  try {
    database.exec(INSTALL_OPS_V1_SCHEMA_SQL);
    database.exec("PRAGMA application_id = 0");
    database.exec("PRAGMA user_version = 1");
    database.exec(
      "INSERT INTO backfill_markers(id, status, objects_ingested, completed_at) VALUES ('kept.v1', 'complete', 7, '2026-01-01T00:00:00.000Z')",
    );
  } finally {
    database.close();
  }
  return chmod(path, 0o600);
};

describe("install-ops update latch", () => {
  it("migrates a version 1 ledger forward without touching its rows", async () => {
    const path = await makePath();
    await seedV1(path);
    const runtime = ManagedRuntime.make(makeInstallOpsLive(path));
    runtimes.push(runtime);
    const service = await runtime.runPromise(InstallOpsService);

    expect(await Effect.runPromise(service.getBackfill("kept.v1"))).toMatchObject({
      id: "kept.v1",
      status: "complete",
      objectsIngested: 7,
    });
    expect(await Effect.runPromise(service.updateLatch("mini"))).toBeUndefined();

    const database = new DatabaseSync(path);
    try {
      const version = database.prepare("PRAGMA user_version").get() as { readonly user_version: number };
      expect(version.user_version).toBe(2);
      const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all() as Array<{ readonly name: string }>;
      expect(tables.map(row => row.name)).toEqual(["backfill_markers", "machine_update_latches"]);
    } finally {
      database.close();
    }
  });

  it("latches a failed attempt per machine and clears it", async () => {
    const path = await makePath();
    const runtime = ManagedRuntime.make(makeInstallOpsLive(path));
    runtimes.push(runtime);
    const service = await runtime.runPromise(InstallOpsService);
    const latch = {
      machineName: "mini",
      targetBuild: "a".repeat(64),
      outcome: "rolled-back" as const,
      at: "2026-01-02T00:00:00.000Z",
    };

    await Effect.runPromise(service.recordUpdateLatch(latch));
    expect(await Effect.runPromise(service.updateLatch("mini"))).toEqual(latch);
    await Effect.runPromise(service.recordUpdateLatch({ ...latch, outcome: "start-failed" }));
    expect(await Effect.runPromise(service.updateLatch("mini"))).toMatchObject({ outcome: "start-failed" });
    await Effect.runPromise(service.clearUpdateLatch("mini"));
    expect(await Effect.runPromise(service.updateLatch("mini"))).toBeUndefined();
  });
});
