/**
 * Compile the native `junto` CLI (native/cli) for one target, with the
 * resolved feature profile and the app version stamped in, as the Bun build
 * stamps its defines. Every feature reaches cargo as the build-time variable
 * its define names (`__JUNTO_TASKS_ENABLED__` is `JUNTO_TASKS_ENABLED`), so
 * the profile here wins over native/cli/.cargo/config.toml's defaults.
 *
 *   bun scripts/build-native-cli.ts [--target <triple>] [--machine] [--out <path>]
 */
import { copyFileSync, chmodSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FEATURE_CATALOG, type FeatureKey } from "../src/shared/feature-catalog";
import { resolveBuildFeatures, type ResolvedBuildFeatures } from "./build-features";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const crate = resolve(root, "native/cli");

/** The Rust target for a machine bundle's `<platform>-<arch>`. */
export const NATIVE_TARGETS = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
} as const;

export type NativeTarget = (typeof NATIVE_TARGETS)[keyof typeof NATIVE_TARGETS];

export interface NativeCliInput {
  readonly target: NativeTarget;
  readonly version: string;
  readonly features: ResolvedBuildFeatures;
  /** The machine bundle's CLI: no browser (`__JUNTO_MACHINE_BUILD__`). */
  readonly machine?: boolean;
}

/** The feature profile as cargo's build environment. */
export const nativeFeatureEnv = (resolved: ResolvedBuildFeatures): Record<string, string> =>
  Object.fromEntries(
    (Object.keys(FEATURE_CATALOG) as FeatureKey[]).map((key) => {
      const tier = resolved.features[key];
      return [FEATURE_CATALOG[key].define.replace(/^__|__$/g, ""), tier === true ? "1" : tier === false ? "0" : tier];
    }),
  );

/** Builds the crate and copies the binary to `outfile`, atomically. */
export const compileNativeCli = (outfile: string, input: NativeCliInput): void => {
  const built = spawnSync("cargo", ["build", "--locked", "--release", "--target", input.target], {
    cwd: crate,
    stdio: "inherit",
    env: {
      ...process.env,
      ...nativeFeatureEnv(input.features),
      JUNTO_APP_VERSION: input.version,
      JUNTO_MACHINE_BUILD: input.machine === true ? "1" : "0",
    },
  });
  if (built.status !== 0) throw new Error(`native CLI build for ${input.target} failed (exit ${String(built.status)})`);
  const stage = `${outfile}.new.${process.pid}`;
  mkdirSync(dirname(outfile), { recursive: true });
  copyFileSync(resolve(crate, "target", input.target, "release/junto"), stage);
  chmodSync(stage, 0o755);
  renameSync(stage, outfile);
};

/** This machine's own target. */
export const hostTarget = (): NativeTarget => {
  const key = `${process.platform}-${process.arch}`;
  const target = NATIVE_TARGETS[key as keyof typeof NATIVE_TARGETS];
  if (target === undefined) throw new Error(`no native CLI target for ${key}`);
  return target;
};

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const flag = (name: string) => {
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const target = (flag("--target") as NativeTarget | undefined) ?? hostTarget();
  const outfile = resolve(root, flag("--out") ?? "dist/junto");
  const version: string = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
  const features = resolveBuildFeatures(process.env);
  compileNativeCli(outfile, { target, version, features, machine: argv.includes("--machine") });
  process.stdout.write(`native junto ${version} (${features.profile}, ${target}) → ${outfile}\n`);
}
