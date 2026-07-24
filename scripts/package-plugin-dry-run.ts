#!/usr/bin/env bun
/**
 * Bun-side packager entry for Electron main.
 *
 * @skastr0/prism-packager ships raw TypeScript and requires Bun. Electron main
 * is Node and cannot load it in-process (ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING).
 * Main spawns this script and reads one JSON PackageResult from stdout.
 *
 * Usage:
 *   bun scripts/package-plugin-dry-run.ts '<json-options>'
 */
import { packagePluginForTarget } from "@skastr0/prism-packager";

type Options = {
  readonly pluginPath: string;
  readonly target: string;
  readonly scope?: "global" | "project";
  readonly out?: string;
  readonly projectPath?: string;
  readonly generatorVersion?: string;
  readonly force?: boolean;
};

const main = async () => {
  const raw = process.argv[2];
  if (typeof raw !== "string" || raw.length === 0) {
    console.error("usage: bun scripts/package-plugin-dry-run.ts '<json-options>'");
    process.exit(2);
  }
  let opts: Options;
  try {
    opts = JSON.parse(raw) as Options;
  } catch (cause) {
    console.error(
      cause instanceof Error ? cause.message : "invalid JSON options",
    );
    process.exit(2);
  }
  if (typeof opts.pluginPath !== "string" || typeof opts.target !== "string") {
    console.error("pluginPath and target are required");
    process.exit(2);
  }

  const result = await packagePluginForTarget({
    pluginPath: opts.pluginPath,
    target: opts.target as never,
    scope: opts.scope ?? "global",
    dryRun: true,
    force: opts.force ?? true,
    ...(opts.out !== undefined ? { out: opts.out } : {}),
    ...(opts.projectPath !== undefined ? { projectPath: opts.projectPath } : {}),
    ...(opts.generatorVersion !== undefined
      ? { generatorVersion: opts.generatorVersion }
      : {}),
  });

  // Explicit serializable surface (avoid accidental non-JSON fields).
  const payload = {
    target: result.target,
    packageId: result.packageId,
    packageRoot: result.packageRoot,
    planRoot: result.planRoot,
    activationPath: result.activationPath,
    manifestPath: result.manifestPath,
    operations: result.operations,
    compileFiles: result.compileFiles,
    compileRegions: result.compileRegions,
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
};

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
