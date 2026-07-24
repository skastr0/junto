/**
 * Effect-friendly wrapper around `@skastr0/prism-packager`.
 *
 * Always compiles with `dryRun: true` — Vellum owns apply (local fs or SSH).
 */

import {
  packagePluginForTarget,
  type HarnessId,
  type HarnessScope,
  type PackageResult,
} from "@skastr0/prism-packager";
import { Effect, Schema } from "effect";

export class PackageCompileError extends Schema.TaggedError<PackageCompileError>()(
  "PackageCompileError",
  {
    pluginPath: Schema.String,
    target: Schema.String,
    message: Schema.String,
  },
) {}

export type CompilePluginPackageOptions = {
  readonly pluginPath: string;
  readonly target: HarnessId;
  readonly scope?: HarnessScope;
  /** Package output root override (packager `out`). */
  readonly out?: string;
  readonly projectPath?: string;
  readonly generatorVersion?: string;
  /**
   * Packager force flag. Default true for dryRun compile: Vellum applies
   * compileFiles itself (often under planRoot inside packageRoot), so a
   * second compile must not treat those as unmanaged package-root drift.
   */
  readonly force?: boolean;
};

/**
 * Compile a plugin for one harness target without writing the package root.
 * Returns `compileFiles` / `compileRegions` / planned `operations`.
 */
export const compilePluginPackage = (
  opts: CompilePluginPackageOptions,
): Effect.Effect<PackageResult, PackageCompileError> =>
  Effect.tryPromise({
    try: () =>
      packagePluginForTarget({
        pluginPath: opts.pluginPath,
        target: opts.target,
        scope: opts.scope ?? "global",
        dryRun: true,
        force: opts.force ?? true,
        ...(opts.out !== undefined ? { out: opts.out } : {}),
        ...(opts.projectPath !== undefined ? { projectPath: opts.projectPath } : {}),
        ...(opts.generatorVersion !== undefined
          ? { generatorVersion: opts.generatorVersion }
          : {}),
      }),
    catch: (cause) =>
      new PackageCompileError({
        pluginPath: opts.pluginPath,
        target: opts.target,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });
