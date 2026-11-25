import { wordsText } from "./helpers/command-words";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { ChildProcess as Command } from "effect/process";
import { expect, it } from "vitest";
import { machineBundleFiles } from "../src/node/hosts/bundle";
import { parseSshRoute } from "../src/core/ssh";
import { receiveMachineBundle } from "../src/core/ssh/machine-commands";
import { createSshProgramCompiler } from "../src/core/ssh/program";

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

/** The bundle archived and received by the script an SSH session runs, under `environment`. */
const receive = async (root: string, bundle: string, environment: NodeJS.ProcessEnv) => {
  const archive = join(root, "package.tgz");
  execFileSync("tar", ["-czf", archive, "-C", bundle, "."]);
  const bytes = await readFile(archive);
  const target = await Effect.runPromise(parseSshRoute({ endpoint: "user@fixture" }));
  const program = await Effect.runPromise(receiveMachineBundle(target, createHash("sha256").update(bytes).digest("hex"), {}));
  const compiled = createSshProgramCompiler({ controlDir: "/tmp/junto-archive-mux", envExecutable: "/usr/bin/env", sshExecutable: "/usr/bin/ssh", environment: {} }).stream(program);
  if (!Command.isStandardCommand(compiled.command)) throw new Error("expected argv command");
  return spawnSync("/bin/sh", ["-c", wordsText(compiled.command.args).at(-1)!], { input: bytes, env: environment, encoding: "utf8" });
};

it.each([false, true])("receives exact inventoried modes with lost archive execute bits=%s under umask 077", async lostExecuteBits => {
  const root = await mkdtemp(join(tmpdir(), "junto-machine-archive-"));
  try {
    const bundle = join(root, "bundle");
    const home = join(root, "home");
    await mkdir(join(bundle, "bin"), { recursive: true });
    await mkdir(join(bundle, "core"));
    await mkdir(home);
    await writeFile(join(bundle, "bin/node"), `#!/bin/sh\nexec ${quote(process.execPath)} "$@"\n`);
    // This installer stand-in independently checks the bytes it received.
    const inspect = `
      const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
      const target = process.argv.slice(2).reverse().find((arg) => arg.startsWith("@"));
      const { bundle } = JSON.parse(fs.readFileSync(target.slice(1), "utf8"));
      assert.equal(fs.statSync(path.dirname(bundle)).mode & 0o777, 0o700);
      const manifest = JSON.parse(fs.readFileSync(path.join(bundle, "manifest.json"), "utf8"));
      for (const file of manifest.files) {
        const absolute = path.join(bundle, file.path), bytes = fs.readFileSync(absolute);
        assert.equal(fs.statSync(absolute).mode & 0o777, file.mode, file.path);
        assert.equal(bytes.length, file.bytes, file.path);
        assert.equal(crypto.createHash("sha256").update(bytes).digest("hex"), file.sha256, file.path);
      }
      process.stdout.write("accepted\\n");
    `;
    // The installer is the bundle's own junto (machine-commands.ts): here the
    // bundle's Node running the inspection, so the bytes it received are checked.
    await writeFile(join(bundle, "bin/junto"), `#!/bin/sh\nexec "$(dirname "$0")/node" "$(dirname "$0")/../core/inspect.cjs" "$@"\n`);
    await writeFile(join(bundle, "core/inspect.cjs"), inspect);
    for (const file of ["bin/node", "bin/junto"]) await chmod(join(bundle, file), 0o755);
    await chmod(join(bundle, "core/inspect.cjs"), 0o644);
    await writeFile(join(bundle, "manifest.json"), JSON.stringify({ files: await machineBundleFiles(bundle) }));
    if (lostExecuteBits) for (const file of ["bin/node"]) await chmod(join(bundle, file), 0o644);
    const result = await receive(root, bundle, { ...process.env, HOME: home });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("accepted\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

// An SSH session hands the script a home and a path, and nothing of Junto's.
// The installer is the bundle's own junto, run in process: the script names it
// and no Node entry or lease helper beside it.
it("runs the bundle's own junto as the installer, with no Node entry and no lease helper on the environment", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "junto-machine-archive-")));
  try {
    const bundle = join(root, "bundle");
    const home = join(root, "home");
    await mkdir(join(bundle, "bin"), { recursive: true });
    await mkdir(join(bundle, "core"));
    await mkdir(join(home, "install"), { recursive: true, mode: 0o700 });
    await chmod(home, 0o700);
    await writeFile(join(home, "install/owner.json"), "owned", { mode: 0o600 });
    // The bundle's own junto: records the argv it was handed and answers.
    await writeFile(join(bundle, "bin/junto"), '#!/bin/sh\nprintf \'%s\\n\' "$*" > "$HOME/installer-argv"\n', { mode: 0o755 });
    await writeFile(join(bundle, "bin/node"), `#!/bin/sh\nexec ${quote(process.execPath)} "$@"\n`, { mode: 0o755 });
    await writeFile(join(bundle, "manifest.json"), JSON.stringify({ files: await machineBundleFiles(bundle) }));
    const result = await receive(root, bundle, { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" });
    expect(result.status, result.stderr).toBe(0);
    const argv = await readFile(join(home, "installer-argv"), "utf8");
    expect(argv.startsWith("machine install-local @"), argv).toBe(true);
    expect(argv.trim().endsWith("/input.json"), argv).toBe(true);
    const target = await Effect.runPromise(parseSshRoute({ endpoint: "user@fixture" }));
    const program = await Effect.runPromise(receiveMachineBundle(target, "a".repeat(64), {}));
    const compiled = createSshProgramCompiler({ controlDir: "/tmp/junto-archive-mux", envExecutable: "/usr/bin/env", sshExecutable: "/usr/bin/ssh", environment: {} }).stream(program);
    if (!Command.isStandardCommand(compiled.command)) throw new Error("expected argv command");
    const text = wordsText(compiled.command.args).at(-1)!;
    expect(text).toContain("bin/junto\" machine install-local");
    expect(text).not.toContain("machine-local.cjs");
    expect(text).not.toContain("JUNTO_NATIVE_CLI");
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);
