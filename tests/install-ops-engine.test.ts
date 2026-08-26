import { randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sqliteControl = vi.hoisted(() => ({
  execCalls: 0,
  prepareCalls: 0,
  failExecAt: undefined as number | undefined,
  failPrepareAt: undefined as number | undefined,
  instances: [] as Array<{ closeCalls: number }>,
}));

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {
    closeCalls = 0;

    constructor(_path: string) {
      sqliteControl.instances.push(this);
    }

    exec(_sql: string): void {
      sqliteControl.execCalls += 1;
      if (sqliteControl.execCalls === sqliteControl.failExecAt) {
        throw new Error("forced exec setup failure");
      }
    }

    prepare(_sql: string) {
      sqliteControl.prepareCalls += 1;
      if (sqliteControl.prepareCalls === sqliteControl.failPrepareAt) {
        throw new Error("forced prepare setup failure");
      }
      return {
        get: () => undefined,
        run: () => undefined,
      };
    }

    close(): void {
      this.closeCalls += 1;
    }
  },
}));

import {
  InstallOpsService,
  makeInstallOpsLive,
} from "../src/main/vellum/install-ops/engine";

const homes: string[] = [];
const runtimes: Array<ManagedRuntime.ManagedRuntime<any, unknown>> = [];

beforeEach(() => {
  sqliteControl.execCalls = 0;
  sqliteControl.prepareCalls = 0;
  sqliteControl.failExecAt = undefined;
  sqliteControl.failPrepareAt = undefined;
  sqliteControl.instances.length = 0;
});

afterEach(async () => {
  while (runtimes.length > 0) {
    await runtimes.pop()!.dispose();
  }
  while (homes.length > 0) {
    await rm(homes.pop()!, { recursive: true, force: true });
  }
});

const openRuntime = async () => {
  const home = join(tmpdir(), `vellum-install-ops-engine-${randomUUID()}`);
  homes.push(home);
  await mkdir(home, { recursive: true });
  const runtime = ManagedRuntime.make(
    makeInstallOpsLive(join(home, "install-ops.db")),
  );
  runtimes.push(runtime);
  return runtime;
};

describe("InstallOpsLive acquisition", () => {
  it("closes DatabaseSync when PRAGMA or schema setup fails after open", async () => {
    sqliteControl.failExecAt = 2;
    const runtime = await openRuntime();

    await expect(runtime.runPromise(InstallOpsService)).rejects.toMatchObject({
      _tag: "InstallOpsError",
      operation: "open",
    });
    expect(sqliteControl.instances).toHaveLength(1);
    expect(sqliteControl.instances[0]?.closeCalls).toBe(1);
  });

  it("closes DatabaseSync when statement preparation fails after open", async () => {
    sqliteControl.failPrepareAt = 3;
    const runtime = await openRuntime();

    await expect(runtime.runPromise(InstallOpsService)).rejects.toMatchObject({
      _tag: "InstallOpsError",
      operation: "open",
    });
    expect(sqliteControl.instances).toHaveLength(1);
    expect(sqliteControl.instances[0]?.closeCalls).toBe(1);
  });

  it("closes a successfully acquired DatabaseSync exactly once on release", async () => {
    const runtime = await openRuntime();
    await runtime.runPromise(InstallOpsService);
    expect(sqliteControl.instances[0]?.closeCalls).toBe(0);

    await runtime.dispose();
    runtimes.pop();
    expect(sqliteControl.instances[0]?.closeCalls).toBe(1);
  });
});
