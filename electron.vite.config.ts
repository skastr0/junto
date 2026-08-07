import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import {
  resolveLicenseBuildProfile,
} from "./scripts/license-build-profile";
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

const licenseChannel = process.env.VELLUM_COMMAND_LICENSE_CHANNEL ?? "development";
if (!["development", "production"].includes(licenseChannel)) {
  throw new Error("VELLUM_COMMAND_LICENSE_CHANNEL must be development or production");
}
const licenseProfile =
  licenseChannel === "development"
    ? undefined
    : resolveLicenseBuildProfile({
        channel: licenseChannel,
        businessId: process.env.VELLUM_COMMAND_DODO_BUSINESS_ID,
        productIds: process.env.VELLUM_COMMAND_DODO_PRODUCT_IDS,
      });

const licenseDefines = {
  __VELLUM_COMMAND_LICENSE_CHANNEL__: JSON.stringify(licenseChannel),
  __VELLUM_COMMAND_DODO_BUSINESS_ID__: JSON.stringify(
    licenseProfile?.businessId ?? (process.env.VELLUM_COMMAND_DODO_BUSINESS_ID ?? ""),
  ),
  __VELLUM_COMMAND_DODO_PRODUCT_IDS__: JSON.stringify(
    licenseProfile?.productIds ??
      (process.env.VELLUM_COMMAND_DODO_PRODUCT_IDS ?? "")
        .split(",")
        .map((productId) => productId.trim())
        .filter((productId) => productId.length > 0),
  ),
};

// Build-time update feed only — never honored as a runtime env override.
// Empty → macArm64UpdateFeed() uses the interim/public default in compiled-config.
const updateFeedUrl = (process.env.VELLUM_COMMAND_MAC_UPDATE_FEED_URL ?? "").trim();
const updateDefines = {
  __VELLUM_COMMAND_MAC_UPDATE_FEED_URL__: JSON.stringify(updateFeedUrl),
};

const resolvedBuildFeatures = resolveBuildFeatures(process.env);

const productDefines = {
  ...licenseDefines,
  ...updateDefines,
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
