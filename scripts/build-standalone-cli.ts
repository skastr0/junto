/**
 * Compile one packaged control CLI with the resolved feature profile.
 *
 * This is deliberately the only public `bun build --compile` path for the
 * packaged control binaries. A bare `bun run cli:build` must mean the same
 * ship profile as `build-app.sh`, not an ambient source-run profile.
 */
import { chmodSync, mkdirSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  featureBunDefineArgs,
  resolveBuildFeatures,
} from "./build-features";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const controls = {
  "vellum-command": {
    source: "src/cli/main.ts",
    output: "dist/vellum-command",
  },
  "vellum-command-dev": {
    source: "src/cli/main.ts",
    output: "dist/vellum-command-dev",
  },
} as const;

export type StandaloneControl = keyof typeof controls;

export const standaloneControlBuild = (
  control: StandaloneControl = "vellum-command",
) => {
  const selected = controls[control];
  const resolvedFeatures = resolveBuildFeatures(process.env);
  return {
    ...selected,
    featureDefines: featureBunDefineArgs(resolvedFeatures),
    profile: resolvedFeatures.profile,
    fingerprint: resolvedFeatures.fingerprint,
  };
};

const main = (): void => {
  const [rawControl, ...extraArgs] = process.argv.slice(2);
  if (!rawControl || extraArgs.length > 0 || !(rawControl in controls)) {
    throw new Error(
      "usage: bun scripts/build-standalone-cli.ts vellum-command|vellum-command-dev",
    );
  }

  const control = rawControl as StandaloneControl;
  const build = standaloneControlBuild(control);
  const output = resolve(root, build.output);
  const stage = `${output}.new.${process.pid}`;
  mkdirSync(dirname(output), { recursive: true });

  const result = spawnSync(
    process.execPath,
    [
      "build",
      "--compile",
      "--no-compile-autoload-dotenv",
      "--no-compile-autoload-bunfig",
      "--no-compile-autoload-tsconfig",
      "--no-compile-autoload-package-json",
      ...build.featureDefines,
      "--outfile",
      stage,
      resolve(root, build.source),
    ],
    { cwd: root, stdio: "inherit" },
  );
  if (result.status !== 0) {
    throw new Error(`standalone ${control} build failed (exit ${String(result.status)})`);
  }

  chmodSync(stage, 0o755);
  renameSync(stage, output);
  process.stdout.write(
    `standalone ${control} build (${build.profile}, ${build.fingerprint}) → ${output}\n`,
  );
};

if (import.meta.main) main();
