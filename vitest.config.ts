import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

// Mirrors electron.vite.config.ts's alias map. Vitest does not read
// electron-vite's own config file, so without this, any test that reaches a
// `@shared/*` VALUE import (not just a type-only import, which erases at
// transpile time) fails with "Cannot find package '@shared/...'" — the gap
// this file closes. Before this existed, the one test that needed it
// (b5-races-canvases.test.ts) worked around the gap with its own per-file
// `vi.mock("@shared/canvas", ...)` redirect; this makes that workaround
// unnecessary for every test going forward.
export default defineConfig({
  resolve: {
    alias: {
      "@shared": resolve(__dirname, "src/shared"),
      "@main": resolve(__dirname, "src/main"),
      "@renderer": resolve(__dirname, "src/renderer"),
    },
  },
});
