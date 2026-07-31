import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { describe, expect, test } from "vitest";

const root = process.cwd();
const allowed = new Set([
  // Packaging-only in-memory ABI probe; never opens product state.
  "scripts/audit-linux-package.ts",
  "scripts/electron-sqlite-smoke.mjs",
  "src/main/vellum/state/backup.ts",
  "src/main/vellum/state/engine.ts",
  "src/main/vellum/state/migrations.ts",
  "src/main/vellum/state/recovery.ts",
  "src/main/vellum/state/schema-identity.ts",
  // Read-only pre-AppRuntime probe for newer-than-supported schema recovery.
  "src/main/vellum/state/schema-version-probe.ts",
  "src/main/vellum/state/update-candidate.ts",
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
