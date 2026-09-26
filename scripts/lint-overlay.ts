#!/usr/bin/env bun
// Overlay gates (docs/overlay.md).
//
//   bun scripts/lint-overlay.ts            import law: overlay code is reached
//                                          only through the `@junto/overlay` alias
//   bun scripts/lint-overlay.ts --bundle [--out DIR]
//                                          after `electron-vite build`: out/ holds
//                                          exactly the overlay this build resolved,
//                                          so an open-source build carries no
//                                          premium marker at all, and no premium
//                                          item or mascot from the overlay checkout
//                                          (--premium DIR, JUNTO_PREMIUM, or a
//                                          sibling ../junto-premium)
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OSS_OVERLAY_MARKER, OVERLAY_MARKER_PATTERN } from "../src/shared/overlay-contract";
import { resolveOverlay } from "./overlay";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_DIRS = ["src", "tests", "scripts", "e2e"];
const SKIP = new Set(["node_modules", "out", "dist", "release", "test-results"]);
// Only the resolver names the stub by path, and the gate's own test holds
// forbidden specifiers as fixtures; everything else imports the alias.
const PATH_OWNERS = new Set(["scripts/overlay.ts", "scripts/lint-overlay.ts", "tests/overlay.test.ts"]);

/** Import specifiers that reach overlay code without the alias. */
const FORBIDDEN_SPECIFIER = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']*(?:overlay-oss|junto-premium)[^"']*)["']/g;

export function overlayImportViolations(file: string, text: string): string[] {
  if (PATH_OWNERS.has(file) || file.startsWith("src/overlay-oss/")) return [];
  return [...text.matchAll(FORBIDDEN_SPECIFIER)].map((match) => `${file}: imports "${match[1]}"; use @junto/overlay`);
}

/**
 * Overlay markers in a bundle. The contract's own fallback names the OSS
 * marker, so it is always allowed; any other marker is overlay content.
 */
export function bundleMarkerViolations(markers: ReadonlySet<string>, kind: "oss" | "official"): string[] {
  const foreign = [...markers].filter((marker) => marker !== OSS_OVERLAY_MARKER);
  if (kind === "oss") return foreign.map((marker) => `open-source bundle carries ${marker}`);
  return foreign.length === 1 ? [] : [`official bundle must carry one overlay marker, found ${foreign.join(", ") || "none"}`];
}

async function* files(dir: string, extensions: RegExp): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP.has(entry.name) || entry.name.startsWith(".")) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path, extensions);
    else if (extensions.test(entry.name)) yield path;
  }
}

async function lintImports(): Promise<string[]> {
  const problems: string[] = [];
  for (const dir of SOURCE_DIRS) {
    for await (const path of files(join(ROOT, dir), /\.(?:ts|tsx|mts|mjs|js)$/)) {
      problems.push(...overlayImportViolations(relative(ROOT, path), await readFile(path, "utf8")));
    }
  }
  return problems;
}

/** Something a bundle holding premium content would carry verbatim. */
export interface PremiumFingerprint {
  readonly label: string;
  readonly needles: ReadonlyArray<string | RegExp>;
}

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** `id: "x", name: "Y"` as minified JS or JSON writes it. */
const pair = (a: string, av: string, b: string, bv: string): RegExp =>
  new RegExp(`"?${a}"?\\s*:\\s*"${escapeRegExp(av)}"\\s*,\\s*"?${b}"?\\s*:\\s*"${escapeRegExp(bv)}"`);

/**
 * Fingerprints of an overlay's premium content: each cosmetic item by its
 * path data (long, unique strings) or its id and name side by side, and the
 * mascot by its name and seed.
 */
export function premiumFingerprints(manifest: {
  readonly cosmetics: ReadonlyArray<unknown>;
  readonly brand?: { readonly mascot?: { readonly name: string; readonly seed: string } };
}): PremiumFingerprint[] {
  const out: PremiumFingerprint[] = [];
  for (const pack of manifest.cosmetics as ReadonlyArray<Record<string, unknown>>) {
    for (const list of ["species", "toppers", "accessories", "patterns", "palettes"]) {
      for (const item of (pack[list] ?? []) as ReadonlyArray<Record<string, unknown>>) {
        const paths = JSON.stringify(item.parts ?? []).match(/"d":"([^"]{16,})"/g) ?? [];
        out.push({
          label: `premium ${list} "${String(item.id)}" (${String(pack.id)})`,
          needles: [...paths.map((match) => match.slice(5, -1)), pair("id", String(item.id), "name", String(item.name))],
        });
      }
    }
  }
  const mascot = manifest.brand?.mascot;
  if (mascot) out.push({ label: `mascot ${mascot.name}`, needles: [pair("name", mascot.name, "seed", mascot.seed)] });
  return out;
}

export const fingerprintHits = (text: string, fingerprints: ReadonlyArray<PremiumFingerprint>): string[] =>
  fingerprints
    .filter((print) => print.needles.some((needle) => (typeof needle === "string" ? text.includes(needle) : needle.test(text))))
    .map((print) => print.label);

/** The premium checkout to fingerprint, if this machine has one. */
function premiumCheckout(): string | undefined {
  const flag = process.argv.indexOf("--premium");
  const candidates = [flag > 0 ? process.argv[flag + 1] : undefined, process.env.JUNTO_PREMIUM, join(ROOT, "..", "junto-premium")];
  return candidates.map((dir) => (dir ? resolve(dir) : undefined)).find((dir) => dir && existsSync(join(dir, "overlay", "index.ts")));
}

async function checkBundle(outDir: string): Promise<string[]> {
  const overlay = resolveOverlay();
  const markers = new Set<string>();
  const texts: string[] = [];
  for await (const path of files(outDir, /\.(?:js|cjs|mjs|html|css|json)$/)) {
    const text = await readFile(path, "utf8");
    texts.push(text);
    for (const match of text.matchAll(OVERLAY_MARKER_PATTERN)) markers.add(match[0]);
  }
  if (texts.length === 0) return [`${outDir} is empty; run electron-vite build first`];
  const problems = bundleMarkerViolations(markers, overlay.kind);
  if (overlay.kind !== "oss") return problems;
  const premium = premiumCheckout();
  if (!premium) {
    console.log("lint:overlay --bundle — no premium checkout here; premium content not fingerprinted");
    return problems;
  }
  const { overlay: manifest } = (await import(join(premium, "overlay", "index.ts"))) as {
    readonly overlay: Parameters<typeof premiumFingerprints>[0];
  };
  const prints = premiumFingerprints(manifest);
  const hits = new Set(texts.flatMap((text) => fingerprintHits(text, prints)));
  console.log(`lint:overlay --bundle — fingerprinted ${prints.length} premium items and mascots from ${premium}`);
  return [...problems, ...[...hits].map((label) => `open-source bundle carries ${label}`)];
}

if (import.meta.main) {
  const bundle = process.argv.includes("--bundle");
  const outFlag = process.argv.indexOf("--out");
  const outDir = outFlag > 0 ? resolve(process.argv[outFlag + 1] ?? "") : join(ROOT, "out");
  const problems = bundle ? await checkBundle(outDir) : await lintImports();
  if (problems.length > 0) {
    for (const problem of problems) console.error(problem);
    process.exit(1);
  }
  console.log(bundle ? `lint:overlay --bundle — ${resolveOverlay().kind} build is clean` : "lint:overlay — clean");
}
