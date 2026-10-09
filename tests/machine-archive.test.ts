import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import * as Command from "effect/unstable/process/ChildProcess";
import { expect, it } from "vitest";
import { machineBundleFiles } from "../src/main/junto/hosts/bundle";
import { parseSshRoute } from "../src/main/junto/ssh";
import { receiveMachineBundle } from "../src/main/junto/ssh/machine-commands";
import { createSshProgramCompiler } from "../src/main/junto/ssh/program";

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

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
    await writeFile(join(bundle, "bin/junto"), `#!/bin/sh\nexec ${quote(process.execPath)} -e ${quote(inspect)} "$@"\n`);
    await writeFile(join(bundle, "bin/unix-peer-pid.py"), "helper\n");
    await writeFile(join(bundle, "core/junto.cjs"), "core\n");
    for (const file of ["bin/node", "bin/junto"]) await chmod(join(bundle, file), 0o755);
    for (const file of ["bin/unix-peer-pid.py", "core/junto.cjs"]) await chmod(join(bundle, file), 0o644);
    await writeFile(join(bundle, "manifest.json"), JSON.stringify({ files: await machineBundleFiles(bundle) }));
    if (lostExecuteBits) for (const file of ["bin/node", "bin/junto"]) await chmod(join(bundle, file), 0o644);
    const archive = join(root, "package.tgz");
    execFileSync("tar", ["-czf", archive, "-C", bundle, "."]);
    const bytes = await readFile(archive);
    const target = await Effect.runPromise(parseSshRoute({ endpoint: "user@fixture" }));
    const program = await Effect.runPromise(receiveMachineBundle(target, createHash("sha256").update(bytes).digest("hex"), {}));
    const compiled = createSshProgramCompiler({ controlDir: "/tmp/junto-archive-mux", envExecutable: "/usr/bin/env", sshExecutable: "/usr/bin/ssh", environment: {} }).stream(program);
    if (!Command.isStandardCommand(compiled.command)) throw new Error("expected argv command");
    const result = spawnSync("/bin/sh", ["-c", compiled.command.args.at(-1)!], { input: bytes, env: { ...process.env, HOME: home }, encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe("accepted\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});
