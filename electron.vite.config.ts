import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

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

const licenseDefines = {
  __VELLUM_LICENSE_CHANNEL__: JSON.stringify(licenseChannel),
  __VELLUM_DODO_BUSINESS_ID__: JSON.stringify(
    process.env.VELLUM_DODO_BUSINESS_ID ?? "",
  ),
  __VELLUM_DODO_PRODUCT_ID__: JSON.stringify(
    process.env.VELLUM_DODO_PRODUCT_ID ?? "",
  ),
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias },
    define: licenseDefines,
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
