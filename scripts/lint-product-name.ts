#!/usr/bin/env bun
/**
 * Product brand lint — bare product token without "Command" is forbidden.
 *
 * Public product name is **Vellum Command**. The capital-V product token must
 * be immediately followed by ` Command` or `-Command` (artifact prefix).
 *
 * Not in scope (word-boundary / casing):
 * - identifiers glued on: VellumCommandApi, resolveVellumCommandHome
 * - lowercase paths / bins: ~/.vellum-command/, vellum-command.db, dist/vellum-command
 * - env / package keys: VELLUM_COMMAND_*, @skastr0/vellum
 * - hyphenated internal protocol/header tokens: X-Vellum-Command-Content-State
 *   (local wire labels, not product brand — do not rename for lint alone)
 *
 * Run: `bun run lint:product-name`
 * Exit 0 = clean; exit 1 = violations printed.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Bare product token: capital-V product word not followed by " Command" or "-Command". */
const BARE_PRODUCT = /\bVellum\b(?! Command)(?!-Command)/g;

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
  // Local design-tooling / agent state — not product brand surfaces.
  ".design-sync",
  ".ds-sync",
  ".atlas",
  ".groundwork",
  ".local",
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
]);

const ROOT_TEXT_FILES = new Set([
  "AGENTS.md",
  "CLAUDE.md",
  "PRODUCT.md",
  "README.md",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "package.json",
  "index.html",
]);

/**
 * Line-level allow patterns for technical / non-brand uses that still contain
 * the bare word. Keep this list tiny — prefer rewriting to "Vellum Command".
 */
const LINE_ALLOW: readonly RegExp[] = [
  // This file encodes the forbidden bare token in its pattern source.
  /BARE_PRODUCT|lint-product-name|bare product token/i,
  // Local/internal header and protocol token labels (not user-facing brand).
  // e.g. X-Vellum-Content-State — keep stable; do not force Vellum Command here.
  /\bX-Vellum-[A-Za-z0-9-]+\b/,
];

type Hit = { file: string; line: number; text: string };

async function* walk(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIR_NAMES.has(ent.name)) continue;
      if (full.includes(`${path.sep}node_modules${path.sep}`)) continue;
      yield* walk(full);
      continue;
    }
    if (!ent.isFile()) continue;
    const ext = path.extname(ent.name);
    const base = path.basename(full);
    const rel = path.relative(ROOT, full);
    // This lint encodes the bare-token pattern on purpose.
    if (rel === `scripts${path.sep}lint-product-name.ts`) {
      continue;
    }
    if (TEXT_EXT.has(ext) || ROOT_TEXT_FILES.has(base) || base.endsWith(".md")) {
      yield full;
    }
  }
}

function isAllowedLine(line: string): boolean {
  return LINE_ALLOW.some((re) => re.test(line));
}

async function scanFile(file: string): Promise<Hit[]> {
  let raw: string;
  try {
    const st = await stat(file);
    if (st.size > 2_000_000) return [];
    raw = await readFile(file, "utf8");
  } catch {
    return [];
  }
  // Skip binary-ish
  if (raw.includes("\0")) return [];

  const hits: Hit[] = [];
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (isAllowedLine(line)) continue;
    BARE_PRODUCT.lastIndex = 0;
    if (BARE_PRODUCT.test(line)) {
      hits.push({
        file: path.relative(ROOT, file),
        line: i + 1,
        text: line.trim().slice(0, 160),
      });
    }
  }
  return hits;
}

async function main(): Promise<number> {
  const allHits: Hit[] = [];
  for await (const file of walk(ROOT)) {
    const hits = await scanFile(file);
    allHits.push(...hits);
  }

  if (allHits.length === 0) {
    console.log("lint:product-name — ok (product brand is fully qualified)");
    return 0;
  }

  console.error(
    `lint:product-name — ${allHits.length} bare product-name hit(s). Product name is "Vellum Command".\n`,
  );
  const byFile = new Map<string, Hit[]>();
  for (const h of allHits) {
    const list = byFile.get(h.file) ?? [];
    list.push(h);
    byFile.set(h.file, list);
  }
  for (const [file, hits] of [...byFile.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    console.error(`${file}:`);
    for (const h of hits.slice(0, 20)) {
      console.error(`  ${h.line}: ${h.text}`);
    }
    if (hits.length > 20) {
      console.error(`  … +${hits.length - 20} more`);
    }
  }
  console.error(
    `\nFix: use "Vellum Command" (or Vellum-Command for artifact names). See AGENTS.md § Product brand.`,
  );
  return 1;
}

process.exit(await main());
