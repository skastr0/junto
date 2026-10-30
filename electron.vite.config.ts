import { resolve } from "node:path";
import { writeBuildSourceStamp } from "./scripts/build-source-stamp";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import { buildContext, mainBuildSection } from "./scripts/vite-sections";
import { overlayDepsPlugin } from "./scripts/overlay";
import { preloadBundleGuard } from "./scripts/preload-bundle-guard";

export default defineConfig(({ command, mode }) => {
  const { overlay, alias, productDefines } = buildContext({ command, mode });
  // Dev keeps both entries in one build: the app forks out/main/core-process.js,
  // and a second watcher for it would be a build system of its own. The
  // production build splits them (electron.core.vite.config.ts), so a module
  // only the core needs cannot ride a chunk the window also loads.
  const mainInput =
    command === "serve"
      ? {
          index: resolve("src/main/index.ts"),
          "core-process": resolve("src/main/core-process/entry.ts"),
        }
      : { index: resolve("src/main/index.ts") };

  return {
    main: mainBuildSection({ command, mode, input: mainInput, stampBuild: true }),
    preload: {
      // The sandboxed preload carries only src/preload, src/shared and
      // require("electron"); anything else fails the build.
      plugins: [externalizeDepsPlugin(), overlayDepsPlugin(overlay), preloadBundleGuard()],
      resolve: { alias },
      define: productDefines,
      build: {
        rollupOptions: {
          output: {
            format: "cjs",
            entryFileNames: "[name].cjs",
          },
        },
      },
    },
    renderer: {
      root: ".",
      resolve: { alias },
      define: productDefines,
      plugins: [overlayDepsPlugin(overlay), react(), tailwindcss(), writeBuildSourceStamp(process.cwd())],
      // The dev server may serve overlay files from outside this repository.
      ...(overlay.kind === "official" ? { server: { fs: { allow: [".", overlay.dir] } } } : {}),
      build: {
        rollupOptions: {
          input: resolve("index.html"),
        },
      },
    },
  };
});
