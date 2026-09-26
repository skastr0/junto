import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import {
  featureViteDefines,
  resolveBuildFeatures,
} from "./scripts/build-features";
import { overlayAlias, overlayDepsPlugin, resolveOverlay } from "./scripts/overlay";

// Premium content joins at build time only: JUNTO_OVERLAY picks the overlay
// checkout, unset builds the open-source app (docs/overlay.md).
const overlay = resolveOverlay(process.env);

const alias = {
  "@main": resolve("src/main"),
  "@preload": resolve("src/preload"),
  "@renderer": resolve("src/renderer"),
  "@shared": resolve("src/shared"),
  ...overlayAlias(overlay),
};

// Build-time update feed only — never honored as a runtime env override.
// Empty → macArm64UpdateFeed() uses the interim/public default in compiled-config.
const updateFeedUrl = (process.env.JUNTO_MAC_UPDATE_FEED_URL ?? "").trim();
const updateDefines = {
  __JUNTO_MAC_UPDATE_FEED_URL__: JSON.stringify(updateFeedUrl),
};

const resolvedBuildFeatures = resolveBuildFeatures(process.env);

const productDefines = {
  ...updateDefines,
  __JUNTO_MAC_SIGNING_IDENTITY__: JSON.stringify(process.env.JUNTO_MAC_SIGNING_IDENTITY ?? ""),
  __JUNTO_MAC_TEAM_ID__: JSON.stringify(process.env.JUNTO_MAC_TEAM_ID ?? ""),
  ...featureViteDefines(resolvedBuildFeatures),
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin(), overlayDepsPlugin(overlay)],
    resolve: { alias },
    define: productDefines,
  },
  preload: {
    plugins: [externalizeDepsPlugin(), overlayDepsPlugin(overlay)],
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
    plugins: [overlayDepsPlugin(overlay), react(), tailwindcss()],
    // The dev server may serve overlay files from outside this repository.
    ...(overlay.kind === "official" ? { server: { fs: { allow: [".", overlay.dir] } } } : {}),
    build: {
      rollupOptions: {
        input: resolve("index.html"),
      },
    },
  },
});
