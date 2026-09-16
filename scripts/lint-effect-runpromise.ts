#!/usr/bin/env bun
/**
 * S0 fitness gate — ban bare Effect.runPromise under product main.
 *
 * Product interior must run Effects through a warm ManagedRuntime
 * (AppRuntime / RemoteRuntime). Bare Effect.runPromise starts with empty
 * Context and is how claim paths silently lost ContentService.
 *
 * Rules:
 * 1. Scan product main TypeScript sources for bare `Effect.runPromise` call
 *    sites (comments ignored).
 * 2. Each file with hits must appear in permanent allowlist OR debt baseline
 *    at `scripts/effect-runpromise-allowlist.json`, with count ≤ maxCount.
 * 3. permanent = true host/post-dispose adapters only.
 * 4. debt = known product debt (ratchet: counts may only shrink).
 * 5. permanent must never include kernel/** or work claim service paths.
 *
 * Run: `bun run lint:effect-runpromise`
 * Exit 0 = clean; exit 1 = violations printed.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ALLOWLIST_REL = "scripts/effect-runpromise-allowlist.json";
const PRODUCT_ROOT_REL = "src/main";

const CALL_PATTERN = /Effect\.runPromise\b/;

/** Paths that must never appear under permanent (S2 territory). */
const FORBIDDEN_PERMANENT_PREFIXES = [
  "src/main/junto/kernel/",
  "src/main/junto/work/",
] as const;

type AllowEntry = {
  readonly path: string;
  readonly maxCount: number;
  readonly reason: string;
};

type Allowlist = {
  readonly permanent: ReadonlyArray<AllowEntry>;
  readonly debt: ReadonlyArray<AllowEntry>;
};

type Hit = { readonly file: string; readonly line: number; readonly text: string };

const isTsSource = (name: string): boolean =>
  (name.endsWith(".ts") || name.endsWith(".tsx")) &&
  !name.endsWith(".test.ts") &&
  !name.endsWith(".test.tsx") &&
  !name.endsWith(".spec.ts") &&
  !name.endsWith(".spec.tsx") &&
  !name.endsWith(".d.ts");

const walk = async (dir: string): Promise<ReadonlyArray<string>> => {
  const entries = await readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (
        entry.name === "node_modules" ||
        entry.name === "out" ||
        entry.name === "dist" ||
        entry.name.startsWith(".")
      ) {
        continue;
      }
      out.push(...(await walk(full)));
      continue;
    }
    if (entry.isFile() && isTsSource(entry.name)) out.push(full);
  }
  return out;
};

const stripLineComment = (line: string): string => {
  // naive but sufficient: ignore // comments; do not treat URLs as comments
  const idx = line.indexOf("//");
  if (idx === -1) return line;
  // keep if // is inside a string — good enough: if no quote before //, strip
  const before = line.slice(0, idx);
  const singles = (before.match(/'/g) ?? []).length;
  const doubles = (before.match(/"/g) ?? []).length;
  const backticks = (before.match(/`/g) ?? []).length;
  if (singles % 2 === 1 || doubles % 2 === 1 || backticks % 2 === 1) return line;
  return before;
};

const isCommentOnlyLine = (line: string): boolean => {
  const t = line.trim();
  return (
    t.length === 0 ||
    t.startsWith("//") ||
    t.startsWith("*") ||
    t.startsWith("/*") ||
    t.startsWith("*/")
  );
};

const scanFile = async (absPath: string, rel: string): Promise<ReadonlyArray<Hit>> => {
  const text = await readFile(absPath, "utf8");
  const hits: Hit[] = [];
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    if (isCommentOnlyLine(raw)) continue;
    const code = stripLineComment(raw);
    if (!CALL_PATTERN.test(code)) continue;
    hits.push({ file: rel, line: i + 1, text: raw.trim().slice(0, 160) });
  }
  return hits;
};

const loadAllowlist = async (): Promise<Allowlist> => {
  const abs = path.join(ROOT, ALLOWLIST_REL);
  const raw = JSON.parse(await readFile(abs, "utf8")) as Allowlist;
  if (!Array.isArray(raw.permanent) || !Array.isArray(raw.debt)) {
    throw new Error(`${ALLOWLIST_REL}: expected { permanent: [], debt: [] }`);
  }
  return raw;
};

const indexEntries = (
  entries: ReadonlyArray<AllowEntry>,
): Map<string, AllowEntry> => {
  const map = new Map<string, AllowEntry>();
  for (const entry of entries) {
    if (map.has(entry.path)) {
      throw new Error(`duplicate allowlist path: ${entry.path}`);
    }
    if (!Number.isInteger(entry.maxCount) || entry.maxCount < 1) {
      throw new Error(`invalid maxCount for ${entry.path}`);
    }
    if (!entry.reason || entry.reason.trim().length === 0) {
      throw new Error(`missing reason for ${entry.path}`);
    }
    map.set(entry.path, entry);
  }
  return map;
};

const main = async (): Promise<number> => {
  const productRoot = path.join(ROOT, PRODUCT_ROOT_REL);
  const st = await stat(productRoot);
  if (!st.isDirectory()) {
    console.error(`missing product root: ${PRODUCT_ROOT_REL}`);
    return 1;
  }

  const allowlist = await loadAllowlist();
  const permanent = indexEntries(allowlist.permanent);
  const debt = indexEntries(allowlist.debt);

  // Hard law: permanent must never cover kernel or work claim plane.
  const permanentViolations: string[] = [];
  for (const p of permanent.keys()) {
    if (
      FORBIDDEN_PERMANENT_PREFIXES.some(
        (prefix) => p === prefix.slice(0, -1) || p.startsWith(prefix),
      )
    ) {
      permanentViolations.push(
        `${p} — permanent allowlist must never include kernel/ or work/ (S2 territory)`,
      );
    }
  }
  // Overlap permanent ∩ debt is forbidden (one home only).
  for (const p of permanent.keys()) {
    if (debt.has(p)) {
      permanentViolations.push(`${p} — listed in both permanent and debt`);
    }
  }
  if (permanentViolations.length > 0) {
    console.error("effect-runpromise allowlist policy violations:");
    for (const v of permanentViolations) console.error(`  - ${v}`);
    return 1;
  }

  const files = await walk(productRoot);
  const hitsByFile = new Map<string, Hit[]>();
  for (const abs of files) {
    const rel = path.relative(ROOT, abs).split(path.sep).join("/");
    const hits = await scanFile(abs, rel);
    if (hits.length > 0) hitsByFile.set(rel, [...hits]);
  }

  const violations: string[] = [];
  const seen = new Set<string>();

  for (const [file, hits] of [...hitsByFile.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    seen.add(file);
    const entry = permanent.get(file) ?? debt.get(file);
    if (entry === undefined) {
      violations.push(
        `${file}: ${hits.length} bare Effect.runPromise (not on permanent or debt allowlist)`,
      );
      for (const h of hits) {
        violations.push(`    L${h.line}: ${h.text}`);
      }
      continue;
    }
    if (hits.length > entry.maxCount) {
      const bucket = permanent.has(file) ? "permanent" : "debt";
      violations.push(
        `${file}: ${hits.length} hits > maxCount ${entry.maxCount} (${bucket}: ${entry.reason})`,
      );
      for (const h of hits) {
        violations.push(`    L${h.line}: ${h.text}`);
      }
    }
  }

  // Stale entries: allowlist path with zero hits — debt must shrink, not linger empty.
  // Permanent with zero hits is also a problem (dead allowlist).
  for (const [file, entry] of [...permanent.entries(), ...debt.entries()]) {
    if (seen.has(file)) continue;
    violations.push(
      `${file}: allowlisted (maxCount ${entry.maxCount}) but no bare Effect.runPromise found — remove stale entry`,
    );
  }

  if (violations.length > 0) {
    console.error("effect-runpromise fitness gate FAILED:");
    for (const v of violations) console.error(`  ${v}`);
    console.error(
      `\nAllowlist: ${ALLOWLIST_REL}\nPermanent = host/post-dispose only. Debt may shrink (lower maxCount) but not grow. Kernel/work claim paths must never be permanent.`,
    );
    return 1;
  }

  const permanentCount = [...hitsByFile.entries()]
    .filter(([f]) => permanent.has(f))
    .reduce((n, [, h]) => n + h.length, 0);
  const debtCount = [...hitsByFile.entries()]
    .filter(([f]) => debt.has(f))
    .reduce((n, [, h]) => n + h.length, 0);

  console.log(
    `ok effect-runpromise: ${hitsByFile.size} files, ${permanentCount} permanent + ${debtCount} debt call sites (≤ allowlist max)`,
  );
  return 0;
};

const code = await main();
process.exit(code);
