/**
 * Packages the window must load exactly once. Each keeps module-level state
 * that other packages check by identity: CodeMirror's facets and `instanceof`
 * checks, Lezer's node props, React's dispatcher, a store's registry. Two
 * copies in one bundle break at run time, not at build time: 0.12.1 shipped
 * two `@codemirror/state` and two `@codemirror/view` in one chunk, and every
 * region briefing, Tasks node and Artifacts node crashed on open with
 * "Unrecognized extension value in extension set".
 *
 * `RENDERER_SINGLETONS` is the renderer's `resolve.dedupe`: Vite resolves
 * each of them from the repository root whoever imports it, so a stale,
 * mixed or nested node_modules still bundles one copy.
 * `rendererSingletonGuard` fails the build when one of them still reaches the
 * bundle from two package folders, naming both.
 */
import { relative, sep } from "node:path";
import type { Plugin } from "vite";

export const RENDERER_SINGLETONS = [
  "react",
  "react-dom",
  "@codemirror/autocomplete",
  "@codemirror/commands",
  "@codemirror/lang-markdown",
  "@codemirror/language",
  "@codemirror/language-data",
  "@codemirror/search",
  "@codemirror/state",
  "@codemirror/streamparser",
  "@codemirror/view",
  "@lezer/common",
  "@lezer/highlight",
  "@lezer/lr",
  "@lezer/markdown",
  "style-mod",
  "@legendapp/state",
  "@xyflow/react",
  "@xyflow/system",
  "zustand",
  "@dnd-kit/abstract",
  "@dnd-kit/dom",
  "@dnd-kit/helpers",
  "@dnd-kit/react",
  "@dnd-kit/state",
  "@preact/signals-core",
  "motion",
  "framer-motion",
  "motion-dom",
  "effect",
  "@xterm/xterm",
  "@pierre/theming",
] as const;

const NODE_MODULES = `${sep}node_modules${sep}`;

/** The package a bundled module belongs to and the folder it came from, or undefined for app source. */
export const packageFolderOf = (id: string): { readonly name: string; readonly folder: string } | undefined => {
  const path = id.replace(/^\0/, "").replace(/\?.*$/, "").split("/").join(sep);
  const at = path.lastIndexOf(NODE_MODULES);
  if (at < 0) return undefined;
  const start = at + NODE_MODULES.length;
  const [first, second] = path.slice(start).split(sep);
  if (first === undefined || first === "") return undefined;
  const name = first.startsWith("@") && second !== undefined ? `${first}/${second}` : first;
  return { name, folder: path.slice(0, start + name.length) };
};

/** Each singleton the bundle carries from more than one package folder, with those folders. */
export const duplicatedSingletons = (
  moduleIds: Iterable<string>,
  singletons: readonly string[] = RENDERER_SINGLETONS,
): ReadonlyMap<string, readonly string[]> => {
  const watched = new Set(singletons);
  const folders = new Map<string, Set<string>>();
  for (const id of moduleIds) {
    const found = packageFolderOf(id);
    if (found === undefined || !watched.has(found.name)) continue;
    const held = folders.get(found.name) ?? new Set<string>();
    held.add(found.folder);
    folders.set(found.name, held);
  }
  const duplicated = new Map<string, readonly string[]>();
  for (const [name, held] of folders) {
    if (held.size > 1) duplicated.set(name, [...held].sort());
  }
  return duplicated;
};

export const describeDuplicatedSingletons = (root: string, duplicated: ReadonlyMap<string, readonly string[]>): string =>
  [
    "the window bundle carries more than one copy of a package it must load once (scripts/renderer-singletons.ts):",
    ...[...duplicated].map(
      ([name, folders]) =>
        `  ${name} from ${folders.map((folder) => relative(root, folder).split(sep).join("/") || folder).join(" and ")}`,
    ),
    "Reinstall with bun install --frozen-lockfile, or add the package to RENDERER_SINGLETONS.",
  ].join("\n");

export const rendererSingletonGuard = (): Plugin => {
  let root = process.cwd();
  return {
    name: "junto:renderer-singleton-guard",
    apply: "build",
    configResolved(config) {
      root = config.root;
    },
    generateBundle(_options, bundle) {
      const ids: string[] = [];
      for (const chunk of Object.values(bundle)) {
        if (chunk.type === "chunk") ids.push(...Object.keys(chunk.modules));
      }
      const duplicated = duplicatedSingletons(ids);
      if (duplicated.size > 0) this.error(describeDuplicatedSingletons(root, duplicated));
    },
  };
};
