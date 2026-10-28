/**
 * The window's first load stays clear of the heavy engines: the code editor,
 * the diff library with its highlighter, and the file tree load only when a
 * surface that draws them opens. The package audit bounds the main chunk at
 * 8 MiB (scripts/audit-retired-state-signatures.ts) and these engines were
 * over 2 MB of it; a static import from boot code puts them back.
 *
 * Walks every static import reachable from src/renderer/main.tsx (not
 * `import type`, not `import()`) and fails on a package below.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");
const ENTRY = join(ROOT, "src/renderer/main.tsx");
const ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["@renderer/", "src/renderer/"],
  ["@shared/", "src/shared/"],
];
const LAZY_ONLY = ["@codemirror/", "@lezer/", "@pierre/diffs", "@pierre/trees", "shiki", "@shikijs/"];

const STATIC_IMPORT = /^\s*(?:import|export)\s+(?!type\b)(?:[^;'"]*?\s+from\s+)?["']([^"']+)["']/gm;

const resolveLocal = (from: string, specifier: string): string | undefined => {
  const alias = ALIASES.find(([prefix]) => specifier.startsWith(prefix));
  const base = alias
    ? join(ROOT, alias[1], specifier.slice(alias[0].length))
    : specifier.startsWith(".")
      ? resolve(dirname(from), specifier)
      : undefined;
  if (base === undefined) return undefined;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (/\.tsx?$/.test(candidate) && existsSync(candidate)) return candidate;
  }
  return undefined;
};

/** Each package boot code imports, with the first file found importing it. */
const bootPackages = (): ReadonlyMap<string, string> => {
  const seen = new Set<string>();
  const packages = new Map<string, string>();
  const queue = [ENTRY];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    for (const [, specifier] of readFileSync(file, "utf8").matchAll(STATIC_IMPORT)) {
      if (specifier === undefined || specifier.endsWith(".css")) continue;
      const local = resolveLocal(file, specifier);
      if (local !== undefined) queue.push(local);
      else if (!specifier.startsWith(".") && !packages.has(specifier)) packages.set(specifier, relative(ROOT, file));
    }
  }
  return packages;
};

describe("renderer boot graph", () => {
  it("reaches the window's own code", () => {
    const packages = bootPackages();
    expect(packages.has("react")).toBe(true);
    expect(packages.has("@xyflow/react")).toBe(true);
  });

  it("imports no editor, diff or file tree engine statically", () => {
    const heavy = [...bootPackages()]
      .filter(([specifier]) => LAZY_ONLY.some((prefix) => specifier.startsWith(prefix)))
      .map(([specifier, file]) => `${specifier} from ${file}`);
    expect(heavy).toEqual([]);
  });
});
