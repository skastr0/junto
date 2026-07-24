/**
 * Effect-friendly packager compile — runs @skastr0/prism-packager under Bun.
 *
 * Electron main is Node and cannot import the packager package (raw .ts exports).
 * Always dryRun: true — Vellum owns apply (local fs or SSH).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Schema } from "effect";
import type { HarnessId, HarnessScope, PackageResult } from "./types";

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
  readonly out?: string;
  readonly projectPath?: string;
  readonly generatorVersion?: string;
  readonly force?: boolean;
};

const resolveDryRunScript = (): string | undefined => {
  const env = process.env.VELLUM_PACKAGE_PLUGIN_SCRIPT?.trim();
  if (env && existsSync(env)) return resolve(env);

  // Dev: repo scripts/ next to package root
  const candidates = [
    join(process.cwd(), "scripts", "package-plugin-dry-run.ts"),
    // Packaged / compiled main: walk up from this module
  ];
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    candidates.push(
      resolve(here, "../../../../../scripts/package-plugin-dry-run.ts"),
      resolve(here, "../../../../scripts/package-plugin-dry-run.ts"),
    );
  } catch {
    // ignore
  }
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return undefined;
};

const resolveBun = (): string => {
  const env = process.env.BUN_PATH?.trim() || process.env.BUN?.trim();
  if (env) return env;
  return "bun";
};

const runBunPackager = (
  opts: CompilePluginPackageOptions,
): Promise<PackageResult> =>
  new Promise((resolvePromise, reject) => {
    const script = resolveDryRunScript();
    if (script === undefined) {
      reject(
        new Error(
          "package-plugin-dry-run.ts not found (set VELLUM_PACKAGE_PLUGIN_SCRIPT)",
        ),
      );
      return;
    }
    const payload = JSON.stringify({
      pluginPath: opts.pluginPath,
      target: opts.target,
      scope: opts.scope ?? "global",
      force: opts.force ?? true,
      ...(opts.out !== undefined ? { out: opts.out } : {}),
      ...(opts.projectPath !== undefined
        ? { projectPath: opts.projectPath }
        : {}),
      ...(opts.generatorVersion !== undefined
        ? { generatorVersion: opts.generatorVersion }
        : {}),
    });
    const child = spawn(resolveBun(), [script, payload], {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (cause) => {
      reject(
        cause instanceof Error
          ? cause
          : new Error(`failed to spawn bun: ${String(cause)}`),
      );
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(
          new Error(
            stderr.trim() ||
              stdout.trim() ||
              `package-plugin-dry-run exited ${code ?? "null"}`,
          ),
        );
        return;
      }
      const line = stdout.trim().split("\n").filter(Boolean).at(-1);
      if (!line) {
        reject(new Error("package-plugin-dry-run produced empty stdout"));
        return;
      }
      try {
        const parsed = JSON.parse(line) as PackageResult;
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          !Array.isArray(parsed.compileFiles)
        ) {
          reject(new Error("package-plugin-dry-run returned invalid payload"));
          return;
        }
        resolvePromise(parsed);
      } catch (cause) {
        reject(
          cause instanceof Error
            ? cause
            : new Error("package-plugin-dry-run stdout is not JSON"),
        );
      }
    });
  });

/**
 * Compile a plugin for one harness target without writing the package root.
 * Spawns Bun — never loads prism-packager in the Electron Node process.
 */
export const compilePluginPackage = (
  opts: CompilePluginPackageOptions,
): Effect.Effect<PackageResult, PackageCompileError> =>
  Effect.tryPromise({
    try: () => runBunPackager(opts),
    catch: (cause) =>
      new PackageCompileError({
        pluginPath: opts.pluginPath,
        target: opts.target,
        message: cause instanceof Error ? cause.message : String(cause),
      }),
  });
