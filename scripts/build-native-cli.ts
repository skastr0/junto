/**
 * Build the native junto CLI (native/cli) for one target, stamped with this
 * package's version and the resolved feature profile, and prove the stamp
 * before it is staged.
 *
 * The binary reads JUNTO_APP_VERSION at compile time and falls back to 0.1.0
 * without it, so a build that forgot the stamp would ship claiming 0.1.0.
 * This script sets it from package.json and refuses any binary whose
 * --version does not answer that version. Every feature reaches cargo as the
 * build-time variable its define names (`__JUNTO_TASKS_ENABLED__` is
 * `JUNTO_TASKS_ENABLED`), over native/cli/.cargo/config.toml's defaults.
 *
 *   bun scripts/build-native-cli.ts [--target <triple>] [--machine] [--out <path>]
 */
import { chmodSync, copyFileSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { FEATURE_CATALOG, type FeatureKey } from "../src/shared/feature-catalog";
import { resolveBuildFeatures, type ResolvedBuildFeatures } from "./build-features";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const crate = resolve(root, "native/cli");

export const NATIVE_CLI_TARGETS = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
] as const;
export type NativeCliTarget = (typeof NATIVE_CLI_TARGETS)[number];

/** The target for a machine bundle's `<platform>-<arch>`. */
export const NATIVE_CLI_TARGET_OF: Readonly<Record<string, NativeCliTarget>> = {
  "darwin-arm64": "aarch64-apple-darwin",
  "darwin-x64": "x86_64-apple-darwin",
  "linux-x64": "x86_64-unknown-linux-gnu",
  "linux-arm64": "aarch64-unknown-linux-gnu",
};

/** The rustc host triple, which is the target when none is named. */
const hostTarget = (): string => {
  const result = spawnSync("rustc", ["-vV"], { cwd: crate, encoding: "utf8" });
  const host = /^host: (.+)$/m.exec(result.stdout ?? "")?.[1];
  if (result.status !== 0 || host === undefined) throw new Error("native CLI: rustc -vV did not name a host");
  return host;
};

/** What --version must print: the TypeScript CLI's own form (src/cli/main.ts). */
export const nativeCliVersionLine = (version: string): string => `junto v${version}`;

/** The feature profile as cargo's build environment. */
export const nativeFeatureEnv = (resolved: ResolvedBuildFeatures): Record<string, string> =>
  Object.fromEntries(
    (Object.keys(FEATURE_CATALOG) as FeatureKey[]).map((key) => {
      const tier = resolved.features[key];
      return [FEATURE_CATALOG[key].define.replace(/^__|__$/g, ""), tier === true ? "1" : tier === false ? "0" : tier];
    }),
  );

export interface NativeCliInput {
  readonly target: NativeCliTarget;
  readonly version: string;
  readonly features: ResolvedBuildFeatures;
  /** The machine bundle's CLI: no browser (`__JUNTO_MACHINE_BUILD__`). */
  readonly machine?: boolean;
}

/** Builds the crate for one target, proves its stamp, and stages it at `outfile`. */
export const compileNativeCli = (outfile: string, input: NativeCliInput): void => {
  const { target, version } = input;
  const build = spawnSync("cargo", ["build", "--locked", "--release", "--target", target], {
    cwd: crate,
    stdio: "inherit",
    env: {
      ...process.env,
      ...nativeFeatureEnv(input.features),
      JUNTO_APP_VERSION: version,
      JUNTO_MACHINE_BUILD: input.machine === true ? "1" : "0",
    },
  });
  if (build.status !== 0) throw new Error(`native CLI build for ${target} failed (exit ${String(build.status)})`);

  const built = resolve(process.env.CARGO_TARGET_DIR ?? resolve(crate, "target"), target, "release", "junto");
  // Run what can run here: the host, or x86_64 macOS under Rosetta on an
  // Apple silicon host. Any other target is proven by its bytes: the stamp
  // is in the binary as plain text.
  const host = hostTarget();
  const runner =
    target === host ? [built] : target === "x86_64-apple-darwin" && host === "aarch64-apple-darwin" ? ["arch", "-x86_64", built] : undefined;
  if (runner !== undefined) {
    const answer = spawnSync(runner[0]!, [...runner.slice(1), "--version"], { encoding: "utf8" });
    const line = (answer.stdout ?? "").trim();
    if (answer.status !== 0 || line !== nativeCliVersionLine(version)) {
      throw new Error(`native CLI: --version answered "${line}", expected "${nativeCliVersionLine(version)}"`);
    }
  } else if (!readFileSync(built).includes(Buffer.from(version))) {
    throw new Error(`native CLI: the ${target} binary does not carry the version ${version}`);
  }

  const stage = `${outfile}.new.${process.pid}`;
  mkdirSync(dirname(outfile), { recursive: true });
  copyFileSync(built, stage);
  chmodSync(stage, 0o755);
  renameSync(stage, outfile);
};

const USAGE = `usage: bun scripts/build-native-cli.ts [--target ${NATIVE_CLI_TARGETS.join("|")}] [--machine] [--out <path>]`;

const main = (): void => {
  let target: string | undefined;
  let out: string | undefined;
  let machine = false;
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--target" && args[i + 1] !== undefined) target = args[++i];
    else if (arg === "--out" && args[i + 1] !== undefined) out = args[++i];
    else if (arg === "--machine") machine = true;
    else throw new Error(USAGE);
  }
  if (target !== undefined && !(NATIVE_CLI_TARGETS as ReadonlyArray<string>).includes(target)) {
    throw new Error(`native CLI: unknown target ${target}`);
  }
  const resolvedTarget = (target ?? hostTarget()) as NativeCliTarget;
  const version: string = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
  const features = resolveBuildFeatures(process.env);
  const output = resolve(root, out ?? `dist/native/${resolvedTarget}/junto`);
  compileNativeCli(output, { target: resolvedTarget, version, features, machine });
  process.stdout.write(`native CLI ${version} (${features.profile}, ${resolvedTarget}) → ${output}\n`);
};

if (import.meta.main) main();
