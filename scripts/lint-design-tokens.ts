#!/usr/bin/env bun
/**
 * Design token ratchet. A visual value a theme could want to change comes
 * from a token (src/shared/theme, built into theme.generated.css), never
 * from a literal in a component or a stylesheet.
 *
 * The renderer still carries literals from before the tokens existed, so
 * this gate is a ratchet: scripts/design-token-baseline.json records how
 * many each file holds per rule, and the gate fails when a file's count
 * rises. A file the baseline does not name starts at zero.
 *
 *   bun run lint:design-tokens            check
 *   bun run lint:design-tokens --update   lower the baseline to today's
 *                                         counts (it never raises one)
 *   bun run lint:design-tokens --report   totals per rule, and per top folder
 *
 * Exit 0 = no count rose; exit 1 = violations with file and line.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_ROOT = "src/renderer";
const BASELINE = path.join(ROOT, "scripts/design-token-baseline.json");

// The build output of the token source: the one file where values are born.
const EXEMPT_FILES = new Set(["src/renderer/styles/theme.generated.css"]);

export const RULES = ["font-size", "font-family", "tracking", "leading", "radius", "color"] as const;
export type Rule = (typeof RULES)[number];

/** What to write instead, shown with every failure. */
const REMEDY: Record<Rule, string> = {
  "font-size": "use a size token: text-label, text-body, text-body-lg, text-title, or var(--text-*)",
  "font-family": "use font-mono or font-display, or var(--font-mono) / var(--font-display)",
  tracking: "use tracking-flat, tracking-label, tracking-eyebrow, or var(--tracking-*)",
  leading: "use leading-compact, leading-body, or var(--leading-*)",
  radius: "do not add a new raw radius; reuse a ui primitive until radius tokens land",
  color: "use a color token: text-ink, bg-raise, var(--color-*)",
};

type Pattern = { readonly rule: Rule; readonly re: RegExp };

// A value passes when it is a token (var(...)), a keyword, or carries no
// length of its own. Everything else is a literal.
const CSS_PATTERNS: readonly Pattern[] = [
  { rule: "font-size", re: /(?<![\w-])font-size:(?!\s*var\()[^;{}]*\d(?:px|rem|pt)\b/g },
  { rule: "font-family", re: /(?<![\w-])font-family:(?!\s*(?:var\(|inherit\b))[^;{}]+/g },
  { rule: "tracking", re: /(?<![\w-])letter-spacing:(?!\s*(?:var\(|normal\b|inherit\b|0\s*[;}]))[^;{}]+/g },
  { rule: "leading", re: /(?<![\w-])line-height:(?!\s*(?:var\(|normal\b|inherit\b|[01]\s*[;}]))[^;{}]+/g },
  { rule: "radius", re: /(?<![\w])border(?:-[a-z]+){0,2}-radius:(?!\s*(?:var\(|inherit\b))[^;{}]*\d(?:px|rem|em)\b/g },
  { rule: "color", re: /#[0-9a-fA-F]{3,8}\b(?=[^{}]*[;}])|\b(?:rgba?|hsla?)\(/g },
];

const SCRIPT_PATTERNS: readonly Pattern[] = [
  { rule: "font-size", re: /\btext-\[[\d.]+(?:px|rem|em|pt)\]|\bfontSize:\s*["'`]?[\d.]/g },
  { rule: "font-family", re: /\bfont-\[[^\]]*[a-zA-Z]{3}[^\]]*\]|\bfontFamily:\s*["'`](?!var\()/g },
  { rule: "tracking", re: /\btracking-\[[^\]]+\]|\bletterSpacing:\s*["'`]?[\d.]/g },
  { rule: "leading", re: /\bleading-\[[^\]]+\]/g },
  { rule: "radius", re: /\brounded(?:-[a-z]{1,2})?-\[[^\]]+\]|\bborderRadius:\s*["'`]?[\d.]/g },
  { rule: "color", re: /#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})\b(?![\w-])|\b(?:rgba?|hsla?)\(/g },
];

export type Hit = { readonly rule: Rule; readonly line: number; readonly text: string };

const stripCssComments = (source: string): string =>
  source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, " "));

/** Every literal in one file's text. `ext` picks the css or the script rules. */
export const scan = (source: string, ext: string): Hit[] => {
  const isCss = ext === ".css";
  const text = isCss ? stripCssComments(source) : source;
  const hits: Hit[] = [];
  for (const { rule, re } of isCss ? CSS_PATTERNS : SCRIPT_PATTERNS) {
    for (const match of text.matchAll(re)) {
      const line = text.slice(0, match.index).split("\n").length;
      hits.push({ rule, line, text: match[0].trim() });
    }
  }
  return hits;
};

type Counts = Partial<Record<Rule, Record<string, number>>>;

const walk = (dir: string, out: string[]): void => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(css|tsx|ts)$/.test(entry.name)) out.push(full);
  }
};

const scanTree = (): Map<string, Hit[]> => {
  const files: string[] = [];
  walk(path.join(ROOT, SCAN_ROOT), files);
  const byFile = new Map<string, Hit[]>();
  for (const full of files.sort()) {
    const rel = path.relative(ROOT, full).split(path.sep).join("/");
    if (EXEMPT_FILES.has(rel)) continue;
    const hits = scan(readFileSync(full, "utf8"), path.extname(full));
    if (hits.length > 0) byFile.set(rel, hits);
  }
  return byFile;
};

const countsOf = (byFile: Map<string, Hit[]>): Counts => {
  const counts: Counts = {};
  for (const [file, hits] of byFile) {
    for (const hit of hits) {
      const rule = (counts[hit.rule] ??= {});
      rule[file] = (rule[file] ?? 0) + 1;
    }
  }
  return counts;
};

const total = (counts: Counts, rule: Rule): number =>
  Object.values(counts[rule] ?? {}).reduce((sum, n) => sum + n, 0);

const readBaseline = (): Counts => {
  try {
    return JSON.parse(readFileSync(BASELINE, "utf8")) as Counts;
  } catch {
    return {};
  }
};

const writeBaseline = (counts: Counts): void => {
  const sorted: Counts = {};
  for (const rule of RULES) {
    const files = counts[rule] ?? {};
    sorted[rule] = Object.fromEntries(
      Object.keys(files)
        .sort()
        .filter((file) => files[file]! > 0)
        .map((file) => [file, files[file]!]),
    );
  }
  writeFileSync(BASELINE, `${JSON.stringify(sorted, null, 2)}\n`);
};

const main = (): void => {
  const args = new Set(process.argv.slice(2));
  const byFile = scanTree();
  const now = countsOf(byFile);
  const baseline = readBaseline();
  const firstRun = Object.keys(baseline).length === 0;

  if (args.has("--report")) {
    for (const rule of RULES) {
      const folders = new Map<string, number>();
      for (const [file, n] of Object.entries(now[rule] ?? {})) {
        const parts = file.split("/");
        const folder = parts.length > 4 ? parts.slice(2, 4).join("/") : parts.slice(2).join("/");
        folders.set(folder, (folders.get(folder) ?? 0) + n);
      }
      console.log(`${rule}: ${total(now, rule)}`);
      for (const [folder, n] of [...folders].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${folder}`);
    }
    return;
  }

  if (args.has("--update")) {
    // Only ever down: a count that rose is a violation to fix, not to record.
    const next: Counts = {};
    for (const rule of RULES) {
      next[rule] = {};
      for (const [file, n] of Object.entries(now[rule] ?? {})) {
        const allowed = firstRun ? n : Math.min(n, baseline[rule]?.[file] ?? 0);
        if (allowed > 0) next[rule]![file] = allowed;
      }
    }
    writeBaseline(next);
    console.log(`lint:design-tokens: baseline ${firstRun ? "recorded" : "lowered"}`);
    for (const rule of RULES) console.log(`  ${rule}: ${total(next, rule)}`);
    return;
  }

  let failed = false;
  for (const rule of RULES) {
    for (const [file, n] of Object.entries(now[rule] ?? {})) {
      const allowed = baseline[rule]?.[file] ?? 0;
      if (n <= allowed) continue;
      failed = true;
      console.error(`${file}: ${rule} literals rose from ${allowed} to ${n}. ${REMEDY[rule]}`);
      for (const hit of byFile.get(file)!.filter((h) => h.rule === rule)) {
        console.error(`  ${file}:${hit.line}  ${hit.text}`);
      }
    }
  }
  if (failed) {
    console.error("\nlint:design-tokens: a file gained a hardcoded visual value. Use the token, do not raise the baseline.");
    process.exit(1);
  }

  const slack = RULES.map((rule) => total(baseline, rule) - total(now, rule));
  const summary = RULES.map((rule) => `${rule} ${total(now, rule)}`).join(", ");
  console.log(`lint:design-tokens ok (${summary})`);
  if (slack.some((n) => n > 0)) {
    console.log("  counts fell below the baseline: run `bun run lint:design-tokens --update` to lock them in");
  }
};

if (import.meta.main) main();
