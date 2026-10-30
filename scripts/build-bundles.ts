#!/usr/bin/env bun
/**
 * The one build for `out/main`: the window's bundle, then the core's own
 * bundle (electron.core.vite.config.ts).
 *
 * They are two builds because one Rollup build with both entries gives them
 * shared chunks, and a module only the core needs then rides a chunk the
 * window loads: main evaluated the core's module-level singletons as empty
 * copies. Every script that builds and then runs the app, every e2e lane, the
 * release stamp and bun run verify call this, so the app always has
 * `out/main/core-process.js` to fork (src/main/core-process/host.ts:105).
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const electronVite = join(root, "node_modules", ".bin", "electron-vite");

const build = (args: ReadonlyArray<string>): void => {
  const result = spawnSync(electronVite, [...args], {
    cwd: root,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

build(["build"]);
// Second, over the same out/main, without clearing what the first wrote.
build(["build", "-c", "electron.core.vite.config.ts"]);
