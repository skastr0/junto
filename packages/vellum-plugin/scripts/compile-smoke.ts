#!/usr/bin/env bun
/**
 * Pragmatic acceptance: packagePluginForTarget dry-run for opt-in tools targets.
 * Phase 6: hooks/rules/skills pruned — tools only.
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

/**
 * Concrete harnesses covered by targets.tools (coding-harness family + hermes).
 * plugin.json lists families; packager dry-run needs a concrete harness id.
 */
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

    // Phase 6: no session-start hook or global rules/skills/vellum doctrine lowering.
    // Packager may still emit empty hooks.json / prism-tools-* skill wrappers for tools.
    const lowered = filePaths.join("\n");
    if (/session-start/i.test(lowered) || /rules\/.*vellum|skills\/vellum\//i.test(lowered)) {
      throw new Error(
        `${target}: unexpected session-start or global vellum rule/skill in compile output`,
      );
    }

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
