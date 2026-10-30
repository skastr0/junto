#!/usr/bin/env bun
/**
 * Product brand lint — the retired Vellum brand mark is forbidden in prose.
 *
 * Public product name is **Junto**. Any word-bounded capital-V `Vellum`
 * token is a violation: bare `Vellum`, `Vellum Command`, and
 * `Vellum-Command` are all retired and must be rewritten.
 *
 * Not in scope (word-boundary / casing; renamed by the sweep commits):
 * - glued camelCase identifiers: JuntoApi, resolveJuntoHome
 * - lowercase paths / bins: ~/.junto/, junto.db, dist/junto
 * - env / package keys: JUNTO_*, @skastr0/junto
 *
 * Run: `bun run lint:product-name`
 * Exit 0 = clean; exit 1 = violations printed.
 */
import { readFile, stat } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** Retired brand mark: any word-bounded capital-V `Vellum` token. */
const BARE_PRODUCT = /\bVellum\b/g;

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
  "package.json",
  "index.html",
]);

/**
 * Line-level allow patterns for technical / non-brand uses that still contain
 * the retired mark. Keep this list tiny — prefer rewriting the prose.
 */
const LINE_ALLOW: readonly RegExp[] = [
  // This file encodes the forbidden token in its pattern source.
  /BARE_PRODUCT|lint-product-name|retired brand mark|retired mark/i,
];

type Hit = { file: string; line: number; text: string };

/**
 * The file set is what git tracks: product source, never a scratch copy or a
 * build output sitting in the checkout (a seat's .amp/in/build once failed
 * this lint from outside the repo). A tracked file under a skipped directory
 * is skipped all the same.
 */
const trackedFiles = (): ReadonlyArray<string> => {
  const listing = execFileSync("git", ["ls-files", "-z"], {
    cwd: ROOT,
    maxBuffer: 64 * 1024 * 1024,
    encoding: "utf8",
  });
  return listing
    .split("\0")
    .filter((rel) => rel.length > 0)
    .filter((rel) => {
      const segments = rel.split("/");
      if (segments.length > 1 && SKIP_DIR_NAMES.has(segments[0]!)) return false;
      return true;
    });
};

const isTextFile = (rel: string): boolean => {
  const base = path.basename(rel);
  // This lint encodes the bare-token pattern on purpose.
  if (rel === "scripts/lint-product-name.ts") return false;
  return TEXT_EXT.has(path.extname(base)) || ROOT_TEXT_FILES.has(base) || base.endsWith(".md");
};

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
  for (const rel of trackedFiles()) {
    if (!isTextFile(rel)) continue;
    const hits = await scanFile(path.join(ROOT, rel));
    allHits.push(...hits);
  }

  if (allHits.length === 0) {
    console.log("lint:product-name — ok (no retired brand mark in prose)");
    return 0;
  }

  console.error(
    `lint:product-name — ${allHits.length} retired brand-name hit(s). Product name is "Junto".\n`,
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
    `\nFix: the product name is "Junto". Rewrite the prose; never reintroduce the retired mark. See AGENTS.md § Product brand.`,
  );
  return 1;
}

process.exit(await main());
