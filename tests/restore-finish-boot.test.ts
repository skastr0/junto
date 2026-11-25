/**
 * The installed core's boot step: under its home lock and before the schema
 * probe it runs `junto machine restore-finish` with this core's own JUNTO_HOME
 * and JUNTO_INSTALL_ROOT, never the child's defaults, and reads only the exit
 * code (src/node/hosts/restore-finish.ts, native/cli/src/install/mod.rs).
 * A stand-in junto records what it was given and exits as told.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireHomeLock } from "../src/node/home-lock";
import { owedRestoreMarker, runRestoreFinish } from "../src/node/hosts/restore-finish";
import { startCore } from "../src/core/core";
import { STATE_SCHEMA_SQL } from "../src/core/state/schema";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const root = async (): Promise<string> => {
  const path = await mkdtemp(join(tmpdir(), "junto-restore-finish-"));
  cleanups.push(() => rm(path, { recursive: true, force: true }));
  return path;
};

/** A junto that writes its argv, JUNTO_HOME, JUNTO_INSTALL_ROOT and HOME to `record`, says something on both streams, and exits `code`. */
const standIn = (dir: string, code: number): { junto: string; record: string } => {
  const junto = join(dir, "bin", "junto");
  const record = join(dir, "record");
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(junto, `#!/bin/sh\nprintf '%s\\n' "$*" "$JUNTO_HOME" "$JUNTO_INSTALL_ROOT" "$HOME" > '${record}'\necho '{"ok":true}'\necho 'restore words' >&2\nexit ${code}\n`);
  chmodSync(junto, 0o700);
  return { junto, record };
};

describe("restore-finish at boot", () => {
  it("passes this core's home and install root, not HOME, when JUNTO_HOME differs from it", async () => {
    const base = await root();
    const { junto, record } = standIn(base, 0);
    const home = join(base, "rv-far");
    const installRoot = join(base, "rv-far", ".junto", "machine-elsewhere");
    const outcome = await runRestoreFinish({ junto, home, installRoot, env: { ...process.env, HOME: join(base, "someone-else"), JUNTO_HOME: join(base, "stale"), JUNTO_INSTALL_ROOT: join(base, "stale-root") } });
    expect(outcome).toBe("ready");
    expect(readFileSync(record, "utf8").split("\n").slice(0, 4)).toEqual(["machine restore-finish", home, installRoot, join(base, "someone-else")]);
  });

  it("reads only the exit: 0 goes on, 75 is updating, anything else or no binary refuses", async () => {
    const base = await root();
    const home = join(base, "home");
    for (const [code, outcome] of [[0, "ready"], [75, "updating"], [1, "refused"], [2, "refused"]] as const) {
      const { junto } = standIn(join(base, `exit-${code}`), code);
      expect(await runRestoreFinish({ junto, home, installRoot: join(base, "root") })).toBe(outcome);
    }
    expect(await runRestoreFinish({ junto: join(base, "missing", "junto"), home, installRoot: join(base, "root") })).toBe("refused");
  });
});

describe("a core's boot under the home lock", () => {
  const boot = async (finishRestore: () => Promise<"ready" | "updating" | "refused">) => {
    const home = await root();
    let lockHeldDuringRestore: boolean | undefined;
    const started = startCore({
      home,
      build: "a".repeat(64),
      finishRestore: async () => {
        // The core holds the lock while the step runs: a second holder is refused.
        lockHeldDuringRestore = await acquireHomeLock(home).then(async (lock) => { await lock.release(); return false; }, () => true);
        return finishRestore();
      },
    } as never);
    return { home, started, held: () => lockHeldDuringRestore };
  };

  it.each([["updating", "This machine is updating: an install holds"], ["refused", "could not finish"]] as const)(
    "does not open the database when restore-finish says %s, and lets the home go",
    async (outcome, words) => {
      const { home, started, held } = await boot(async () => outcome);
      await expect(started).rejects.toMatchObject({ _tag: "CoreHomeLocked", message: expect.stringContaining(words) });
      expect(held()).toBe(true);
      expect(existsSync(join(home, ".junto", "state", "junto.db"))).toBe(false);
      await (await acquireHomeLock(home)).release();
    },
  );

  it("runs the step before the schema probe, so a database it restores is the one probed", async () => {
    const { home, started } = await boot(async () => {
      // As a finished restore leaves it: a database from a newer build than this one.
      const { DatabaseSync } = await import("node:sqlite");
      const database = new DatabaseSync(join(home, ".junto", "state", "junto.db"));
      database.exec(STATE_SCHEMA_SQL);
      database.exec("PRAGMA user_version = 100000");
      database.close();
      return "ready";
    });
    await expect(started).rejects.toMatchObject({ _tag: "CoreSchemaTooNew", userVersion: 100000 });
    await (await acquireHomeLock(home)).release();
  });

  it("refuses, with no install root to finish it, a home whose install left a restore owed, and opens no database", async () => {
    const home = await root();
    mkdirSync(join(home, ".junto", "state"), { recursive: true, mode: 0o700 });
    const marker = join(home, ".junto", "state", ".restore-11111111-2222-4333-8444-555555555555.marker");
    writeFileSync(marker, "owed\n");
    await expect(startCore({ home, build: "a".repeat(64) } as never)).rejects.toMatchObject({
      _tag: "CoreHomeLocked", reason: "restore-refused", message: expect.stringContaining(marker),
    });
    expect(existsSync(join(home, ".junto", "state", "junto.db"))).toBe(false);
    expect(existsSync(marker)).toBe(true);
    await (await acquireHomeLock(home)).release();
  });

  it("takes no other name in the state directory for an owed restore", async () => {
    const home = await root();
    mkdirSync(join(home, ".junto", "state"), { recursive: true, mode: 0o700 });
    writeFileSync(join(home, ".junto", "state", ".restore-not-a-uuid.marker"), "");
    expect(owedRestoreMarker(home)).toBeUndefined();
  });
});
