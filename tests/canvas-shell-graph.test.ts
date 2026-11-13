/**
 * The GPU canvas shell's done-test (docs/canvas-gpu-plan.md, track G): with
 * the switch on, no module in the mounted tree imports React Flow.
 *
 * Walks every static import reachable from the shell host (not `import type`,
 * not `import()`), the way renderer-boot-graph.test.ts walks the window's boot
 * graph. The old canvas is handed to the host as a ReactNode, not imported by
 * it, so the walk reaches the GPU canvas and none of React Flow's consumers.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(__dirname, "..");
const HOST = join(ROOT, "src/window/canvas/shell/CanvasHost.tsx");
const ALIASES: ReadonlyArray<readonly [string, string]> = [
  ["@window/", "src/window/"],
  ["@shared/", "src/shared/"],
];

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

type Walk = {
  readonly files: ReadonlyArray<string>;
  readonly packages: ReadonlyArray<{ readonly specifier: string; readonly from: string }>;
};

const walk = (): Walk => {
  const seen = new Set<string>();
  const packages: Array<{ specifier: string; from: string }> = [];
  const queue = [HOST];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    for (const [, specifier] of readFileSync(file, "utf8").matchAll(STATIC_IMPORT)) {
      if (specifier === undefined || specifier.endsWith(".css")) continue;
      const local = resolveLocal(file, specifier);
      if (local !== undefined) queue.push(local);
      else if (!specifier.startsWith(".")) packages.push({ specifier, from: relative(ROOT, file) });
    }
  }
  return { files: [...seen].map((file) => relative(ROOT, file)).sort(), packages };
};

describe("the GPU canvas shell's import graph", () => {
  const graph = walk();

  it("reaches the GPU canvas and its CanvasApi", () => {
    expect(graph.files).toContain("src/window/canvas/shell/GpuCanvas.tsx");
    expect(graph.files).toContain("src/window/canvas/shell/canvas-api.ts");
    expect(graph.files).toContain("src/window/canvas/shell/surface-mirror.ts");
  });

  it("imports no React Flow module", () => {
    const flow = graph.packages.filter(({ specifier }) => specifier.startsWith("@xyflow/") || specifier.startsWith("react-flow"));
    expect(flow.map(({ specifier, from }) => `${specifier} from ${from}`)).toEqual([]);
  });

  it("does not mount the old canvas through the host", () => {
    expect(graph.files).not.toContain("src/window/components/Canvas.tsx");
  });
});
