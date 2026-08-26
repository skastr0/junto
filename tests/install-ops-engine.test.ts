import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import {
  link,
  mkdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sqliteControl = vi.hoisted(() => ({
  execCalls: 0,
  prepareCalls: 0,
  failExecAt: undefined as number | undefined,
  failPrepareAt: undefined as number | undefined,
  onConstruct: undefined as ((path: string) => void) | undefined,
  instances: [] as Array<{ closeCalls: number }>,
}));

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {
    closeCalls = 0;
    private schemaSql: string | undefined;
    private userVersion = 0;

    constructor(path: string) {
      sqliteControl.instances.push(this);
      sqliteControl.onConstruct?.(path);
    }

    exec(sql: string): void {
      sqliteControl.execCalls += 1;
      if (sqliteControl.execCalls === sqliteControl.failExecAt) {
        throw new Error("forced exec setup failure");
      }
      const schema = sql.match(/CREATE TABLE backfill_markers[\s\S]*?\) STRICT;/u);
      if (schema !== null) this.schemaSql = schema[0].replace(/;$/u, "");
      const version = sql.match(/PRAGMA user_version = (\d+)/u);
      if (version?.[1] !== undefined) this.userVersion = Number(version[1]);
    }

    prepare(sql: string) {
      sqliteControl.prepareCalls += 1;
      if (sqliteControl.prepareCalls === sqliteControl.failPrepareAt) {
        throw new Error("forced prepare setup failure");
      }
      return {
        get: () => {
          if (sql.includes("PRAGMA user_version")) {
            return { user_version: this.userVersion };
          }
          if (sql.includes("PRAGMA quick_check")) {
            return { quick_check: "ok" };
          }
          return undefined;
        },
        all: () =>
          this.schemaSql === undefined
            ? []
            : [{
              type: "table",
              name: "backfill_markers",
              tbl_name: "backfill_markers",
              sql: this.schemaSql,
            }],
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
  sqliteControl.onConstruct = undefined;
  sqliteControl.instances.length = 0;
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});

afterEach(async () => {
  vi.restoreAllMocks();
  while (runtimes.length > 0) {
    await runtimes.pop()!.dispose();
  }
  while (homes.length > 0) {
    await rm(homes.pop()!, { recursive: true, force: true });
  }
});

const makeHome = async (): Promise<string> => {
  const home = join(tmpdir(), `vellum-install-ops-engine-${randomUUID()}`);
  homes.push(home);
  await mkdir(home, { recursive: true });
  return home;
};

const openRuntime = async (path?: string) => {
  const databasePath = path ?? join(await makeHome(), "install-ops.db");
  const runtime = ManagedRuntime.make(makeInstallOpsLive(databasePath));
  runtimes.push(runtime);
  return { databasePath, runtime };
};

describe("InstallOpsLive acquisition", () => {
  it("degrades after PRAGMA or schema setup failure and closes exactly once", async () => {
    sqliteControl.failExecAt = 2;
    const { databasePath, runtime } = await openRuntime();

    const service = await runtime.runPromise(InstallOpsService);
    expect(service.availability).toMatchObject({
      status: "unavailable",
      reason: {
        _tag: "InstallOpsDeferredError",
        operation: "acquire",
        path: databasePath,
        cause: { _tag: "InstallOpsError", operation: "open" },
      },
    });
    await expect(
      runtime.runPromise(service.ensurePending("test.backfill")),
    ).rejects.toMatchObject({
      _tag: "InstallOpsDeferredError",
      operation: "ensurePending",
      path: databasePath,
    });
    expect(sqliteControl.instances).toHaveLength(1);
    expect(sqliteControl.instances[0]?.closeCalls).toBe(1);
    expect(console.error).toHaveBeenCalledWith(
      "[install-ops] ledger unavailable; backfills deferred until a later boot:",
      expect.objectContaining({ _tag: "InstallOpsError", operation: "open" }),
    );

    await runtime.dispose();
    runtimes.pop();
    expect(sqliteControl.instances[0]?.closeCalls).toBe(1);
  });

  it("degrades after statement preparation failure and preserves the setup cause", async () => {
    sqliteControl.failPrepareAt = 3;
    const { runtime } = await openRuntime();

    const service = await runtime.runPromise(InstallOpsService);
    expect(service.availability).toMatchObject({
      status: "unavailable",
      reason: {
        _tag: "InstallOpsDeferredError",
        cause: {
          _tag: "InstallOpsError",
          operation: "open",
          message: "forced prepare setup failure",
        },
      },
    });
    await expect(
      runtime.runPromise(service.getBackfill("test.backfill")),
    ).rejects.toMatchObject({
      _tag: "InstallOpsDeferredError",
      operation: "getBackfill",
    });
    expect(sqliteControl.instances[0]?.closeCalls).toBe(1);
  });

  it("closes one successful SQLite acquisition exactly once on release", async () => {
    const { runtime } = await openRuntime();
    const [first, second] = await Promise.all([
      runtime.runPromise(InstallOpsService),
      runtime.runPromise(InstallOpsService),
    ]);
    expect(first).toBe(second);
    expect(first.availability).toEqual({ status: "available" });
    expect(sqliteControl.instances).toHaveLength(1);
    expect(sqliteControl.instances[0]?.closeCalls).toBe(0);

    await runtime.dispose();
    runtimes.pop();
    expect(sqliteControl.instances[0]?.closeCalls).toBe(1);
  });

  it("rejects a symlink and hard link before SQLite construction", async () => {
    const home = await makeHome();
    const target = join(home, "operator-file");
    const linked = join(home, "install-ops.db");
    await writeFile(target, "keep");
    await symlink(target, linked);

    const first = await openRuntime(linked);
    const symlinkService = await first.runtime.runPromise(InstallOpsService);
    expect(symlinkService.availability.status).toBe("unavailable");
    expect(sqliteControl.instances).toHaveLength(0);
    expect(sqliteControl.execCalls).toBe(0);
    expect(await readFile(target, "utf8")).toBe("keep");

    await first.runtime.dispose();
    runtimes.pop();
    await rm(linked);
    await link(target, linked);

    const second = await openRuntime(linked);
    const hardLinkService = await second.runtime.runPromise(InstallOpsService);
    expect(hardLinkService.availability.status).toBe("unavailable");
    expect(sqliteControl.instances).toHaveLength(0);
    expect(sqliteControl.execCalls).toBe(0);
    expect(await readFile(target, "utf8")).toBe("keep");
  });

  it("detects pathname substitution after SQLite opens and before any PRAGMA", async () => {
    const home = await makeHome();
    const path = join(home, "install-ops.db");
    await writeFile(path, "admitted");
    sqliteControl.onConstruct = (openedPath) => {
      unlinkSync(openedPath);
      writeFileSync(openedPath, "replacement");
    };

    const { runtime } = await openRuntime(path);
    const service = await runtime.runPromise(InstallOpsService);
    expect(service.availability.status).toBe("unavailable");
    expect(sqliteControl.instances).toHaveLength(1);
    expect(sqliteControl.execCalls).toBe(0);
    expect(sqliteControl.instances[0]?.closeCalls).toBe(1);
    expect(await readFile(path, "utf8")).toBe("replacement");
  });
});
