#!/usr/bin/env bun
/**
 * Layer gate. App-level stacking has one source: src/renderer/styles/layers.css.
 *
 * Rule (renderer sources): a z-index of 100 or more is an app-level layer and
 * must be a --layer-* token, in css (`z-index: var(--layer-working)`), in an
 * inline style (`zIndex: "var(--layer-flyout)"`) or not at all. Numbers under
 * 100 order things inside one component's own stacking context and inside
 * the base (bars, dock, HUDs), and are left alone.
 *
 * Run: `bun run lint:layers`. Exit 0 = clean; exit 1 = violations printed.
 */
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RENDERER = path.join(ROOT, "src/renderer");
const TOKENS = "src/renderer/styles/layers.css";
const LAYER_FLOOR = 100;

// Canvas internals, owned by the canvas team: order inside the React Flow
// viewport and the loupe. Each leaves this list when its owner moves it to a
// token or shows it never leaves the canvas's own stacking context.
const CANVAS_OWNED = new Set([
  "src/renderer/styles/canvas-lod.css",
  "src/renderer/components/nodes/preamble-bubble.css",
  "src/renderer/components/CanvasMagnifier.css",
]);

const RAW_Z = [
  /z-index:\s*(\d+)/g, // css
  /zIndex:\s*(\d+)/g, // inline style
  /\bz-\[(\d+)\]/g, // tailwind arbitrary value
];

type Hit = { readonly file: string; readonly line: number; readonly text: string; readonly value: number };

const isSource = (name: string): boolean =>
  /\.(?:css|ts|tsx)$/.test(name) && !/\.(?:test|spec)\.tsx?$/.test(name) && !name.endsWith(".d.ts");

const walk = async (dir: string): Promise<string[]> => {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.isFile() && isSource(entry.name)) out.push(full);
  }
  return out;
};

/** Raw layer-sized z-index values in one source text. Exported for tests. */
export const rawLayerValues = (text: string): ReadonlyArray<{ readonly line: number; readonly value: number }> => {
  const found: { line: number; value: number }[] = [];
  text.split(/\r?\n/).forEach((lineText, index) => {
    for (const pattern of RAW_Z) {
      for (const match of lineText.matchAll(pattern)) {
        const value = Number(match[1]);
        if (value >= LAYER_FLOOR) found.push({ line: index + 1, value });
      }
    }
  });
  return found;
};

const main = async (): Promise<void> => {
  const files = await walk(RENDERER);
  const hits: Hit[] = [];
  for (const abs of files) {
    const rel = path.relative(ROOT, abs);
    if (rel === TOKENS || CANVAS_OWNED.has(rel)) continue;
    const raw = await readFile(abs, "utf8");
    const lines = raw.split(/\r?\n/);
    for (const { line, value } of rawLayerValues(raw)) {
      hits.push({ file: rel, line, value, text: (lines[line - 1] ?? "").trim().slice(0, 140) });
    }
  }
  if (hits.length > 0) {
    console.error(`lint:layers: app-level stacking comes from ${TOKENS}; use a --layer-* token\n`);
    for (const hit of hits) console.error(`  ${hit.file}:${hit.line}  z-index ${hit.value}\n    ${hit.text}`);
    console.error(`\nlint:layers: ${hits.length} violation(s)`);
    process.exit(1);
  }
  console.log(`lint:layers: ok (${files.length} renderer files, ${CANVAS_OWNED.size} canvas-owned files exempt)`);
};

if (import.meta.main) await main();
