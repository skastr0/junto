#!/usr/bin/env bun
/**
 * Forbid U+00B7 MIDDLE DOT in product text surfaces.
 *
 * Operators banned middot staccato from Vellum Command UI and copy. The ban is
 * a PRODUCT rule: it governs strings a user can see (renderer, shared copy,
 * main-process messages, docs). It does not govern tests, e2e, scripts, or the
 * seat-state rule sources, whose job is to byte-match third-party TUI chrome
 * that legitimately prints U+00B7.
 * Run: `bun run lint:no-middot`
 * Exit 0 = clean; exit 1 = violations with file:line.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MIDDOT = "\u00B7";

const SKIP_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  "out",
  "dist",
  "release",
  "test-results",
  "tmp",
  "playwright-report",
  ".turbo",
  ".vite",
  "coverage",
  ".design-sync",
  ".ds-sync",
  ".atlas",
  ".groundwork",
  ".local",
  "_design_screenshots",
]);

const TEXT_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
  ".json",
  ".md",
  ".txt",
  ".html",
  ".css",
  ".scss",
  ".sh",
  ".bash",
  ".zsh",
  ".yml",
  ".yaml",
  ".toml",
  ".svg",
  ".xml",
  ".plist",
  ".service",
  ".desktop",
  ".template",
  ".py",
  ".rs",
  ".go",
  ".rb",
  ".swift",
  ".rhai",
]);

const SKIP_FILE_NAMES = new Set([
  // This lint file and the strip script name the character by design.
  "lint-no-middot.ts",
  "strip-middots.ts",
]);

// Product surfaces only. Tests, e2e, scripts, experiments, and design-sync
// previews transcribe external reality and are out of scope.
const SCAN_ROOTS = ["src", "docs", "assets"];
const ROOT_FILES = ["README.md", "AGENTS.md", "CLAUDE.md", "PRODUCT.md"];

// The one src subtree whose purpose is matching third-party TUI bytes.
const EXEMPT_SUBTREES = [
  path.join("src", "main", "vellum", "term", "agent-state", "rules"),
];

const isExempt = (rel: string): boolean =>
  EXEMPT_SUBTREES.some((sub) => rel === sub || rel.startsWith(sub + path.sep));

const walk = async (dir: string, out: string[]): Promise<void> => {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") && entry.name !== ".github") {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      await walk(full, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (SKIP_FILE_NAMES.has(entry.name)) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!TEXT_EXT.has(ext) && !entry.name.endsWith("Dockerfile")) continue;
    out.push(full);
  }
};

const main = async (): Promise<void> => {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) {
    await walk(path.join(ROOT, root), files);
  }
  for (const name of ROOT_FILES) {
    const full = path.join(ROOT, name);
    try {
      if ((await stat(full)).isFile()) files.push(full);
    } catch {
      // absent root file — fine
    }
  }
  const hits: Array<{ file: string; line: number; text: string }> = [];
  for (const file of files) {
    if (isExempt(path.relative(ROOT, file))) continue;
    let body: string;
    try {
      body = await readFile(file, "utf8");
    } catch {
      continue;
    }
    if (!body.includes(MIDDOT)) continue;
    const rel = path.relative(ROOT, file);
    const lines = body.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.includes(MIDDOT)) {
        hits.push({
          file: rel,
          line: i + 1,
          text: lines[i]!.trim().slice(0, 120),
        });
      }
    }
  }
  if (hits.length === 0) {
    console.log("lint:no-middot — clean");
    process.exit(0);
  }
  console.error(`lint:no-middot — ${hits.length} hit(s) of U+00B7 MIDDLE DOT:\n`);
  for (const hit of hits.slice(0, 200)) {
    console.error(`  ${hit.file}:${hit.line}: ${hit.text}`);
  }
  if (hits.length > 200) {
    console.error(`  … +${hits.length - 200} more`);
  }
  console.error(
    "\nReplace with ASCII separators ( -  /  |  , ). Never reintroduce U+00B7",
  );
  process.exit(1);
};

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
