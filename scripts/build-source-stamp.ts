import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Plugin } from "vite";
import { featureProfileName, type FeatureProfileName } from "./build-features";

/**
 * out/build-source.json names the commit the last complete `electron-vite
 * build` compiled, and the feature profile it compiled with (ship or all-on),
 * so a spec reads which build it runs against. scripts/run-e2e.sh refuses to
 * launch out/ without it, so a failed rebuild can never run the previous
 * build's code. Not packaged: the electron-builder `files` allowlist names
 * out/ entries one by one.
 */
export const BUILD_SOURCE_STAMP = "out/build-source.json";

export type BuildSourceStamp = { readonly sourceCommit: string; readonly featureProfile: FeatureProfileName };

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
    const stamp: BuildSourceStamp = { sourceCommit, featureProfile: featureProfileName(process.env) };
    writeFileSync(stampPath(root), `${JSON.stringify(stamp)}\n`);
  },
});
