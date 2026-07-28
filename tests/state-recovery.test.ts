import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Effect, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import {
  exportStateBackup,
  listStateBackups,
} from "../src/main/vellum/state/recovery";
import {
  makeStateEngineLive,
  StateEngine,
} from "../src/main/vellum/state/engine";

const roots: string[] = [];
const runtimes: Array<
  ManagedRuntime.ManagedRuntime<StateEngine, unknown>
> = [];

afterEach(async () => {
  while (runtimes.length > 0) {
    await runtimes.pop()!.dispose();
  }
  while (roots.length > 0) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

const makeLayout = async () => {
  const root = await mkdtemp(join(tmpdir(), "vellum-state-recovery-"));
  roots.push(root);
  const state = join(root, "state");
  const exports = join(root, "exports");
  await mkdir(state);
  await mkdir(exports);
  return {
    root,
    state,
    database: join(state, "vellum.db"),
    exports,
  };
};

const createBackup = async (database: string) => {
  const runtime = ManagedRuntime.make(makeStateEngineLive(database));
  runtimes.push(runtime);
  const engine = await runtime.runPromise(StateEngine);
  return await runtime.runPromise(engine.backup());
};

describe("state recovery", () => {
  it("lists verified backups and exports one without overwriting", async () => {
    const layout = await makeLayout();
    const created = await createBackup(layout.database);
    const inventory = await Effect.runPromise(
      listStateBackups(layout.database),
    );
    expect(inventory).toHaveLength(1);
    expect(inventory[0]).toMatchObject({
      file: created.path.split("/").at(-1),
      schemaVersion: created.schemaVersion,
      schemaSha256: created.schemaSha256,
    });

    const destination = join(layout.exports, "vellum-export.db");
    const receipt = await Effect.runPromise(
      exportStateBackup(inventory[0]!.id, destination, layout.database),
    );
    expect(receipt.destination).toBe(destination);
    expect(receipt.backup).toEqual(inventory[0]);
    expect(receipt.sha256).toBe(
      createHash("sha256")
        .update(readFileSync(destination))
        .digest("hex"),
    );
    expect(existsSync(destination)).toBe(true);

    await expect(
      Effect.runPromise(
        exportStateBackup(
          inventory[0]!.id,
          destination,
          layout.database,
        ),
      ),
    ).rejects.toThrow(/exist|EEXIST/u);
  });

  it("rejects unsafe backup entries instead of hiding them", async () => {
    const layout = await makeLayout();
    await createBackup(layout.database);
    await symlink(
      join(layout.state, "vellum.db"),
      join(
        layout.state,
        "backups",
        "vellum-backup-22222222-2222-4222-8222-222222222222.db",
      ),
    );

    await expect(
      Effect.runPromise(listStateBackups(layout.database)),
    ).rejects.toThrow(/owner-only regular file/u);
  });

  it("does not create an inventory directory when no backup exists", async () => {
    const layout = await makeLayout();
    await expect(
      Effect.runPromise(listStateBackups(layout.database)),
    ).resolves.toEqual([]);
    expect(existsSync(join(layout.state, "backups"))).toBe(false);
  });
});
