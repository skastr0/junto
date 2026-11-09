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
      const { bundle } = JSON.parse(fs.readFileSync(process.argv[3].slice(1), "utf8"));
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
    // The installer runs the bundle's Node on core/machine-local.cjs (machine-commands.ts).
    await writeFile(join(bundle, "core/machine-local.cjs"), inspect);
    for (const file of ["bin/node"]) await chmod(join(bundle, file), 0o755);
    for (const file of ["core/machine-local.cjs"]) await chmod(join(bundle, file), 0o644);
    await writeFile(join(bundle, "manifest.json"), JSON.stringify({ files: await machineBundleFiles(bundle) }));
    if (lostExecuteBits) for (const file of ["bin/node"]) await chmod(join(bundle, file), 0o644);
    const result = await receive(root, bundle, { ...process.env, HOME: home });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("accepted\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

// An SSH session hands the script a home and a path, and nothing of Junto's.
// The installer's lease is taken by a helper it is told of (install-lock.ts),
// so the script must name it: without that no send or update can install.
it("names the bundle's own junto as the installer's lease helper in the bare environment of an SSH session", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "junto-machine-archive-")));
  try {
    const bundle = join(root, "bundle");
    const home = join(root, "home");
    await mkdir(join(bundle, "bin"), { recursive: true });
    await mkdir(join(bundle, "core"));
    await mkdir(join(home, "install"), { recursive: true, mode: 0o700 });
    await chmod(home, 0o700);
    await writeFile(join(home, "install/owner.json"), "owned", { mode: 0o600 });
    await writeFile(join(bundle, "bin/node"), `#!/bin/sh\nexec ${quote(process.execPath)} "$@"\n`, { mode: 0o755 });
    // Stands in for the native junto: grants the lease and records which file was run.
    await writeFile(join(bundle, "bin/junto"), '#!/bin/sh\n[ "$1 $2" = "machine install-lease" ] || exit 2\nprintf \'%s\\n\' "$0" > "$HOME/lease-helper"\n', { mode: 0o755 });
    // The lease module as the bundle's Node loads it: bundled, no Bun.
    execFileSync("bun", ["build", "src/cli/hosts/install-lock.ts", "--target", "node", "--format", "esm", "--outfile", join(bundle, "core/install-lock.mjs")], { cwd: process.cwd(), stdio: "pipe" });
    // This installer stand-in takes the install lease the way the installer does.
    await writeFile(join(bundle, "core/machine-local.cjs"), `
      const path = require("node:path"), os = require("node:os"), { pathToFileURL } = require("node:url");
      (async () => {
        const lease = await import(pathToFileURL(path.join(__dirname, "install-lock.mjs")).href);
        const release = await lease.acquireInstallLock(await lease.admitInstallLockRoot(path.join(os.homedir(), "install"), "owned"));
        process.stdout.write("leased\\n");
        await release();
      })().catch(error => { process.stderr.write(String(error && error.message) + "\\n"); process.exitCode = 1; });
    `, { mode: 0o644 });
    await writeFile(join(bundle, "manifest.json"), JSON.stringify({ files: await machineBundleFiles(bundle) }));
    const result = await receive(root, bundle, { HOME: home, PATH: process.env.PATH ?? "/usr/bin:/bin" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("leased\n");
    const helper = await readFile(join(home, "lease-helper"), "utf8");
    expect(helper.startsWith(`${home}/.junto-send.`), helper).toBe(true);
    expect(helper.endsWith("/package/bin/junto\n"), helper).toBe(true);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 30_000);
