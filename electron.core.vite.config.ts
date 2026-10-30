import { resolve } from "node:path";
import { defineConfig } from "electron-vite";
import { mainBuildSection } from "./scripts/vite-sections";

/**
 * The core process's own bundle (Wave 3). It is a separate build from
 * `electron.vite.config.ts` on purpose: one Rollup build with both entries
 * gives them shared chunks, and a module only the core needs then rides a
 * chunk the window loads, so main runs the core's module-level singletons as
 * empty copies. Two builds duplicate the small stateless code between them and
 * keep everything else apart.
 *
 * Run second, over the same `out/main`, and never clear it (the window's
 * bundle and the preload are already there):
 *
 *   electron-vite build && electron-vite build -c electron.core.vite.config.ts
 *
 * `electron.vite.config.ts` uses mainBuildSection too, so both sides compile
 * with one alias table, one define set and one plugin list (the `?nodeWorker`
 * imports the core's state workers need).
 */
export default defineConfig(({ command, mode }) => ({
  main: mainBuildSection({
    command,
    mode,
    input: { "core-process": resolve("src/main/core-process/entry.ts") },
    emptyOutDir: false,
  }),
}));
