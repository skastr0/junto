import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { describe, expect, test } from "vitest";

const root = process.cwd();
const allowed = new Set([
  "scripts/electron-sqlite-smoke.mjs",
  // Dev-only seed that copies a prod junto.db into an isolated dev tree.
  "scripts/dev-seed-from-prod.ts",
  // Preview tools: a read-only backup of the live junto.db into a separate
  // copy, and a read-only comparison of that copy with its baseline.
  "scripts/preview-db-check.ts",
  "scripts/preview-snapshot.ts",
  "src/core/state/backup.ts",
  "src/core/state/engine.ts",
  "src/core/state/migrations.ts",
  "src/core/state/recovery.ts",
  "src/core/state/schema-identity.ts",
  // Effect SQL adapter receives the owner's connection; it never opens one.
  "src/core/state/sqlite-client.ts",
  // Read-only pre-AppRuntime probe for newer-than-supported schema recovery.
  "src/node/state/schema-version-probe.ts",
  // Install-local ledger (install-ops.db) — not product state; separate opener.
  "src/core/install-ops/engine.ts",
  // Read-only external harness receipts; never Junto product state.
  "src/core/term/read-only-sqlite.ts",
  // The core's read-only connection in its mail read worker, off the main
  // thread; StateEngine stays the only writer (operator ruling 2026-10-30).
  "src/core/work/mail-read-worker.ts",
  "src/core/work/mail-read-sql.ts",
  // The core's maintenance writer, off the main thread: checkpoints and
  // ANALYZE only, never a row (operator ruling 2026-10-30).
  "src/core/state/maintenance-worker.ts",
]);

const filesUnder = (directory: string): string[] => {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...filesUnder(path));
    } else if ([".js", ".mjs", ".ts", ".tsx"].includes(extname(path))) {
      files.push(path);
    }
  }
  return files;
};

describe("StateEngine architecture", () => {
  test("only the scoped engine and its narrow bootstrap helpers touch SQLite", () => {
    const offenders = [
      ...filesUnder(join(root, "src")),
      ...filesUnder(join(root, "scripts")),
    ]
      .filter((path) => {
        const source = readFileSync(path, "utf8");
        return (
          /from\s+["']node:sqlite["']/.test(source) ||
          /\bnew\s+DatabaseSync\s*\(/.test(source)
        );
      })
      .map((path) => relative(root, path))
      .filter((path) => !allowed.has(path))
      .sort();

    expect(offenders).toEqual([]);
  });
});
