import { mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeProofHome, requireProofHomeStats } from "../scripts/upgrade-proof-analyze";
import { openUpgradeProofHome } from "../scripts/upgrade-proof-open";

/**
 * 0.12.0 passed its upgrade proof and crashed real homes with SQLITE_AUTH:
 * a real install holds sqlite_stat1 (the maintenance worker runs ANALYZE) and
 * a fresh proof home never did. A proof home must carry the stat rows first.
 */

const roots: string[] = [];
const seededHome = (): string => {
  const root = mkdtempSync(join(tmpdir(), "junto-proof-home-"));
  roots.push(root);
  const path = join(root, "junto.db");
  const database = new DatabaseSync(path);
  database.exec(`
    CREATE TABLE items (id TEXT PRIMARY KEY, kind TEXT NOT NULL) STRICT;
    CREATE INDEX items_kind ON items (kind);
    PRAGMA user_version = 79;
  `);
  const insert = database.prepare("INSERT INTO items (id, kind) VALUES (?, ?)");
  for (let n = 0; n < 20; n += 1) insert.run(`i${n}`, n % 2 === 0 ? "a" : "b");
  database.close();
  return path;
};

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("an upgrade-proof home always has sqlite_stat1", () => {
  it("refuses a freshly seeded home that never ran ANALYZE, saying why", () => {
    expect(() => requireProofHomeStats(seededHome())).toThrow(/no sqlite_stat1.*SQLITE_AUTH/u);
  });

  it("prepare runs ANALYZE, fills sqlite_stat1, and leaves the schema version alone", () => {
    const path = seededHome();
    const stats = analyzeProofHome(path);
    expect(stats.userVersion).toBe(79);
    expect(stats.statRows).toBeGreaterThan(0);
    expect(stats.statTables).toBe(1);
    expect(requireProofHomeStats(path)).toEqual(stats);
  });

  it("a home whose stat table is empty fails, so a proof home needs real rows", () => {
    const root = mkdtempSync(join(tmpdir(), "junto-proof-home-"));
    roots.push(root);
    const path = join(root, "junto.db");
    const database = new DatabaseSync(path);
    database.exec("CREATE TABLE items (id TEXT PRIMARY KEY, kind TEXT) STRICT; CREATE INDEX items_kind ON items (kind);");
    database.close();
    expect(() => analyzeProofHome(path)).toThrow(/sqlite_stat1 is empty/u);
  });

  it("refuses the operator's own database and a missing file", () => {
    const home = join(process.env.HOME ?? "", ".junto", "state", "junto.db");
    expect(() => analyzeProofHome(home)).toThrow(/operator's own database/u);
    expect(() => requireProofHomeStats(join(tmpdir(), "junto-proof-nonexistent", "junto.db"))).toThrow(/no database at/u);
  });

  it.skipIf(process.platform !== "linux" || process.arch !== "x64")(
    "the packaged open refuses a home with no stat rows before it launches anything",
    async () => {
      const db = seededHome();
      const root = join(db, "..");
      const state = join(root, "home", ".junto", "state");
      mkdirSync(state, { recursive: true });
      renameSync(db, join(state, "junto.db"));
      await expect(openUpgradeProofHome(root, join(root, "no-package"), 79, "first")).rejects.toThrow(/no sqlite_stat1/u);
    },
  );
});
