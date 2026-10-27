/**
 * The sandboxed preload carries only what a sandbox can run: its own
 * modules, `src/shared` modules, and `require("electron")`. Anything else
 * bundled or required breaks the window before `window.junto` exists:
 * Effect's scheduler setup throws inside the sandbox wrapper (3bd21bb30,
 * 4cd57bdc3), and the sandbox's `require` has no Node built-ins or packages.
 *
 * `preloadBundleGuard` is a Rollup plugin on electron-vite's preload build:
 * it reads the bundle the build is about to write and fails the build on a
 * module outside the allow list, naming the module and what imported it.
 * `tests/preload-bundle.test.ts` runs the same build in memory at commit
 * time.
 */
import { relative, sep } from "node:path";
import type { Plugin } from "vite";

/** Folders whose modules the preload may bundle, relative to the repository. */
export const PRELOAD_BUNDLED_ALLOWED = ["src/preload/", "src/shared/"] as const;

/** What the preload may leave to the sandbox's `require`. */
export const PRELOAD_EXTERNAL_ALLOWED = ["electron"] as const;

const EFFECT = /(^|[\\/]node_modules[\\/])(effect|@effect[\\/][^\\/]+)([\\/]|$)/;

const shown = (root: string, id: string): string => {
  const path = id.replace(/\?.*$/, "");
  return path.startsWith(root) ? relative(root, path).split(sep).join("/") : path;
};

/** Why the preload may not carry `id`, or undefined when it may. */
export const preloadModuleRefusal = (
  root: string,
  id: string,
  external: boolean,
): string | undefined => {
  if (EFFECT.test(id) || id === "effect" || id.startsWith("effect/")) {
    return "Effect is refused in the sandboxed preload: its scheduler setup throws there and window.junto never appears";
  }
  if (external) {
    return (PRELOAD_EXTERNAL_ALLOWED as readonly string[]).includes(id)
      ? undefined
      : `the preload may require only ${PRELOAD_EXTERNAL_ALLOWED.join(", ")} (Electron's sandbox also offers events, timers and url; add one to PRELOAD_EXTERNAL_ALLOWED to use it)`;
  }
  const path = shown(root, id);
  return PRELOAD_BUNDLED_ALLOWED.some((folder) => path.startsWith(folder))
    ? undefined
    : `the preload bundles only ${PRELOAD_BUNDLED_ALLOWED.join(" and ")}`;
};

/** The package a node_modules path belongs to, such as `effect` or `@effect/platform`. */
const packageOf = (id: string): string | undefined => {
  const at = id.lastIndexOf("node_modules");
  if (at < 0) return undefined;
  const [first, second] = id.slice(at + "node_modules".length + 1).split(/[\\/]/);
  return first?.startsWith("@") ? `${first}/${second}` : first;
};

export type PreloadRefusal = {
  readonly module: string;
  readonly importers: readonly string[];
  readonly reason: string;
};

export const describePreloadRefusals = (refusals: readonly PreloadRefusal[]): string =>
  [
    "the preload bundle carries modules a sandboxed preload cannot run:",
    ...refusals.map(
      (refusal) =>
        `  ${refusal.module} (imported by ${refusal.importers.join(", ") || "the entry"}): ${refusal.reason}`,
    ),
  ].join("\n");

export type PreloadBundleReport = {
  /** Every module bundled, repository-relative, and every external required. */
  readonly bundled: readonly string[];
  readonly external: readonly string[];
  readonly refusals: readonly PreloadRefusal[];
};

export const preloadBundleGuard = (
  report: (found: PreloadBundleReport) => void = () => undefined,
): Plugin => {
  let root = process.cwd();
  return {
    name: "junto:preload-bundle-guard",
    apply: "build",
    configResolved(config) {
      root = config.root;
    },
    generateBundle(_options, bundle) {
      const bundled: string[] = [];
      const external: string[] = [];
      const refusals: PreloadRefusal[] = [];
      const importersOf = (id: string): string[] =>
        [...(this.getModuleInfo(id)?.importers ?? []), ...(this.getModuleInfo(id)?.dynamicImporters ?? [])]
          .map((importer) => shown(root, importer));
      for (const chunk of Object.values(bundle)) {
        if (chunk.type !== "chunk") continue;
        // A package is one refusal, named at the imports that reach into it
        // from outside. Its index is often tree-shaken away, so those are
        // found from the importing side.
        const modules = Object.keys(chunk.modules);
        const packages = new Map<string, { importers: Set<string>; reason: string }>();
        for (const id of modules) {
          bundled.push(shown(root, id));
          const reason = preloadModuleRefusal(root, id, false);
          if (reason === undefined) continue;
          const name = packageOf(id);
          if (name === undefined) {
            refusals.push({ module: shown(root, id), importers: importersOf(id), reason });
          } else if (!packages.has(name)) {
            packages.set(name, { importers: new Set(), reason });
          }
        }
        for (const id of modules) {
          const info = this.getModuleInfo(id);
          for (const target of [...(info?.importedIds ?? []), ...(info?.dynamicallyImportedIds ?? [])]) {
            const name = packageOf(target);
            if (name !== undefined && name !== packageOf(id)) packages.get(name)?.importers.add(shown(root, id));
          }
        }
        for (const [name, held] of packages) {
          refusals.push({ module: name, importers: [...held.importers], reason: held.reason });
        }
        for (const id of [...chunk.imports, ...chunk.dynamicImports]) {
          if (bundle[id] !== undefined) continue;
          external.push(id);
          const reason = preloadModuleRefusal(root, id, true);
          if (reason !== undefined) refusals.push({ module: id, importers: importersOf(id), reason });
        }
      }
      report({ bundled, external, refusals });
      if (refusals.length > 0) this.error(describePreloadRefusals(refusals));
    },
  };
};
