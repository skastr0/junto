import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Plugin } from "vite";

/**
 * out/build-source.json names the commit the last complete `electron-vite
 * build` compiled. scripts/run-e2e.sh refuses to launch out/ without it, so a
 * failed rebuild can never run the previous build's code. Not packaged: the
 * electron-builder `files` allowlist names out/ entries one by one.
 */
export const BUILD_SOURCE_STAMP = "out/build-source.json";

const stampPath = (root: string): string => join(root, BUILD_SOURCE_STAMP);

/** First section built (main): forget the previous build's stamp. */
export const clearBuildSourceStamp = (root: string): Plugin => ({
  name: "junto:clear-build-source-stamp",
  apply: "build",
  buildStart() {
    rmSync(stampPath(root), { force: true });
  },
});

/** Last section built (renderer): stamp only after its bundle is written. */
export const writeBuildSourceStamp = (root: string): Plugin => ({
  name: "junto:write-build-source-stamp",
  apply: "build",
  writeBundle() {
    let sourceCommit: string;
    try {
      sourceCommit = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    } catch {
      return;
    }
    mkdirSync(dirname(stampPath(root)), { recursive: true });
    writeFileSync(stampPath(root), `${JSON.stringify({ sourceCommit })}\n`);
  },
});
