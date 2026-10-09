import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmod, copyFile, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Effect, Schema } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { loadJsonInput } from "../src/cli/core/json";
import { executeJsonCommand } from "../src/cli/core/output";
import { featureBunDefineArgs, featureViteDefines, resolveBuildFeatures } from "./build-features";
import { buildIdentity } from "./build-identity";
import { machineBundleFiles } from "../src/main/junto/hosts/bundle";
import { bootRelocatedMachineBundle } from "./machine-bundle-boot";
import { normalizeMachineBundleModes } from "./machine-bundle-modes";
import { signMachineBundle } from "./sign-machine-bundle.mjs";

const NODE_VERSION = "26.10.0";
const NODE_DIGESTS = {
  "darwin-arm64": "751fdf7439f115d87ee2a8f3f18c065b6151852068e3e666ac60ac2996f75ac9",
  "linux-x64": "cb5c9ce9c80d7b8821e3a258543c71b939138cf17c74d5cc44bbe85d6dbc5ad8",
} as const;
const Target = Schema.Literals(["darwin-arm64", "linux-x64"]);
const BuildInput = Schema.Struct({
  output: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  target: Target,
  cache: Schema.optionalKey(Schema.String),
});
export type BuildMachineInput = typeof BuildInput.Type;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const run = (program: string, args: string[], cwd?: string, env: NodeJS.ProcessEnv = process.env): string => {
  const result = spawnSync(program, args, { cwd, env, encoding: "utf8", timeout: 300_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.error || result.status !== 0) throw new Error(`${program} failed: ${result.error?.message ?? result.stdout ?? result.status}`);
  return result.stdout;
};

export const stageOfficialMachineNode = async (target: keyof typeof NODE_DIGESTS, output: string, cache: string): Promise<void> => {
  await mkdir(cache, { recursive: true });
  const archiveName = `node-v${NODE_VERSION}-${target}.tar.gz`;
  const archive = join(cache, archiveName);
  let bytes: Buffer;
  try { bytes = await readFile(archive); }
  catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    const response = await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/${archiveName}`);
    if (!response.ok) throw new Error(`Node download failed: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(bytes).digest("hex") !== NODE_DIGESTS[target]) throw new Error("Node archive checksum mismatch");
    await writeFile(`${archive}.new`, bytes);
    await rename(`${archive}.new`, archive);
  }
  if (createHash("sha256").update(bytes).digest("hex") !== NODE_DIGESTS[target]) throw new Error("cached Node archive checksum mismatch");
  const extract = await mkdtemp(join(tmpdir(), "junto-node-"));
  try {
    const directory = `node-v${NODE_VERSION}-${target}`;
    run("tar", ["-xzf", archive, "-C", extract, `${directory}/bin/node`, `${directory}/LICENSE`]);
    await copyFile(join(extract, directory, "bin/node"), join(output, "bin/node"));
    await copyFile(join(extract, directory, "LICENSE"), join(output, "LICENSE-node.txt"));
    await chmod(join(output, "bin/node"), 0o755);
  } finally { await rm(extract, { recursive: true, force: true }); }
};

export const stageMachinePty = async (output: string, target: keyof typeof NODE_DIGESTS): Promise<void> => {
  const scratch = await mkdtemp(join(tmpdir(), "junto-pty-"));
  const source = join(repoRoot, "node_modules/node-pty");
  const built = join(scratch, "node-pty");
  const installed = join(output, "core/node_modules/node-pty");
  try {
    await cp(source, built, { recursive: true, dereference: true, filter: (file) => {
      const relative = file.slice(source.length + 1);
      return !/^(build|prebuilds|node_modules)(\/|$)/.test(relative);
    } });
    await cp(join(repoRoot, "node_modules/node-addon-api"), join(built, "node_modules/node-addon-api"), { recursive: true, dereference: true });
    run(join(output, "bin/node"), [join(repoRoot, "node_modules/node-gyp/bin/node-gyp.js"), "rebuild", `--target=${NODE_VERSION}`, `--arch=${target.split("-")[1]}`, "--dist-url=https://nodejs.org/dist"], built, {
      ...process.env, PATH: `${join(output, "bin")}:${process.env.PATH ?? ""}`, npm_config_build_from_source: "true", ELECTRON_RUN_AS_NODE: "",
    });
    const files = ["package.json", "LICENSE", "lib/eventEmitter2.js", "lib/index.js", "lib/terminal.js", "lib/unixTerminal.js", "lib/utils.js", "build/Release/pty.node"];
    if (target === "darwin-arm64") files.push("build/Release/spawn-helper");
    for (const file of files) {
      const destination = join(installed, file);
      await mkdir(dirname(destination), { recursive: true });
      await copyFile(join(built, file), destination);
      if (file.endsWith("spawn-helper")) await chmod(destination, 0o755);
    }
    run(join(output, "bin/node"), ["-e", `require(${JSON.stringify(installed)}); process.stdout.write(process.versions.modules)`]);
  } finally { await rm(scratch, { recursive: true, force: true }); }
};

export const buildMachine = async (input: BuildMachineInput) => {
  if (`${process.platform}-${process.arch}` !== input.target) throw new Error("native machine bundles must be built on their target architecture");
  const output = resolve(input.output);
  await mkdir(dirname(output), {recursive:true});
  const stage = await mkdtemp(`${output}.stage-`);
  const features = resolveBuildFeatures(process.env);
  const build = buildIdentity(repoRoot);
  const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as {version: string};
  try {
    await mkdir(join(stage, "bin"), {recursive: true});
    await mkdir(join(stage, "core"), {recursive: true});
    await stageOfficialMachineNode(input.target, stage, resolve(input.cache ?? join(homedir(), ".cache/junto/node")));
    const result = await Bun.build({
      entrypoints: [join(repoRoot, "src/main/headless.ts")], outdir: join(stage, "core"), naming: "junto.cjs", target: "node", format: "cjs",
      external: ["node-pty", "@xterm/headless", "@xterm/addon-serialize", "electron"],
      // Bun otherwise replaces __filename with each source module's build path.
      banner: "const __JUNTO_CORE_FILENAME__ = __filename;",
      define: { __filename: "__JUNTO_CORE_FILENAME__", __JUNTO_BUILD_ID__: JSON.stringify(build), __JUNTO_APP_VERSION__: JSON.stringify(pkg.version), __JUNTO_MAC_UPDATE_FEED_URL__: JSON.stringify(""), ...featureViteDefines(features) },
      plugins: [{name: "native-fs", setup(builder) {
        builder.onResolve({filter: /^original-fs$/}, () => ({path: "native", namespace: "native-fs"}));
        builder.onLoad({filter: /.*/, namespace: "native-fs"}, () => ({contents: 'module.exports = require("node:fs");', loader: "js"}));
      }}],
    });
    if (!result.success) throw new Error(result.logs.map(String).join("\n"));
    const core = await readFile(join(stage, "core/junto.cjs"), "utf8");
    if (/(?:__require|require)\s*\(\s*["']electron["']\s*\)|\bBrowserWindow\b/.test(core)) throw new Error("the windowless core imports Electron");
    for (const dependency of ["@xterm/headless", "@xterm/addon-serialize"]) {
      const source = join(repoRoot, "node_modules", dependency);
      const metadata = JSON.parse(await readFile(join(source, "package.json"), "utf8")) as {main:string};
      for (const file of ["package.json", metadata.main]) {
        const destination = join(stage, "core/node_modules", dependency, file);
        await mkdir(dirname(destination), {recursive:true});
        await copyFile(join(source, file), destination);
      }
    }
    await stageMachinePty(stage, input.target);
    run(process.execPath, ["build", "--compile", `--target=bun-${input.target}`, "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", "--no-compile-autoload-tsconfig", "--no-compile-autoload-package-json", "--external=original-fs", ...featureBunDefineArgs(features), `--define=APP_VERSION=${JSON.stringify(pkg.version)}`, `--define=__JUNTO_BUILD_ID__=${JSON.stringify(build)}`, "--outfile", join(stage, "bin/junto"), join(repoRoot, "src/cli/main.ts")], repoRoot);
    if (buildIdentity(repoRoot) !== build) throw new Error("source changed during build; rebuild this bundle");
    await normalizeMachineBundleModes(stage);
    await signMachineBundle(stage, input.target);
    await normalizeMachineBundleModes(stage);
    const manifest = {build, target:input.target, node:NODE_VERSION, appVersion:pkg.version, files:await machineBundleFiles(stage)};
    await writeFile(join(stage, "manifest.json"), JSON.stringify(manifest)+"\n");
    await chmod(join(stage, "manifest.json"), 0o644);
    await bootRelocatedMachineBundle(stage, build);
    await rename(stage, output);
    return {output, build, target:input.target, node:NODE_VERSION, appVersion:pkg.version, files:manifest.files.length};
  } finally { await rm(stage, {recursive:true, force:true}); }
};

if (import.meta.main) {
  const command = Command.make("build-machine", {input:Argument.string("input")}, ({input}) => executeJsonCommand("machine build", loadJsonInput(BuildInput,input).pipe(Effect.flatMap(value=>Effect.tryPromise({try:()=>buildMachine(value),catch:error=>error instanceof Error ? error : new Error(String(error))})))));
  BunRuntime.runMain(Command.runWith(command,{version:"1"})(process.argv.slice(2)).pipe(Effect.provide(BunServices.layer)));
}
