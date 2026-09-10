import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import {
  featureViteDefines,
  resolveBuildFeatures,
} from "./scripts/build-features";

const alias = {
  "@main": resolve("src/main"),
  "@preload": resolve("src/preload"),
  "@renderer": resolve("src/renderer"),
  "@shared": resolve("src/shared"),
};

// Build-time update feed only — never honored as a runtime env override.
// Empty → macArm64UpdateFeed() uses the interim/public default in compiled-config.
const updateFeedUrl = (process.env.VELLUM_COMMAND_MAC_UPDATE_FEED_URL ?? "").trim();
const updateDefines = {
  __VELLUM_COMMAND_MAC_UPDATE_FEED_URL__: JSON.stringify(updateFeedUrl),
};

const resolvedBuildFeatures = resolveBuildFeatures(process.env);

const productDefines = {
  ...updateDefines,
  __VELLUM_COMMAND_MAC_SIGNING_IDENTITY__: JSON.stringify(process.env.VELLUM_COMMAND_MAC_SIGNING_IDENTITY ?? ""),
  __VELLUM_COMMAND_MAC_TEAM_ID__: JSON.stringify(process.env.VELLUM_COMMAND_MAC_TEAM_ID ?? ""),
  ...featureViteDefines(resolvedBuildFeatures),
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    define: productDefines,
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
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
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: resolve("index.html"),
      },
    },
  },
});
