#!/usr/bin/env bun
/**
 * Count, and in the end forbid, every name of the removed canvas document.
 *
 * Junto was once a JSON Canvas file with an `ether` extension bag. That is
 * gone: the app is modelled directly (`src/shared/model/`). While the removal
 * is under way this prints how many files in each area still name the old
 * thing, so the work left is a number. Once it reaches zero the same check
 * runs with `--enforce` in `bun run verify` and the names cannot come back.
 *
 * Run: `bun run lint:no-canvas-document` (add `--enforce` to fail, `--files`
 * to list every file).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const NAMES: ReadonlyArray<readonly [label: string, pattern: RegExp]> = [
  ["ether", /\bether(?:_json)?\b|\bEther[A-Z]\w*/],
  ["CanvasDoc", /\bCanvasDoc\b/],
  ["readCanvas / writeCanvas", /\b(?:read|write)Canvas\b/],
  ["state$.doc", /\bstate\$\.doc\b/],
  ["old canvas tables", /\bcanvas_(?:nodes|edges|documents|entities|portfolio_head)\b/],
  ["JSON Canvas", /JSON Canvas|jsoncanvas/i],
  // The temporary bridges: a caller of one still thinks in documents even
  // when it names none of the words above.
  ["document seeds", /\b(?:canvasDoc|crewDoc|seedCanvases|installFixtureDocument|writeFixtureDocument|readFixtureDocument|writeFixtureCanvas|crewWriteCanvas|crewMutateCanvas)\b/],
  ["document converters", /\b(?:nodeToDocument|nodeFromDocument|nodesFromDocument|canvasFromDocument|documentEdits|commitDoc|documentNodeAt|useDocumentNode)\b/],
];

/**
 * Files that must name the old thing to do their job: the step that drops the
 * old tables, the note that tells agents it is gone, and this check.
 */
const ALLOWED = new Set([
  "AGENTS.md",
  "scripts/lint-no-canvas-document.ts",
  "src/main/junto/state/migrations.ts",
  // The one-time reading of rows an old database holds.
  "src/main/junto/model/migrate.ts",
  "src/shared/model/from-legacy-row.ts",
  // Tests of that one-time reading and of what old databases held.
  "tests/model-legacy-row.test.ts",
  "tests/model-kind-migration.test.ts",
  "tests/model-installed-migration.test.ts",
  "tests/state-v1-fixture-migration.test.ts",
  "tests/audit-retired-state-signatures.test.ts",
  "tests/token-pressure-retired-data.test.ts",
  // The preview check, which reads an old database's tables to compare them
  // with what replaced them.
  "scripts/preview-db-check.ts",
  "tests/preview-state.test.ts",
  // The old shapes, kept for migration tests; no product source imports them.
  "tests/fixtures/frozen-canvas-types.ts",
  "tests/helpers/authorial-material.ts",
  // Guards that name the old word only to forbid it in output.
  "tests/overseer-canvas-commands.test.ts",
  "tests/rts-control-placement.test.tsx",
  "tests/overseer-control.test.ts",
  "tests/overseer-cli.test.ts",
  "tests/terminal-actor-entry-architecture.test.ts",
]);

/**
 * Things that stay exactly as they were written, old names included: old
 * databases written out for the migration tests, and the two below.
 */
const ALLOWED_DIRS = [
  "tests/fixtures/state-v1/",
  // Records of measurements taken while the old document still existed.
  "docs/research/",
  "tests/fixtures/domain-cutover",
];

const TEXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|css|sh|sql|yml|yaml|html)$/;

const areaOf = (file: string): string => {
  if (/\.test\.tsx?$/.test(file) || file.startsWith("tests/")) return "tests";
  if (file.startsWith("e2e/")) return "e2e";
  for (const area of ["src/renderer", "src/main", "src/shared", "src/cli", "src/preload"]) {
    if (file.startsWith(`${area}/`)) return area;
  }
  if (file.startsWith("scripts/")) return "scripts";
  if (file.endsWith(".md")) return "docs";
  return "other";
};

const tracked = Bun.spawnSync(["git", "ls-files"], { cwd: ROOT })
  .stdout.toString()
  .split("\n")
  .filter(
    (file) =>
      TEXT.test(file) && !ALLOWED.has(file) && !ALLOWED_DIRS.some((dir) => file.startsWith(dir)),
  );

const hits = new Map<string, Map<string, Array<string>>>();
let total = 0;
for (const file of tracked) {
  let text: string;
  try {
    text = readFileSync(path.join(ROOT, file), "utf8");
  } catch {
    continue;
  }
  const found = NAMES.filter(([, pattern]) => pattern.test(text)).map(([label]) => label);
  if (found.length === 0) continue;
  total += 1;
  const area = areaOf(file);
  for (const label of found) {
    const byArea = hits.get(label) ?? new Map<string, Array<string>>();
    byArea.set(area, [...(byArea.get(area) ?? []), file]);
    hits.set(label, byArea);
  }
}

const listFiles = process.argv.includes("--files");
const enforce = process.argv.includes("--enforce");

if (total === 0) {
  console.log("lint:no-canvas-document — clean");
  process.exit(0);
}

console.log(`lint:no-canvas-document — ${total} files still name the removed canvas document`);
for (const [label] of NAMES) {
  const byArea = hits.get(label);
  if (!byArea) continue;
  const areas = [...byArea.entries()].sort((a, b) => b[1].length - a[1].length);
  const count = areas.reduce((sum, [, files]) => sum + files.length, 0);
  console.log(`\n${label}: ${count} files`);
  for (const [area, files] of areas) {
    console.log(`  ${String(files.length).padStart(4)}  ${area}`);
    if (listFiles) for (const file of files) console.log(`          ${file}`);
  }
}
process.exit(enforce ? 1 : 0);
