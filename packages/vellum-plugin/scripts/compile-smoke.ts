#!/usr/bin/env bun
/**
 * Pragmatic acceptance: packagePluginForTarget dry-run for the Tier-3 min set.
 *
 * Run from repo root or package dir:
 *   bun packages/vellum-plugin/scripts/compile-smoke.ts
 *   bun run --cwd packages/vellum-plugin compile-smoke
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  packagePluginForTarget,
  type PackageResult,
} from "@skastr0/prism-packager";

const here = dirname(fileURLToPath(import.meta.url));
const pluginPath = resolve(here, "..");

/** Operator-locked Tier-3 minimum harness set. */
const targets = ["claude-code", "codex-cli", "grok", "hermes"] as const;

const summarize = (result: PackageResult) => ({
  target: result.target,
  packageId: result.packageId,
  operations: result.operations.length,
  compileFiles: result.compileFiles.length,
  compileRegions: result.compileRegions.length,
});

const main = async () => {
  const out = await mkdtemp(join(tmpdir(), "vellum-plugin-compile-"));
  const results: Array<ReturnType<typeof summarize>> = [];

  for (const target of targets) {
    const result = await packagePluginForTarget({
      pluginPath,
      target,
      dryRun: true,
      out: join(out, target),
      generatorVersion: "0.0.0-vellum-plugin-smoke",
    });

    if (!result.packageId.startsWith("prism-generated-")) {
      throw new Error(
        `${target}: unexpected packageId ${result.packageId}`,
      );
    }
    if (result.compileFiles.length === 0 && result.operations.length === 0) {
      throw new Error(
        `${target}: empty compileFiles and operations — packager returned nothing`,
      );
    }

    const filePaths = result.compileFiles
      .map((f) => {
        if (typeof f === "object" && f !== null && "targetPath" in f) {
          return String((f as { targetPath: string }).targetPath);
        }
        return String(f);
      })
      .map((p) => p.split("/").slice(-4).join("/"));

    results.push(summarize(result));
    console.log(
      `${target}: packageId=${result.packageId} ops=${result.operations.length} files=${result.compileFiles.length} regions=${result.compileRegions.length}`,
    );
    for (const p of filePaths.slice(0, 12)) {
      console.log(`  - ${p}`);
    }
  }

  console.log(JSON.stringify({ ok: true, pluginPath, results }, null, 2));
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
