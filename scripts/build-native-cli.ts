/**
 * Build the native junto CLI (0.12 native CLI, N1) for one target, stamped
 * with this package's version, and prove the stamp before it is staged.
 *
 * The binary reads JUNTO_APP_VERSION at compile time and falls back to 0.1.0
 * without it, so a build that forgot the stamp would ship claiming 0.1.0.
 * This script sets it from package.json and refuses any binary whose
 * --version does not answer that version.
 */
import { chmodSync, copyFileSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const crate = resolve(root, "native/cli");
const appVersion: string = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;

export const NATIVE_CLI_TARGETS = [
  "aarch64-apple-darwin",
  "x86_64-apple-darwin",
  "x86_64-unknown-linux-gnu",
  "aarch64-unknown-linux-gnu",
] as const;
export type NativeCliTarget = (typeof NATIVE_CLI_TARGETS)[number];

/** The rustc host triple, which is the target when none is named. */
const hostTarget = (): string => {
  const result = spawnSync("rustc", ["-vV"], { cwd: crate, encoding: "utf8" });
  const host = /^host: (.+)$/m.exec(result.stdout ?? "")?.[1];
  if (result.status !== 0 || host === undefined) throw new Error("native CLI: rustc -vV did not name a host");
  return host;
};

/** What --version must print: the TypeScript CLI's own form (src/cli/main.ts). */
export const nativeCliVersionLine = (version: string): string => `junto v${version}`;

const main = (): void => {
  const args = process.argv.slice(2);
  const named = args[0] === "--target" ? args[1] : undefined;
  if ((args.length !== 0 && named === undefined) || args.length > 2) {
    throw new Error(`usage: bun scripts/build-native-cli.ts [--target ${NATIVE_CLI_TARGETS.join("|")}]`);
  }
  if (named !== undefined && !(NATIVE_CLI_TARGETS as ReadonlyArray<string>).includes(named)) {
    throw new Error(`native CLI: unknown target ${named}`);
  }
  const host = hostTarget();
  const target = named ?? host;

  const build = spawnSync("cargo", ["build", "--locked", "--release", "--target", target], {
    cwd: crate,
    stdio: "inherit",
    env: { ...process.env, JUNTO_APP_VERSION: appVersion },
  });
  if (build.status !== 0) throw new Error(`native CLI build for ${target} failed (exit ${String(build.status)})`);

  const built = resolve(crate, "target", target, "release", "junto");
  // Run what can run here: the host, or x86_64 macOS under Rosetta on an
  // Apple silicon host. Any other target is proven by its bytes: the stamp
  // is in the binary as plain text.
  const runner =
    target === host ? [built] : target === "x86_64-apple-darwin" && host === "aarch64-apple-darwin" ? ["arch", "-x86_64", built] : undefined;
  if (runner !== undefined) {
    const answer = spawnSync(runner[0]!, [...runner.slice(1), "--version"], { encoding: "utf8" });
    const line = (answer.stdout ?? "").trim();
    if (answer.status !== 0 || line !== nativeCliVersionLine(appVersion)) {
      throw new Error(`native CLI: --version answered "${line}", expected "${nativeCliVersionLine(appVersion)}"`);
    }
  } else if (!readFileSync(built).includes(Buffer.from(appVersion))) {
    throw new Error(`native CLI: the ${target} binary does not carry the version ${appVersion}`);
  }

  const output = resolve(root, "dist", "native", target, "junto");
  const stage = `${output}.new.${process.pid}`;
  mkdirSync(dirname(output), { recursive: true });
  copyFileSync(built, stage);
  chmodSync(stage, 0o755);
  renameSync(stage, output);
  process.stdout.write(`native CLI ${appVersion} (${target}) → ${output}\n`);
};

if (import.meta.main) main();
