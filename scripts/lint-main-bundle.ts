#!/usr/bin/env bun
/**
 * Build gate: main's bundle may hold only the window, Electron's handlers and
 * the core client. The core runs in its own process (src/main/core-process/
 * entry.ts); a core module that main also links exists twice, and main's copy
 * is the empty one. That is what made seat state and offboard answer nothing.
 *
 * The gate walks main's static import closure from the built
 * `out/main/index.js`, fails when the closure holds a core marker, and names
 * the offending source module through `out/main/bundle-modules.json` (written
 * by scripts/main-bundle-modules.ts during the same build).
 *
 * Ratchet: `scripts/main-bundle-allowlist.json` lists today's offenders, by
 * source module, with the reason they still link. The list may only shrink.
 * A module not on it that holds a marker fails; a module on it that no longer
 * holds one fails as stale, so the count comes down as the split closes.
 * `--prune` drops the stale entries and writes the list back; it never adds.
 *
 * Run after `electron-vite build`: `bun run lint:main-bundle`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_REL = "out/main";
const ENTRY = "index";
const MANIFEST_REL = `${OUT_REL}/bundle-modules.json`;
const ALLOWLIST_REL = "scripts/main-bundle-allowlist.json";

/** Code that only the core may hold. A match in main's closure is a second copy. */
const CORE_MARKERS: ReadonlyArray<{ readonly text: string; readonly what: string }> = [
  { text: "class LocalSessionHost", what: "the terminal session host" },
  { text: "class SeatStateRuntime", what: "seat state" },
  { text: "makeStateEngineLive", what: "the state engine" },
  { text: "CREATE TABLE", what: "schema DDL" },
];

type Manifest = { readonly entries: Record<string, ReadonlyArray<string>> };
type Allowlist = {
  readonly entry: string;
  readonly why: string;
  readonly offenders: ReadonlyArray<string>;
};

const SPECIFIER = /(?:from\s*|require\(\s*|import\(\s*)["']([^"']+)["']/g;
const prune = process.argv.includes("--prune");

/** Every file the bundle loads from `entry` by static import, entry included. */
const staticClosure = (entryFile: string): ReadonlyMap<string, string> => {
  const files = new Map<string, string>();
  const visit = (file: string): void => {
    if (files.has(file)) return;
    const text = readFileSync(file, "utf8");
    files.set(file, text);
    for (const match of text.matchAll(SPECIFIER)) {
      const specifier = match[1] ?? "";
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) continue;
      visit(resolve(dirname(file), specifier));
    }
  };
  visit(entryFile);
  return files;
};

const load = <T>(rel: string): T => JSON.parse(readFileSync(join(ROOT, rel), "utf8")) as T;

const main = (): number => {
  let built: ReadonlyMap<string, string>;
  let manifest: Manifest;
  let allowlist: Allowlist;
  try {
    manifest = load<Manifest>(MANIFEST_REL);
    allowlist = load<Allowlist>(ALLOWLIST_REL);
    built = staticClosure(join(ROOT, OUT_REL, `${ENTRY}.js`));
  } catch (cause) {
    console.error(`main-bundle gate cannot read the build: ${cause instanceof Error ? cause.message : String(cause)}`);
    console.error("Run `electron-vite build` first; `bun run verify` builds then runs this gate.");
    return 1;
  }

  if (allowlist.entry !== ENTRY) {
    console.error(`${ALLOWLIST_REL}: entry is "${allowlist.entry}", this gate walks "${ENTRY}"`);
    return 1;
  }

  // The verdict: the emitted closure itself must hold no core marker.
  const marked: Array<{ readonly file: string; readonly what: string }> = [];
  for (const [file, text] of built) {
    for (const marker of CORE_MARKERS) {
      if (text.includes(marker.text)) {
        marked.push({ file: relative(ROOT, file).split("\\").join("/"), what: marker.what });
        break;
      }
    }
  }

  if (marked.length === 0) {
    console.log(`ok main-bundle: ${ENTRY} reaches ${built.size} files, no core marker`);
    return 0;
  }

  // Attribution: which source module put that code there.
  const modules = manifest.entries[ENTRY] ?? [];
  const offenders = new Map<string, string>();
  for (const module of modules) {
    if (module.startsWith("node_modules/") || module.startsWith("\0") || module.includes("?")) continue;
    let text: string;
    try {
      text = readFileSync(join(ROOT, module), "utf8");
    } catch {
      continue;
    }
    for (const marker of CORE_MARKERS) {
      if (text.includes(marker.text)) {
        offenders.set(module, marker.what);
        break;
      }
    }
  }

  const allowed = new Set(allowlist.offenders);
  const added = [...offenders].filter(([module]) => !allowed.has(module));
  const stale = allowlist.offenders.filter((module) => !offenders.has(module));

  if (added.length === 0 && stale.length === 0) {
    console.log(
      `ok main-bundle: ${ENTRY} reaches ${built.size} files and ${modules.length} modules; ` +
        `${offenders.size} core-marked, all on the ratchet`,
    );
    return 0;
  }

  // --prune only drops what the split already closed; a new offender still fails.
  if (added.length === 0 && prune) {
    writeFileSync(
      join(ROOT, ALLOWLIST_REL),
      `${JSON.stringify({ ...allowlist, offenders: [...offenders.keys()].sort() }, null, 2)}\n`,
    );
    console.log(
      `ok main-bundle: pruned ${stale.length} module(s) the split closed; ` +
        `${offenders.size} core-marked, all on the ratchet`,
    );
    return 0;
  }

  console.error("main-bundle gate FAILED: main's bundle still holds the core.");
  if (added.length > 0) {
    console.error(`  ${added.length} core module(s) newly linked into main (${marked.length} emitted file(s) carry a marker):`);
    for (const [module, what] of added) console.error(`    ${module} — ${what}`);
  }
  if (stale.length > 0) {
    console.error(`  ${stale.length} allowlisted module(s) no longer hold core code: drop them from ${ALLOWLIST_REL} so the ratchet shrinks (bun scripts/lint-main-bundle.ts --prune):`);
    for (const module of stale) console.error(`    ${module}`);
  }
  return 1;
};

process.exit(main());
