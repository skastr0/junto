#!/usr/bin/env bun
/**
 * Single-write-seam fitness gate — the factory world has exactly one writer.
 *
 * The operator invariant this encodes: the factory world is an in-memory,
 * event-sourced simulation and SQLite is its append-only journal. A second
 * writer — a second `DatabaseSync`, a mutation statement in a file that is not
 * a declared seam, or two files writing one table — silently forks the source
 * of truth. Nothing in the type system stops any of those, so this gate does,
 * the same way `lint-effect-runpromise.ts` stops a bare `Effect.runPromise`.
 *
 * A decode is the third face of the same defect. `Schema.decodeUnknown*` is an
 * INGRESS operation: it converts foreign bytes into domain values at a
 * boundary. Every decode that is not at a boundary is the process re-validating
 * data it produced itself — the 24 MB/s of strict decode the perf work
 * measured on the read path. So decode sites are registered too, classified by
 * the boundary they guard, and the interior ones carry a retirement condition.
 *
 * Rules:
 * 1. A SQLite driver (`node:sqlite`, `bun:sqlite`, `better-sqlite3`) may only
 *    be imported, and a database only constructed, inside the state engine —
 *    `src/main/vellum/state/**`. Anything else is a second opener and must be
 *    an explicitly listed exception carrying a `retire` condition.
 * 2. Mutation SQL (INSERT / UPDATE / DELETE / REPLACE) may only appear in a
 *    file registered as a mutation seam, and only against tables that file
 *    declares. A table may have exactly one seam owner; a second writer must be
 *    an explicitly listed shared-table exception carrying a `retire` condition.
 * 3. `Schema.decodeUnknown*` may only appear in a file registered as a decode
 *    boundary, tagged with the boundary kind it guards:
 *      wire     — bytes from another process or host (IPC, control socket, HTTP,
 *                 child-process output)
 *      codec    — the module DEFINES the decoder for a boundary and exports it;
 *                 the boundary belongs to the caller
 *      operator — operator-authored input (CLI argv/stdin, settings patch,
 *                 authored canvas payloads, a host or provider key they typed)
 *      constant — validates a literal baked into the bundle, once at module load
 *      row      — INTERIOR: a persisted row decoded back into a domain value
 *      mint     — INTERIOR: branding a value this process just computed
 *    `row` and `mint` are the process re-validating its own output. They are
 *    allowed only with a `retire` condition.
 * 4. The runtime seam must be installed, and every escape from it declared.
 *    `work/mutation-seam.ts` refuses a work projection write that no journal
 *    record in the same transaction explains — rules 1-3 are static and cannot
 *    see ordering, so that half of the law lives at runtime. This rule pins
 *    the wiring (`state/engine.ts` must call it) and pins every call site of
 *    `unjournaledWorkMutation`, the one declared escape, in the register with
 *    a retirement condition. The reason set is closed at the type level in the
 *    seam module and this gate proves the register never drifts from it.
 *    `test.fixture-seed` is forbidden under `src/` outright.
 *
 * THE SEAM DECISION this gate encodes (rule 2, work plane):
 *   `src/main/vellum/work/repository.ts` IS the work-plane mutation seam. It is
 *   the sole writer of the `work_*` tables and it already funnels every domain
 *   operation through one file. It is registered `debt`, NOT `permanent`,
 *   because it writes materialized projection rows directly rather than
 *   appending to a journal. It retires when the in-memory world owns the
 *   projection and this file's only write is the journal append.
 *   Splitting it further today would create MORE writers of `work_*`, which is
 *   the defect this gate exists to prevent — so the answer is "this file is the
 *   seam, and the register pins the table set it owns."
 *
 * Scope: `src/` and `scripts/` for rules 1 and 2 — a dev script that opens the
 * live database read-write while the app runs is the same second writer as a
 * product one. `src/` for rule 3. `tests/` is deliberately out of scope: test
 * fixtures build throwaway databases on purpose, and registering them would
 * grow a list with no safety in it.
 *
 * Run: `bun run lint:single-write-seam`
 * Exit 0 = clean; exit 1 = violations printed with file:line and the rule.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REGISTER_REL = "scripts/single-write-seam-register.json";

/** Rules 1 and 2 scan these roots; rule 3 scans SOURCE_ROOT only. */
const SOURCE_ROOT = "src";
const TOOLING_ROOT = "scripts";

/** The state engine — the one place a database may be opened. */
const STATE_ENGINE_PREFIX = "src/main/vellum/state/";

/**
 * This gate's own source carries the rule patterns as literals. Excluded by
 * explicit path, never by matching a filename shape.
 */
const SELF_REL = "scripts/lint-single-write-seam.ts";

const SQLITE_DRIVER_MODULES = new Set([
  "node:sqlite",
  "bun:sqlite",
  "better-sqlite3",
]);

/**
 * Rule 4 anchors. The runtime seam is only real while the state engine calls
 * it, so the gate reads the wiring rather than trusting it.
 */
const SEAM_MODULE_REL = "src/main/vellum/work/mutation-seam.ts";
const STATE_ENGINE_REL = "src/main/vellum/state/engine.ts";
const SEAM_WIRING_CALLS = ["admitWorkStatement(", "beginWorkMutationScope("];
/** Declared only for tests and fixtures; never admissible under src/. */
const TEST_ONLY_JOURNAL_FREE_REASON = "test.fixture-seed";

/** Interior decode kinds — allowed only with a retirement condition. */
const INTERIOR_DECODE_KINDS = new Set(["row", "mint"]);
const INGRESS_DECODE_KINDS = new Set(["wire", "codec", "operator", "constant"]);

type OpenerEntry = {
  readonly path: string;
  readonly reason: string;
  readonly retire?: string;
};

type DynamicTableSite = {
  readonly statement: string;
  readonly expression: string;
  readonly resolvesTo: ReadonlyArray<string>;
  readonly reason: string;
};

type SeamEntry = {
  readonly path: string;
  readonly kind: "permanent" | "debt";
  readonly tables: ReadonlyArray<string>;
  readonly dynamicTableSites?: ReadonlyArray<DynamicTableSite>;
  readonly reason: string;
  readonly retire?: string;
};

type SharedTableEntry = {
  readonly table: string;
  readonly owner: string;
  readonly alsoWrittenBy: ReadonlyArray<string>;
  readonly reason: string;
  readonly retire: string;
};

type DecodeEntry = {
  readonly path: string;
  readonly kinds: ReadonlyArray<string>;
  readonly reason: string;
  readonly retire?: string;
};

type JournalFreeEntry = {
  readonly path: string;
  readonly reasons: ReadonlyArray<string>;
  readonly reason: string;
  readonly retire: string;
};

type Register = {
  readonly databaseOpeners: ReadonlyArray<OpenerEntry>;
  readonly databaseOpenerExceptions: ReadonlyArray<OpenerEntry>;
  readonly mutationSeams: ReadonlyArray<SeamEntry>;
  readonly sharedTableExceptions: ReadonlyArray<SharedTableEntry>;
  readonly decodeBoundaries: ReadonlyArray<DecodeEntry>;
  readonly journalFreeMutations: ReadonlyArray<JournalFreeEntry>;
};

type Hit = {
  readonly file: string;
  readonly line: number;
  readonly text: string;
};

type MutationHit = Hit & {
  readonly statement: string;
  /** Literal target table, when the statement names one. */
  readonly table: string | undefined;
  /** Interpolated target expression (`${table}`) when the table is computed. */
  readonly expression: string | undefined;
};

const isScannableSource = (name: string): boolean =>
  (name.endsWith(".ts") ||
    name.endsWith(".tsx") ||
    name.endsWith(".mts") ||
    name.endsWith(".mjs") ||
    name.endsWith(".cjs") ||
    name.endsWith(".js")) &&
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
    if (entry.isFile() && isScannableSource(entry.name)) out.push(full);
  }
  return out;
};

const relOf = (abs: string): string =>
  path.relative(ROOT, abs).split(path.sep).join("/");

/** Drop a trailing line comment unless the `//` is inside a string literal. */
const stripLineComment = (line: string): string => {
  const idx = line.indexOf("//");
  if (idx === -1) return line;
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

/** Code lines only, comments removed, 1-indexed with the original text. */
const codeLines = (
  text: string,
): ReadonlyArray<{ readonly n: number; readonly code: string; readonly raw: string }> => {
  const out: { n: number; code: string; raw: string }[] = [];
  for (const [i, raw] of text.split(/\r?\n/).entries()) {
    if (isCommentOnlyLine(raw)) {
      out.push({ n: i + 1, code: "", raw });
      continue;
    }
    out.push({ n: i + 1, code: stripLineComment(raw), raw });
  }
  return out;
};

// ---------------------------------------------------------------- rule 1 ----

const IMPORT_FROM = /from\s*["']([^"']+)["']/;
const REQUIRE_OF = /require\(\s*["']([^"']+)["']/;

/** Named bindings a sqlite driver import brought into this file. */
const sqliteBindings = (
  lines: ReadonlyArray<{ readonly code: string }>,
): ReadonlySet<string> => {
  const bindings = new Set<string>();
  for (const { code } of lines) {
    const from = IMPORT_FROM.exec(code) ?? REQUIRE_OF.exec(code);
    if (from === null) continue;
    if (!SQLITE_DRIVER_MODULES.has(from[1] ?? "")) continue;
    const braces = /\{([^}]*)\}/.exec(code);
    if (braces?.[1] !== undefined) {
      for (const raw of braces[1].split(",")) {
        const part = raw.trim().replace(/^type\s+/, "");
        if (part.length === 0) continue;
        const alias = /\s+as\s+(\w+)/.exec(part);
        const name = alias?.[1] ?? part.split(/\s+/)[0];
        if (name !== undefined && name.length > 0) bindings.add(name);
      }
    }
    const namespace = /\*\s+as\s+(\w+)/.exec(code);
    if (namespace?.[1] !== undefined) bindings.add(namespace[1]);
    const def = /import\s+(\w+)\s*(?:,|from)/.exec(code);
    if (def?.[1] !== undefined && def[1] !== "type") bindings.add(def[1]);
  }
  return bindings;
};

const scanOpeners = (
  rel: string,
  lines: ReadonlyArray<{ readonly n: number; readonly code: string; readonly raw: string }>,
): ReadonlyArray<Hit> => {
  const hits: Hit[] = [];
  for (const { n, code, raw } of lines) {
    const from = IMPORT_FROM.exec(code) ?? REQUIRE_OF.exec(code);
    if (from !== null && SQLITE_DRIVER_MODULES.has(from[1] ?? "")) {
      hits.push({ file: rel, line: n, text: raw.trim().slice(0, 160) });
    }
  }
  const bindings = sqliteBindings(lines);
  if (bindings.size > 0) {
    for (const { n, code, raw } of lines) {
      for (const binding of bindings) {
        if (new RegExp(`\\bnew\\s+${binding}\\s*\\(`).test(code)) {
          hits.push({ file: rel, line: n, text: raw.trim().slice(0, 160) });
          break;
        }
      }
    }
  }
  return hits;
};

// ---------------------------------------------------------------- rule 2 ----

/**
 * Clause forms that contain the keyword but start no statement:
 * `ON CONFLICT ... DO UPDATE SET`, FK `ON UPDATE/ON DELETE` actions, and
 * trigger headers `BEFORE/AFTER/INSTEAD OF UPDATE|DELETE|INSERT ON t`.
 */
const neutralizeClauses = (line: string): string =>
  line
    .replace(/\bDO\s+UPDATE\b/g, "DO_UPDATE")
    .replace(/\bON\s+UPDATE\b/g, "ON_UPDATE")
    .replace(/\bON\s+DELETE\b/g, "ON_DELETE")
    .replace(/\bON\s+INSERT\b/g, "ON_INSERT")
    .replace(/\bBEFORE\s+(UPDATE|DELETE|INSERT)\b/g, "BEFORE_$1")
    .replace(/\bAFTER\s+(UPDATE|DELETE|INSERT)\b/g, "AFTER_$1")
    .replace(/\bINSTEAD\s+OF\s+(UPDATE|DELETE|INSERT)\b/g, "INSTEAD_OF_$1")
    .replace(/\bFOR\s+UPDATE\b/g, "FOR_UPDATE");

const OR_CONFLICT = "(?:OR\\s+(?:REPLACE|IGNORE|ABORT|FAIL|ROLLBACK)\\s+)?";
const IDENT = "[A-Za-z_][A-Za-z0-9_]*";

/** Statement openers. Group 1 is the target table when it is on the same line. */
const MUTATION_PATTERNS: ReadonlyArray<{ readonly label: string; readonly re: RegExp }> = [
  { label: "INSERT", re: new RegExp(`\\bINSERT\\s+${OR_CONFLICT}INTO\\s+(?:"?(${IDENT})"?)?`, "g") },
  { label: "REPLACE", re: new RegExp(`\\bREPLACE\\s+INTO\\s+(?:"?(${IDENT})"?)?`, "g") },
  { label: "DELETE", re: new RegExp(`\\bDELETE\\s+FROM\\s+(?:"?(${IDENT})"?)?`, "g") },
  { label: "UPDATE", re: new RegExp(`\\bUPDATE\\s+${OR_CONFLICT}(?:"?(${IDENT})"?)?`, "g") },
];

/**
 * Lowercase SQL would slip past the uppercase patterns above, so a lowercase
 * statement shape is a violation of the SQL-is-uppercase convention and is
 * reported as such. Shape-anchored (`set` / `where` / `values` / `(`) so English
 * prose like "Delete from board" is not a hit.
 */
const LOWERCASE_SQL_PATTERNS: ReadonlyArray<RegExp> = [
  new RegExp(`\\binsert\\s+(?:or\\s+\\w+\\s+)?into\\s+${IDENT}\\s*[(]`),
  new RegExp(`\\breplace\\s+into\\s+${IDENT}\\s*[(]`),
  new RegExp(`\\bdelete\\s+from\\s+${IDENT}\\s+where\\b`),
  new RegExp(`\\bupdate\\s+${IDENT}\\s+set\\b`),
];

const scanMutations = (
  rel: string,
  lines: ReadonlyArray<{ readonly n: number; readonly code: string; readonly raw: string }>,
): ReadonlyArray<MutationHit> => {
  const hits: MutationHit[] = [];
  for (const [index, { n, code, raw }] of lines.entries()) {
    const line = neutralizeClauses(code);
    const text = raw.trim().slice(0, 160);
    for (const { label, re } of MUTATION_PATTERNS) {
      re.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = re.exec(line)) !== null) {
        const table = match[1];
        if (table !== undefined) {
          hits.push({ file: rel, line: n, text, statement: label, table, expression: undefined });
          continue;
        }
        // Computed table: `INSERT INTO ${table}(` — resolvable only by the register.
        const rest = line.slice(match.index + match[0].length);
        const interpolation = /^\s*(\$\{[^}]*\})/.exec(rest)?.[1];
        if (interpolation !== undefined) {
          hits.push({
            file: rel,
            line: n,
            text,
            statement: label,
            table: undefined,
            expression: interpolation,
          });
          continue;
        }
        // Statement wrapped across lines: `DELETE FROM\n  work_task_dependencies`
        const tail = lines
          .slice(index + 1, index + 3)
          .map((entry) => entry.code)
          .join(" ");
        const wrapped = new RegExp(`^\\s*"?(${IDENT})"?`).exec(tail)?.[1];
        hits.push({
          file: rel,
          line: n,
          text,
          statement: label,
          table: wrapped,
          expression: undefined,
        });
      }
    }
    for (const re of LOWERCASE_SQL_PATTERNS) {
      if (re.test(code)) {
        hits.push({
          file: rel,
          line: n,
          text,
          statement: "lowercase",
          table: undefined,
          expression: undefined,
        });
      }
    }
  }
  return hits;
};

// ---------------------------------------------------------------- rule 3 ----

const DECODE_PATTERN = /\bSchema\.decodeUnknown[A-Za-z]*\s*[(<]/;

const scanDecodes = (
  rel: string,
  lines: ReadonlyArray<{ readonly n: number; readonly code: string; readonly raw: string }>,
): ReadonlyArray<Hit> => {
  const hits: Hit[] = [];
  for (const { n, code, raw } of lines) {
    if (!DECODE_PATTERN.test(code)) continue;
    hits.push({ file: rel, line: n, text: raw.trim().slice(0, 160) });
  }
  return hits;
};

// ---------------------------------------------------------------- rule 4 ----

const JOURNAL_FREE_CALL = /\bunjournaledWorkMutation\s*\(\s*["']([^"']+)["']/;
const JOURNAL_FREE_ANY = /\bunjournaledWorkMutation\s*\(/;

type JournalFreeHit = Hit & { readonly reason: string | undefined };

const scanJournalFree = (
  rel: string,
  lines: ReadonlyArray<{ readonly n: number; readonly code: string; readonly raw: string }>,
): ReadonlyArray<JournalFreeHit> => {
  const hits: JournalFreeHit[] = [];
  for (const { n, code, raw } of lines) {
    if (!JOURNAL_FREE_ANY.test(code)) continue;
    const reason = JOURNAL_FREE_CALL.exec(code)?.[1];
    hits.push({ file: rel, line: n, text: raw.trim().slice(0, 160), reason });
  }
  return hits;
};

/**
 * The closed reason set, read from the seam module's own
 * `UNJOURNALED_WORK_REASONS` object so the register cannot drift from the type
 * the compiler enforces at every call site.
 */
const declaredJournalFreeReasons = async (): Promise<ReadonlySet<string>> => {
  const text = await readFile(path.join(ROOT, SEAM_MODULE_REL), "utf8");
  const start = text.indexOf("export const UNJOURNALED_WORK_REASONS");
  if (start === -1) {
    throw new Error(`${SEAM_MODULE_REL}: UNJOURNALED_WORK_REASONS is gone`);
  }
  const end = text.indexOf("} as const;", start);
  if (end === -1) {
    throw new Error(`${SEAM_MODULE_REL}: UNJOURNALED_WORK_REASONS is not closed`);
  }
  const reasons = new Set<string>();
  for (const match of text.slice(start, end).matchAll(/^\s{2}"([^"]+)":\s*\{/gm)) {
    reasons.add(match[1]);
  }
  if (reasons.size === 0) {
    throw new Error(`${SEAM_MODULE_REL}: UNJOURNALED_WORK_REASONS parsed empty`);
  }
  return reasons;
};

// -------------------------------------------------------------- register ----

const loadRegister = async (): Promise<Register> => {
  const abs = path.join(ROOT, REGISTER_REL);
  const raw = JSON.parse(await readFile(abs, "utf8")) as Register;
  for (const key of [
    "databaseOpeners",
    "databaseOpenerExceptions",
    "mutationSeams",
    "sharedTableExceptions",
    "decodeBoundaries",
    "journalFreeMutations",
  ] as const) {
    if (!Array.isArray(raw[key])) {
      throw new Error(`${REGISTER_REL}: expected array at "${key}"`);
    }
  }
  return raw;
};

const requireReason = (label: string, reason: string | undefined): string | undefined =>
  reason === undefined || reason.trim().length === 0
    ? `${label} — missing "reason"`
    : undefined;

const requireRetire = (label: string, retire: string | undefined): string | undefined =>
  retire === undefined || retire.trim().length === 0
    ? `${label} — missing "retire" (name what must happen to remove this entry)`
    : undefined;

const uniquePaths = (
  label: string,
  entries: ReadonlyArray<{ readonly path: string }>,
): ReadonlyArray<string> => {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.path)) problems.push(`${label}: duplicate path ${entry.path}`);
    seen.add(entry.path);
  }
  return problems;
};

/** Register-shape law, checked before a single source file is read. */
const registerPolicy = (register: Register): ReadonlyArray<string> => {
  const problems: string[] = [
    ...uniquePaths("databaseOpeners", register.databaseOpeners),
    ...uniquePaths("databaseOpenerExceptions", register.databaseOpenerExceptions),
    ...uniquePaths("mutationSeams", register.mutationSeams),
    ...uniquePaths("decodeBoundaries", register.decodeBoundaries),
    ...uniquePaths("journalFreeMutations", register.journalFreeMutations),
  ];

  for (const entry of register.journalFreeMutations) {
    const reason = requireReason(`journalFreeMutations ${entry.path}`, entry.reason);
    if (reason !== undefined) problems.push(reason);
    const retire = requireRetire(`journalFreeMutations ${entry.path}`, entry.retire);
    if (retire !== undefined) problems.push(retire);
    if (!Array.isArray(entry.reasons) || entry.reasons.length === 0) {
      problems.push(
        `journalFreeMutations ${entry.path} — must declare the journal-free reasons it uses`,
      );
    }
  }

  for (const entry of register.databaseOpeners) {
    const problem = requireReason(`databaseOpeners ${entry.path}`, entry.reason);
    if (problem !== undefined) problems.push(problem);
    if (!entry.path.startsWith(STATE_ENGINE_PREFIX)) {
      problems.push(
        `databaseOpeners ${entry.path} — only ${STATE_ENGINE_PREFIX}** may open a database; ` +
          `anything else belongs in databaseOpenerExceptions with a retire condition`,
      );
    }
  }
  for (const entry of register.databaseOpenerExceptions) {
    const reason = requireReason(`databaseOpenerExceptions ${entry.path}`, entry.reason);
    if (reason !== undefined) problems.push(reason);
    const retire = requireRetire(`databaseOpenerExceptions ${entry.path}`, entry.retire);
    if (retire !== undefined) problems.push(retire);
    if (entry.path.startsWith(STATE_ENGINE_PREFIX)) {
      problems.push(
        `databaseOpenerExceptions ${entry.path} — inside the state engine; list it under databaseOpeners`,
      );
    }
  }

  const owners = new Map<string, string[]>();
  for (const entry of register.mutationSeams) {
    const reason = requireReason(`mutationSeams ${entry.path}`, entry.reason);
    if (reason !== undefined) problems.push(reason);
    if (entry.kind !== "permanent" && entry.kind !== "debt") {
      problems.push(`mutationSeams ${entry.path} — kind must be "permanent" or "debt"`);
    }
    if (entry.kind === "debt") {
      const retire = requireRetire(`mutationSeams ${entry.path}`, entry.retire);
      if (retire !== undefined) problems.push(retire);
    }
    if (!Array.isArray(entry.tables) || entry.tables.length === 0) {
      problems.push(`mutationSeams ${entry.path} — must declare the tables it writes`);
      continue;
    }
    const declared = new Set(entry.tables);
    for (const site of entry.dynamicTableSites ?? []) {
      const label = `mutationSeams ${entry.path} dynamic ${site.statement} ${site.expression}`;
      const reasonProblem = requireReason(label, site.reason);
      if (reasonProblem !== undefined) problems.push(reasonProblem);
      if (!Array.isArray(site.resolvesTo) || site.resolvesTo.length === 0) {
        problems.push(`${label} — must list every table the expression can resolve to`);
        continue;
      }
      for (const table of site.resolvesTo) {
        if (declared.has(table)) continue;
        problems.push(
          `${label} — resolves to "${table}", which the seam does not declare in "tables"`,
        );
      }
    }
    for (const table of entry.tables) {
      owners.set(table, [...(owners.get(table) ?? []), entry.path]);
    }
  }

  const shared = new Map<string, SharedTableEntry>();
  for (const entry of register.sharedTableExceptions) {
    if (shared.has(entry.table)) {
      problems.push(`sharedTableExceptions: duplicate table ${entry.table}`);
    }
    shared.set(entry.table, entry);
    const reason = requireReason(`sharedTableExceptions ${entry.table}`, entry.reason);
    if (reason !== undefined) problems.push(reason);
    const retire = requireRetire(`sharedTableExceptions ${entry.table}`, entry.retire);
    if (retire !== undefined) problems.push(retire);
  }

  for (const [table, files] of [...owners.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    if (files.length === 1) {
      if (shared.has(table)) {
        problems.push(
          `sharedTableExceptions ${table} — only one seam writes it now; remove the stale exception`,
        );
      }
      continue;
    }
    const exception = shared.get(table);
    if (exception === undefined) {
      problems.push(
        `table "${table}" is written by ${files.length} seams and has no sharedTableExceptions entry:\n` +
          files.map((f) => `        ${f}`).join("\n"),
      );
      continue;
    }
    const declared = new Set([exception.owner, ...exception.alsoWrittenBy]);
    for (const file of files) {
      if (!declared.has(file)) {
        problems.push(
          `sharedTableExceptions ${table} — ${file} writes it but is not listed as owner or in alsoWrittenBy`,
        );
      }
    }
    for (const file of declared) {
      if (!files.includes(file)) {
        problems.push(
          `sharedTableExceptions ${table} — lists ${file}, which no longer writes it; shrink the exception`,
        );
      }
    }
  }

  for (const entry of register.decodeBoundaries) {
    const reason = requireReason(`decodeBoundaries ${entry.path}`, entry.reason);
    if (reason !== undefined) problems.push(reason);
    if (!Array.isArray(entry.kinds) || entry.kinds.length === 0) {
      problems.push(`decodeBoundaries ${entry.path} — must declare at least one boundary kind`);
      continue;
    }
    let interior = false;
    for (const kind of entry.kinds) {
      if (INTERIOR_DECODE_KINDS.has(kind)) {
        interior = true;
        continue;
      }
      if (!INGRESS_DECODE_KINDS.has(kind)) {
        problems.push(
          `decodeBoundaries ${entry.path} — unknown kind "${kind}" (allowed: ` +
            `${[...INGRESS_DECODE_KINDS, ...INTERIOR_DECODE_KINDS].join(", ")})`,
        );
      }
    }
    if (interior) {
      const retire = requireRetire(`decodeBoundaries ${entry.path}`, entry.retire);
      if (retire !== undefined) problems.push(retire);
    }
  }

  return problems;
};

// ------------------------------------------------------------------ main ----

const RULE_TEXT = {
  opener:
    `RULE 1 — a SQLite driver may only be imported and a database only constructed inside\n` +
    `  ${STATE_ENGINE_PREFIX}**. The main process is the sole writer of the state database;\n` +
    `  a second opener forks the source of truth. Register it in "databaseOpeners" (state engine)\n` +
    `  or, if it genuinely opens a different database, in "databaseOpenerExceptions" with a "retire".`,
  mutation:
    `RULE 2 — INSERT / UPDATE / DELETE / REPLACE may only appear in a declared mutation seam,\n` +
    `  and only against tables that seam declares. SQLite is the append-only journal; an\n` +
    `  unregistered write is a second writer. Register the file in "mutationSeams" with its\n` +
    `  table set, or route the write through the seam that already owns those tables.`,
  decode:
    `RULE 3 — Schema.decodeUnknown* is an ingress operation and may only appear in a declared\n` +
    `  decode boundary. A decode away from a boundary re-validates data this process produced —\n` +
    `  that is the strict-decode cost the read path already paid for once.\n` +
    `  Register the file in "decodeBoundaries" with the boundary kind it guards\n` +
    `  (wire | codec | operator | constant, or the interior kinds row | mint, which additionally\n` +
    `  require a "retire" condition naming what removes them).`,
  journalFree:
    `RULE 4 — the runtime seam (${SEAM_MODULE_REL}) refuses a work projection write that no\n` +
    `  journal record in the same transaction explains. unjournaledWorkMutation() is its ONE\n` +
    `  escape: the reason set is closed at the type level in the seam module, and every call\n` +
    `  site under src/ must be declared in "journalFreeMutations" with a "retire" condition.\n` +
    `  "${TEST_ONLY_JOURNAL_FREE_REASON}" is for tests and fixtures, never admissible under src/.`,
} as const;

/** Rule 4a — the runtime seam is only real while the state engine calls it. */
const seamWiringViolations = async (): Promise<ReadonlyArray<string>> => {
  const engine = await readFile(path.join(ROOT, STATE_ENGINE_REL), "utf8");
  const out: string[] = [];
  for (const call of SEAM_WIRING_CALLS) {
    if (engine.includes(call)) continue;
    out.push(
      `${STATE_ENGINE_REL}: no longer calls ${call} — the runtime work mutation seam is ` +
        `not installed, so every static rule below it guards nothing`,
      RULE_TEXT.journalFree,
    );
  }
  return out;
};

/** One escape call site, judged against the register and the closed reason set. */
const journalFreeHitViolations = (
  file: string,
  hit: JournalFreeHit,
  declared: ReadonlySet<string>,
  closedReasons: ReadonlySet<string>,
): ReadonlyArray<string> => {
  if (hit.reason === undefined) {
    return [
      `${file}:${hit.line}: unjournaledWorkMutation() without a literal reason — the ` +
        `reason must be readable at the call site, not computed`,
      `    L${hit.line}: ${hit.text}`,
    ];
  }
  if (hit.reason === TEST_ONLY_JOURNAL_FREE_REASON) {
    return [
      `${file}:${hit.line}: "${TEST_ONLY_JOURNAL_FREE_REASON}" is a test/fixture reason and ` +
        `must never appear under ${SOURCE_ROOT}/`,
      `    L${hit.line}: ${hit.text}`,
    ];
  }
  if (!closedReasons.has(hit.reason)) {
    return [
      `${file}:${hit.line}: "${hit.reason}" is not declared in ` +
        `${SEAM_MODULE_REL} UNJOURNALED_WORK_REASONS`,
    ];
  }
  if (declared.has(hit.reason)) return [];
  return [
    `${file}:${hit.line}: uses journal-free reason "${hit.reason}", which this entry does ` +
      `not declare in "reasons"`,
    RULE_TEXT.journalFree,
  ];
};

/** Rule 4b — every escape call site under src/ is declared. */
const journalFreeViolations = (
  hits: ReadonlyMap<string, ReadonlyArray<JournalFreeHit>>,
  register: ReadonlyMap<string, JournalFreeEntry>,
  closedReasons: ReadonlySet<string>,
): ReadonlyArray<string> => {
  const out: string[] = [];
  for (const [file, fileHits] of [...hits.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const entry = register.get(file);
    if (entry === undefined) {
      out.push(
        `${file}: ${fileHits.length} undeclared unjournaledWorkMutation() call site(s)`,
        ...fileHits.map((hit) => `    L${hit.line}: ${hit.text}`),
        RULE_TEXT.journalFree,
      );
      continue;
    }
    const declared = new Set(entry.reasons);
    for (const hit of fileHits) {
      out.push(
        ...journalFreeHitViolations(file, hit, declared, closedReasons),
      );
    }
  }
  return out;
};

/** Rule 4c — a declared escape that nothing uses is an unlocked door. */
const staleJournalFreeViolations = (
  hits: ReadonlyMap<string, ReadonlyArray<JournalFreeHit>>,
  register: ReadonlyMap<string, JournalFreeEntry>,
  closedReasons: ReadonlySet<string>,
): ReadonlyArray<string> => {
  const out: string[] = [];
  const usedAnywhere = new Set<string>();
  for (const [file, entry] of register) {
    const fileHits = hits.get(file);
    if (fileHits === undefined) {
      out.push(
        `${file}: registered journal-free mutation, but the file calls no ` +
          `unjournaledWorkMutation() — remove the entry`,
      );
      continue;
    }
    const used = new Set(fileHits.map((hit) => hit.reason));
    for (const reason of entry.reasons) {
      if (!used.has(reason)) {
        out.push(
          `${file}: declares journal-free reason "${reason}" but no longer uses it — shrink the entry`,
        );
        continue;
      }
      usedAnywhere.add(reason);
    }
  }
  for (const reason of closedReasons) {
    if (reason === TEST_ONLY_JOURNAL_FREE_REASON) continue;
    if (usedAnywhere.has(reason)) continue;
    out.push(
      `${SEAM_MODULE_REL}: declares journal-free reason "${reason}" that no src/ call site ` +
        `uses — delete the reason and close the escape`,
    );
  }
  return out;
};

const main = async (): Promise<number> => {
  for (const root of [SOURCE_ROOT, TOOLING_ROOT]) {
    const abs = path.join(ROOT, root);
    const info = await stat(abs).catch(() => undefined);
    if (info === undefined || !info.isDirectory()) {
      console.error(`single-write-seam: missing scan root: ${root}`);
      return 1;
    }
  }

  const register = await loadRegister();
  const policyProblems = registerPolicy(register);
  if (policyProblems.length > 0) {
    console.error("single-write-seam register is INVALID — the gate cannot run:");
    for (const problem of policyProblems) console.error(`  - ${problem}`);
    console.error(`\nRegister: ${REGISTER_REL}`);
    return 1;
  }

  const openers = new Map(
    [...register.databaseOpeners, ...register.databaseOpenerExceptions].map(
      (entry) => [entry.path, entry] as const,
    ),
  );
  const seams = new Map(register.mutationSeams.map((entry) => [entry.path, entry] as const));
  const decodes = new Map(register.decodeBoundaries.map((entry) => [entry.path, entry] as const));
  const journalFree = new Map(
    register.journalFreeMutations.map((entry) => [entry.path, entry] as const),
  );
  const closedReasons = await declaredJournalFreeReasons();

  const openerHits = new Map<string, Hit[]>();
  const mutationHits = new Map<string, MutationHit[]>();
  const decodeHits = new Map<string, Hit[]>();
  const journalFreeHits = new Map<string, JournalFreeHit[]>();

  const scanRoots = [
    { root: SOURCE_ROOT, decode: true },
    { root: TOOLING_ROOT, decode: false },
  ] as const;

  for (const { root, decode } of scanRoots) {
    for (const abs of await walk(path.join(ROOT, root))) {
      const rel = relOf(abs);
      if (rel === SELF_REL) continue;
      const lines = codeLines(await readFile(abs, "utf8"));

      const opener = scanOpeners(rel, lines);
      if (opener.length > 0) openerHits.set(rel, [...opener]);

      const mutation = scanMutations(rel, lines);
      if (mutation.length > 0) mutationHits.set(rel, [...mutation]);

      if (!decode) continue;

      // The seam module DEFINES the escape and names it in its own error
      // strings; it never calls it. Excluded by explicit path, never by shape.
      if (rel === SEAM_MODULE_REL) continue;
      const escapes = scanJournalFree(rel, lines);
      if (escapes.length > 0) journalFreeHits.set(rel, [...escapes]);

      const decoded = scanDecodes(rel, lines);
      if (decoded.length > 0) decodeHits.set(rel, [...decoded]);
    }
  }

  const violations: string[] = [];
  const seenDynamic = new Set<string>();
  const sorted = <V>(map: Map<string, V>): ReadonlyArray<readonly [string, V]> =>
    [...map.entries()].sort(([a], [b]) => a.localeCompare(b));

  // Rule 1.
  for (const [file, hits] of sorted(openerHits)) {
    if (openers.has(file)) continue;
    violations.push(`${file}: opens a SQLite database outside the state engine`);
    for (const hit of hits) violations.push(`    L${hit.line}: ${hit.text}`);
    violations.push(RULE_TEXT.opener);
  }

  // Rule 2.
  for (const [file, hits] of sorted(mutationHits)) {
    const seam = seams.get(file);
    if (seam === undefined) {
      violations.push(`${file}: ${hits.length} mutation statement(s) outside any declared seam`);
      for (const hit of hits) violations.push(`    L${hit.line}: ${hit.text}`);
      violations.push(RULE_TEXT.mutation);
      continue;
    }
    const declared = new Set(seam.tables);
    const dynamic = new Map<string, DynamicTableSite>(
      (seam.dynamicTableSites ?? []).map(
        (site) => [`${site.statement} ${site.expression}`, site] as [string, DynamicTableSite],
      ),
    );
    for (const hit of hits) {
      if (hit.statement === "lowercase") {
        violations.push(
          `${file}:${hit.line}: lowercase mutation SQL — write SQL keywords uppercase so the ` +
            `seam gate can read the statement`,
        );
        violations.push(`    L${hit.line}: ${hit.text}`);
        continue;
      }
      if (hit.expression !== undefined) {
        const key = `${hit.statement} ${hit.expression}`;
        if (dynamic.has(key)) {
          seenDynamic.add(`${file}\u0000${key}`);
          continue;
        }
        violations.push(
          `${file}:${hit.line}: ${hit.statement} into a computed table \`${hit.expression}\` — a ` +
            `computed target defeats table ownership. Declare it under this seam's ` +
            `"dynamicTableSites" with every table it can resolve to, or write literal statements`,
        );
        violations.push(`    L${hit.line}: ${hit.text}`);
        violations.push(RULE_TEXT.mutation);
        continue;
      }
      if (hit.table === undefined) {
        violations.push(
          `${file}:${hit.line}: mutation statement whose target table could not be read — ` +
            `write it as one statement with the table on the keyword's line`,
        );
        violations.push(`    L${hit.line}: ${hit.text}`);
        continue;
      }
      if (declared.has(hit.table)) continue;
      violations.push(
        `${file}:${hit.line}: writes table "${hit.table}", which this seam does not declare`,
      );
      violations.push(`    L${hit.line}: ${hit.text}`);
      violations.push(RULE_TEXT.mutation);
    }
  }

  // Rule 3.
  for (const [file, hits] of sorted(decodeHits)) {
    if (decodes.has(file)) continue;
    violations.push(`${file}: ${hits.length} Schema.decodeUnknown* site(s) outside any declared boundary`);
    for (const hit of hits) violations.push(`    L${hit.line}: ${hit.text}`);
    violations.push(RULE_TEXT.decode);
  }

  violations.push(
    ...(await seamWiringViolations()),
    ...journalFreeViolations(journalFreeHits, journalFree, closedReasons),
  );

  // Stale register entries — an exception that no longer covers anything must go.
  for (const [file] of openers) {
    if (!openerHits.has(file)) {
      violations.push(`${file}: registered database opener, but the file opens no database — remove the entry`);
    }
  }
  for (const [file, seam] of seams) {
    const hits = mutationHits.get(file);
    if (hits === undefined) {
      violations.push(`${file}: registered mutation seam, but the file has no mutation SQL — remove the entry`);
      continue;
    }
    const written = new Set(hits.map((hit) => hit.table).filter((t): t is string => t !== undefined));
    for (const site of seam.dynamicTableSites ?? []) {
      const key = `${site.statement} ${site.expression}`;
      if (!seenDynamic.has(`${file}\u0000${key}`)) {
        violations.push(
          `${file}: declares dynamic site "${key}" but no such statement remains — remove the entry`,
        );
        continue;
      }
      for (const table of site.resolvesTo) written.add(table);
    }
    for (const table of seam.tables) {
      if (!written.has(table)) {
        violations.push(
          `${file}: declares table "${table}" but no longer writes it — shrink the declared table set`,
        );
      }
    }
  }
  for (const [file] of decodes) {
    if (!decodeHits.has(file)) {
      violations.push(`${file}: registered decode boundary, but the file has no Schema.decodeUnknown* — remove the entry`);
    }
  }
  violations.push(
    ...staleJournalFreeViolations(journalFreeHits, journalFree, closedReasons),
  );

  if (violations.length > 0) {
    console.error("SINGLE-WRITE-SEAM GATE FAILED — the factory world has more than one writer.");
    console.error("");
    for (const violation of violations) console.error(`  ${violation}`);
    console.error(
      `\nRegister: ${REGISTER_REL}\n` +
        `Every entry is an explicit path. Exceptions are narrow and each carries a "retire"\n` +
        `condition naming what must happen to remove it. There is no blanket exemption and no\n` +
        `filename pattern — a new writer must be argued for in the register, in writing.`,
    );
    return 1;
  }

  const seamTables = new Set(register.mutationSeams.flatMap((entry) => [...entry.tables]));
  const interior = register.decodeBoundaries.filter((entry) =>
    entry.kinds.some((kind) => INTERIOR_DECODE_KINDS.has(kind)),
  ).length;

  console.log(
    `ok single-write-seam: ${openers.size} database opener(s) ` +
      `(${register.databaseOpenerExceptions.length} exception), ` +
      `${seams.size} mutation seam(s) over ${seamTables.size} tables ` +
      `(${register.sharedTableExceptions.length} shared-table exception), ` +
      `${decodes.size} decode boundary(ies) (${interior} still interior), ` +
      `${journalFree.size} journal-free file(s) over ${closedReasons.size - 1} declared reason(s)`,
  );
  return 0;
};

const code = await main();
process.exit(code);
