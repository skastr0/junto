import { resolve } from "node:path";
import { writeBuildSourceStamp } from "./scripts/build-source-stamp";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { buildContext, mainBuildSection } from "./scripts/vite-sections";
import { overlayDepsPlugin } from "./scripts/overlay";
import { preloadBundleGuard } from "./scripts/preload-bundle-guard";

/**
 * A perf build (JUNTO_PERF_BUILD=1, for measurement, never shipped): the
 * window gets source maps, so a CPU profile resolves each frame to the package
 * and file that spent the time, and React's profiling build, which keeps
 * <Profiler> timings and writes its Scheduler and Components tracks into a
 * Chromium trace. Without the variable the build is byte for byte the same.
 */
const PERF_BUILD = process.env.JUNTO_PERF_BUILD === "1";

export default defineConfig(({ command, mode }) => {
  const { overlay, alias, productDefines } = buildContext({ command, mode });
  const rendererAlias = PERF_BUILD
    ? [
        ...Object.entries(alias).map(([find, replacement]) => ({ find, replacement })),
        { find: /^react-dom\/client$/, replacement: "react-dom/profiling" },
      ]
    : alias;
  // Dev keeps both entries in one build: the app forks out/main/core-process.js,
  // and a second watcher for it would be a build system of its own. The
  // production build splits them (electron.core.vite.config.ts), so a module
  // only the core needs cannot ride a chunk the window also loads.
  const mainInput: Record<string, string> =
    command === "serve"
      ? {
          index: resolve("src/app/index.ts"),
          "core-process": resolve("src/core/entry.ts"),
          "terminal-process": resolve("src/terminal/entry.ts"),
        }
      : { index: resolve("src/app/index.ts") };

  return {
    main: mainBuildSection({ command, mode, input: mainInput, stampBuild: true }),
    preload: {
      // The sandboxed preload carries only src/window/preload, src/shared and
      // require("electron"); anything else fails the build.
      plugins: [externalizeDepsPlugin(), overlayDepsPlugin(overlay), preloadBundleGuard()],
      resolve: { alias },
      define: productDefines,
      build: {
        rollupOptions: {
          input: { index: resolve("src/window/preload/index.ts") },
          output: {
            format: "cjs",
            entryFileNames: "[name].cjs",
          },
        },
      },
    },
    renderer: {
      root: ".",
      // One React for the whole renderer. Without this, a fresh install can
      // resolve the app's `react` and the copy `react-dom` requires as two
      // modules: the root renders with one dispatcher and every hook reads
      // the other, so the first component throws on a null `useEffect`.
      resolve: { alias: rendererAlias, dedupe: ["react", "react-dom"] },
      define: productDefines,
      plugins: [overlayDepsPlugin(overlay), react(), tailwindcss(), writeBuildSourceStamp(process.cwd())],
      // The dev server may serve overlay files from outside this repository.
      ...(overlay.kind === "official" ? { server: { fs: { allow: [".", overlay.dir] } } } : {}),
      build: {
        ...(PERF_BUILD ? { sourcemap: true } : {}),
        rollupOptions: {
          input: resolve("index.html"),
        },
      },
    },
  };
});
