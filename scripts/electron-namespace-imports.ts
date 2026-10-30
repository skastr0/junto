import type { Plugin } from "vite";

const NAMED_ELECTRON_IMPORT = /^import\s*\{([^}]*)\}\s*from\s*["']electron["'];?$/gm;

/**
 * Main and the core process entry share chunks, and inside a utilityProcess
 * electron has no main-only exports (`app`, `utilityProcess`), so a named
 * import of one fails the whole core at load. Each named import becomes a read
 * off the namespace: a missing export is undefined there, and only a call to it
 * fails, which no core path makes.
 */
export const rewriteElectronNamedImports = (code: string): string => {
  let index = 0;
  return code.replace(NAMED_ELECTRON_IMPORT, (_line, names: string) => {
    const namespace = `__electron${index++}`;
    const bindings = names
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean)
      .map((name) => {
        const [imported, local] = name.split(/\s+as\s+/);
        return local ? `${imported}: ${local}` : imported;
      });
    return `import * as ${namespace} from "electron";\nconst { ${bindings.join(", ")} } = ${namespace};`;
  });
};

export const electronNamespaceImports = (): Plugin => ({
  name: "junto:electron-namespace-imports",
  renderChunk: (code) => ({ code: rewriteElectronNamedImports(code), map: null }),
});
