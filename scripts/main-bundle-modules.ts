/**
 * Rollup plugin for the main build: writes `out/main/bundle-modules.json`,
 * which names the source modules each entry statically loads. The emitted
 * chunk says *that* the core is in main's bundle but not *which file* put it
 * there; this manifest answers that, so the bundle-closure gate
 * (scripts/lint-main-bundle.ts) can name an offender by source module.
 *
 * Build output only: the file lives in out/, is never imported, and ships in
 * nothing.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Plugin, OutputBundle, OutputChunk } from "rollup";

type Entries = Record<string, ReadonlyArray<string>>;

const moduleIdsFor = (
  entry: OutputChunk,
  chunks: ReadonlyMap<string, OutputChunk>,
): ReadonlyArray<string> => {
  const visited = new Set<string>();
  const modules = new Set<string>();
  const visit = (fileName: string): void => {
    if (visited.has(fileName)) return;
    visited.add(fileName);
    const chunk = chunks.get(fileName);
    if (chunk === undefined) return;
    for (const id of chunk.moduleIds) modules.add(id);
    for (const imported of chunk.imports) visit(imported);
  };
  visit(entry.fileName);
  return [...modules];
};

export const mainBundleModules = (root: string = process.cwd()): Plugin => ({
  name: "junto-main-bundle-modules",
  writeBundle(options, bundle: OutputBundle) {
    const chunks = new Map<string, OutputChunk>();
    for (const item of Object.values(bundle)) {
      if (item.type === "chunk") chunks.set(item.fileName, item);
    }
    const entries: Entries = {};
    for (const chunk of chunks.values()) {
      if (!chunk.isEntry) continue;
      entries[chunk.name] = moduleIdsFor(chunk, chunks).map((id) =>
        relative(root, id).split(sep).join("/"),
      );
    }
    const dir = options.dir ?? join(root, "out", "main");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "bundle-modules.json"),
      `${JSON.stringify({ entries }, null, 2)}\n`,
    );
  },
});
