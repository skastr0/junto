/**
 * Compile a Bun control binary with the resolved feature profile: the dev
 * CLI and the Linux desktop bootstrap. The shipped `junto` is the native CLI
 * (scripts/build-native-cli.ts, `bun run cli:build`), never this.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  featureBunDefineArgs,
  resolveBuildFeatures,
} from "./build-features";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appVersion: string = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;

const controls = {
  "junto-dev": {
    source: "src/cli/main.ts",
    output: "dist/junto-dev",
  },
  "junto-desktop-bootstrap-linux-x64": {
    source: "scripts/linux-desktop-bootstrap.ts",
    output: "dist/junto-desktop-bootstrap-linux-x64",
  },
} as const;

export type StandaloneControl = keyof typeof controls;

export const standaloneControlBuild = (
  control: StandaloneControl = "junto-dev",
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
      "usage: bun scripts/build-standalone-cli.ts junto-dev|junto-desktop-bootstrap-linux-x64",
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
      // @electron/asar selects node:fs outside Electron; this branch is unused in Bun.
      "--external=original-fs",
      ...build.featureDefines,
      `--define=APP_VERSION=${JSON.stringify(appVersion)}`,
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
