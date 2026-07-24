/**
 * Resolve the on-disk source path for packages/vellum-plugin.
 * Dev: repo packages/vellum-plugin. Packaged: resources next to app when present.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PLUGIN_MARKER = "plugin.json";

const looksLikePlugin = (dir: string): boolean =>
  existsSync(join(dir, PLUGIN_MARKER));

/**
 * Walk up from a start path looking for packages/vellum-plugin.
 */
const findFrom = (start: string, maxDepth = 8): string | undefined => {
  let current = resolve(start);
  for (let i = 0; i < maxDepth; i += 1) {
    const candidate = join(current, "packages", "vellum-plugin");
    if (looksLikePlugin(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return undefined;
};

export const resolveVellumPluginPath = (): string | undefined => {
  const env = process.env.VELLUM_PLUGIN_PATH?.trim();
  if (env && looksLikePlugin(env)) return resolve(env);

  const fromCwd = findFrom(process.cwd());
  if (fromCwd) return fromCwd;

  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const fromModule = findFrom(here, 12);
    if (fromModule) return fromModule;
  } catch {
    // ignore
  }

  return undefined;
};
