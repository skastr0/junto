#!/usr/bin/env bun
/**
 * Precompile packages/vellum-plugin for each fleet harness into static JSON
 * payloads checked into the repo.
 *
 * WHY: @skastr0/prism-packager requires Bun (Bun.file, Bun.build). Electron
 * main is Node and must NEVER depend on Bun at runtime. Install applies these
 * frozen payloads; regenerate only when the plugin source changes.
 *
 * Maintainer / CI (Bun required only for this script):
 *   bun scripts/precompile-vellum-plugin.ts
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packagePluginForTarget } from "@skastr0/prism-packager";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const pluginPath = join(repoRoot, "packages", "vellum-plugin");
const outDir = join(
  repoRoot,
  "src",
  "main",
  "vellum",
  "plugin-install",
  "payloads",
);

const TARGETS = ["claude-code", "codex-cli", "grok", "hermes"] as const;

const main = async () => {
  await mkdir(outDir, { recursive: true });
  const index: Array<{ target: string; files: number; regions: number }> = [];

  for (const target of TARGETS) {
    const result = await packagePluginForTarget({
      pluginPath,
      target,
      dryRun: true,
      force: true,
      out: join(outDir, ".pack-tmp", target),
      generatorVersion: "vellum-precompile",
    });

    const payload = {
      schema: "vellum.plugin-package/v1" as const,
      target: result.target,
      packageId: result.packageId,
      packageRoot: result.packageRoot,
      planRoot: result.planRoot,
      operations: result.operations,
      compileFiles: result.compileFiles,
      compileRegions: result.compileRegions,
      precompiledAt: new Date().toISOString(),
    };

    const dest = join(outDir, `${target}.json`);
    await writeFile(dest, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
    index.push({
      target,
      files: result.compileFiles.length,
      regions: result.compileRegions.length,
    });
    console.log(
      `${target}: files=${result.compileFiles.length} regions=${result.compileRegions.length} → ${dest}`,
    );
  }

  await writeFile(
    join(outDir, "index.json"),
    `${JSON.stringify({ schema: "vellum.plugin-package-index/v1", targets: index }, null, 2)}\n`,
    "utf8",
  );
  console.log(JSON.stringify({ ok: true, outDir, targets: index }, null, 2));
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
