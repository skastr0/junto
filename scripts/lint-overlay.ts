#!/usr/bin/env bun
// Overlay gates (docs/overlay.md).
//
//   bun scripts/lint-overlay.ts            import law: overlay code is reached
//                                          only through the `@junto/overlay` alias
//   bun scripts/lint-overlay.ts --bundle [--out DIR]
//                                          after `electron-vite build`: out/ holds
//                                          exactly the overlay this build resolved,
//                                          so an open-source build carries no
//                                          premium marker at all
import { readdir, readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OSS_OVERLAY_MARKER, OVERLAY_MARKER_PATTERN } from "../src/shared/overlay-contract";
import { resolveOverlay } from "./overlay";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SOURCE_DIRS = ["src", "tests", "scripts", "e2e"];
const SKIP = new Set(["node_modules", "out", "dist", "release", "test-results"]);
// Only the resolver names the stub by path; everything else imports the alias.
const PATH_OWNERS = new Set(["scripts/overlay.ts", "scripts/lint-overlay.ts"]);

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

async function checkBundle(outDir: string): Promise<string[]> {
  const overlay = resolveOverlay();
  const markers = new Set<string>();
  let scanned = 0;
  for await (const path of files(outDir, /\.(?:js|cjs|mjs|html|css|json)$/)) {
    scanned += 1;
    for (const match of (await readFile(path, "utf8")).matchAll(OVERLAY_MARKER_PATTERN)) markers.add(match[0]);
  }
  if (scanned === 0) return [`${outDir} is empty; run electron-vite build first`];
  return bundleMarkerViolations(markers, overlay.kind);
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
