#!/usr/bin/env bun
/**
 * Build gate: main's bundle may hold only the window, Electron's handlers and
 * the core client. The core runs in its own process (src/main/core-process/
 * entry.ts); a module that both bundles link exists twice, and main's copy is
 * the empty one. That is what made seat state and offboard answer nothing.
 *
 * The rule is the overlap itself, not a list of telltale strings: build main
 * and the core, and fail on every module under src/main that both entries
 * link. src/shared modules are contracts one side imports from the other, so
 * they are counted, not ratcheted; modules from node_modules and bundler
 * virtual ids are not project code and are ignored.
 *
 * The module lists come from `out/main/bundle-modules.json`, written by
 * scripts/main-bundle-modules.ts during the build: the emitted chunk says
 * *that* the core is in main's bundle, this says *which source file* put it
 * there.
 *
 * Ratchet: `scripts/main-bundle-allowlist.json` names today's main-side
 * modules that both processes link, in two lists.
 *   - `stays`: modules both sides need to talk, each with the reason it holds
 *     no product state (the port, the wire's listener registry, channel
 *     names). A module holding product state can never be justified here; it
 *     belongs in `debt` until it leaves main.
 *   - `debt`: core code main still links. Shrink-only: it goes away as the
 *     split closes, and the file ends with it empty.
 * A module in both that is on neither list fails. A listed module that they
 * no longer both link fails as stale, so closing shows up as entries leaving
 * the file. `--prune` drops stale `debt` entries and writes the list back; it
 * never adds, and it refuses to drop a `stays` entry.
 *
 * Run after `electron-vite build`: `bun run lint:main-bundle`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_REL = "out/main";
const ENTRY = "index";
const CORE_ENTRY = "core-process";
const MANIFEST_REL = `${OUT_REL}/bundle-modules.json`;
const ALLOWLIST_REL = "scripts/main-bundle-allowlist.json";

type Manifest = { readonly entries: Record<string, ReadonlyArray<string>> };
type Stay = { readonly path: string; readonly why: string };
type Allowlist = {
  readonly entry: string;
  readonly coreEntry: string;
  readonly why: string;
  readonly stays: ReadonlyArray<Stay>;
  readonly debt: ReadonlyArray<string>;
};

const prune = process.argv.includes("--prune");

const load = <T>(rel: string): T => JSON.parse(readFileSync(join(ROOT, rel), "utf8")) as T;

const main = (): number => {
  let manifest: Manifest;
  let allowlist: Allowlist;
  try {
    manifest = load<Manifest>(MANIFEST_REL);
    allowlist = load<Allowlist>(ALLOWLIST_REL);
  } catch (cause) {
    console.error(`main-bundle gate cannot read the build: ${cause instanceof Error ? cause.message : String(cause)}`);
    console.error("Run `electron-vite build` first; `bun run verify` builds then runs this gate.");
    return 1;
  }

  if (allowlist.entry !== ENTRY || allowlist.coreEntry !== CORE_ENTRY) {
    console.error(
      `${ALLOWLIST_REL}: entries are "${allowlist.entry}" and "${allowlist.coreEntry}", this gate compares "${ENTRY}" and "${CORE_ENTRY}"`,
    );
    return 1;
  }
  for (const stay of allowlist.stays) {
    if (stay.path.trim().length === 0 || stay.why.trim().length === 0) {
      console.error(`${ALLOWLIST_REL}: every stays entry needs a path and a why: ${JSON.stringify(stay)}`);
      return 1;
    }
    if (allowlist.debt.includes(stay.path)) {
      console.error(`${ALLOWLIST_REL}: ${stay.path} is in both stays and debt`);
      return 1;
    }
  }

  const mainModules = new Set(manifest.entries[ENTRY] ?? []);
  const coreModules = new Set(manifest.entries[CORE_ENTRY] ?? []);
  if (mainModules.size === 0 || coreModules.size === 0) {
    console.error(`${MANIFEST_REL} has no "${ENTRY}" or "${CORE_ENTRY}" entry; rebuild with the current electron.vite.config.ts`);
    return 1;
  }

  const project = [...mainModules].filter((module) => coreModules.has(module) && module.startsWith("src/"));
  const shared = project.filter((module) => module.startsWith("src/shared/"));
  const offenders = new Set(project.filter((module) => module.startsWith("src/main/")));

  const stayPaths = allowlist.stays.map((stay) => stay.path);
  const allowed = new Set([...stayPaths, ...allowlist.debt]);
  const added = [...offenders].filter((module) => !allowed.has(module)).sort();
  const staleDebt = allowlist.debt.filter((module) => !offenders.has(module));
  const staleStays = stayPaths.filter((module) => !offenders.has(module));

  const staysInBoth = stayPaths.filter((module) => offenders.has(module)).length;
  const debtInBoth = allowlist.debt.filter((module) => offenders.has(module)).length;
  const summary =
    `${ENTRY} and ${CORE_ENTRY} link ${mainModules.size} and ${coreModules.size} modules, ` +
    `${project.length} in both: ${offenders.size} main-side ` +
    `(${staysInBoth} stay, ${debtInBoth} debt, ${added.length} not on the list), ${shared.length} src/shared`;

  if (added.length === 0 && staleDebt.length === 0 && staleStays.length === 0) {
    console.log(`ok main-bundle: ${summary}`);
    return 0;
  }

  // --prune only drops debt the split already closed; a new overlap still fails,
  // and a stays entry that left the overlap is a design change to read, not erase.
  if (added.length === 0 && staleStays.length === 0 && prune) {
    const debt = [...offenders].filter((module) => !stayPaths.includes(module)).sort();
    writeFileSync(
      join(ROOT, ALLOWLIST_REL),
      `${JSON.stringify({ ...allowlist, debt }, null, 2)}\n`,
    );
    console.log(`ok main-bundle: pruned ${staleDebt.length} module(s) the split closed; ${summary}`);
    return 0;
  }

  console.error("main-bundle gate FAILED: main and the core link the same module.");
  if (added.length > 0) {
    console.error(`  ${added.length} main-side module(s) newly linked into both main and the core:`);
    for (const module of added) console.error(`    ${module}`);
  }
  if (staleDebt.length > 0) {
    console.error(
      `  ${staleDebt.length} debt module(s) no longer linked by both: drop them so the ratchet shrinks (bun scripts/lint-main-bundle.ts --prune):`,
    );
    for (const module of staleDebt) console.error(`    ${module}`);
  }
  if (staleStays.length > 0) {
    console.error(`  ${staleStays.length} stays module(s) no longer linked by both: either the wire changed, or they belong in debt:`);
    for (const module of staleStays) console.error(`    ${module}`);
  }
  console.error(`  ${summary}`);
  return 1;
};

process.exit(main());
