import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import {
  resolveLicenseBuildProfile,
} from "./scripts/license-build-profile";

const alias = {
  "@main": resolve("src/main"),
  "@preload": resolve("src/preload"),
  "@renderer": resolve("src/renderer"),
  "@shared": resolve("src/shared"),
};

const licenseChannel = process.env.VELLUM_LICENSE_CHANNEL ?? "development";
if (!["development", "beta", "production"].includes(licenseChannel)) {
  throw new Error(
    "VELLUM_LICENSE_CHANNEL must be development, beta, or production",
  );
}
const licenseProfile =
  licenseChannel === "development"
    ? undefined
    : resolveLicenseBuildProfile({
        channel: licenseChannel,
        businessId: process.env.VELLUM_DODO_BUSINESS_ID,
        productId: process.env.VELLUM_DODO_PRODUCT_ID,
      });

const licenseDefines = {
  __VELLUM_LICENSE_CHANNEL__: JSON.stringify(licenseChannel),
  __VELLUM_DODO_BUSINESS_ID__: JSON.stringify(
    licenseProfile?.businessId ?? (process.env.VELLUM_DODO_BUSINESS_ID ?? ""),
  ),
  __VELLUM_DODO_PRODUCT_ID__: JSON.stringify(
    licenseProfile?.productId ?? (process.env.VELLUM_DODO_PRODUCT_ID ?? ""),
  ),
};

// Build-time update feed only — never honored as a runtime env override.
// Empty → macArm64UpdateFeed() uses the interim/public default in compiled-config.
const updateFeedUrl = (process.env.VELLUM_MAC_UPDATE_FEED_URL ?? "").trim();
const updateDefines = {
  __VELLUM_MAC_UPDATE_FEED_URL__: JSON.stringify(updateFeedUrl),
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    define: { ...licenseDefines, ...updateDefines },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
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
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: resolve("index.html"),
      },
    },
  },
});
