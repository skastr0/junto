/**
 * What runs on a machine's own files runs on its bundle's Node: the SSH
 * session that places a Boat machine's key runs core/machine-local.cjs,
 * never bin/junto (the native CLI). The entry is bundled as the machine
 * build bundles it, and run by Node.
 */
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import * as Command from "effect/unstable/process/ChildProcess";
import { afterAll, beforeAll, expect, it } from "vitest";
import { boatDir } from "../src/main/junto/boat/files";
import { parseSshRoute } from "../src/main/junto/ssh";
import { makeRemoteStdin } from "../src/main/junto/ssh/domain";
import { placeBoatMachineKey } from "../src/main/junto/ssh/machine-commands";
import { createSshProgramCompiler, type OneShotProgram } from "../src/main/junto/ssh/program";

const compiler = createSshProgramCompiler({ controlDir: "/tmp/junto-local-mux", envExecutable: "/usr/bin/env", sshExecutable: "/usr/bin/ssh", environment: {} });
const remoteText = (program: OneShotProgram) => {
  const compiled = compiler.oneShot(program);
  if (!Command.isStandardCommand(compiled.command)) throw new Error("expected argv command");
  return { text: compiled.command.args.at(-1)!, input: compiled.input };
};

let root: string;
let location: { readonly juntoHome: string; readonly installRoot: string };

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-machine-local-"));
  location = { juntoHome: join(root, "home"), installRoot: join(root, "install") };
  const current = join(location.installRoot, "current");
  await mkdir(join(current, "bin"), { recursive: true });
  // The machine build runs on Bun; so does this one bundling.
  const bundled = spawnSync("bun", ["-e", [
    'import { bundleMachineLocal } from "./scripts/build-machine";',
    'import { resolveBuildFeatures } from "./scripts/build-features";',
    `await bundleMachineLocal(${JSON.stringify(join(current, "core"))}, { build: "test", version: "0.0.0", features: resolveBuildFeatures(process.env) });`,
  ].join("\n")], { encoding: "utf8" });
  if (bundled.status !== 0) throw new Error(bundled.stderr);
  const node = spawnSync("/usr/bin/which", ["node"], { encoding: "utf8" }).stdout.trim();
  await symlink(node, join(current, "bin/node"));
}, 60_000);

afterAll(async () => rm(root, { recursive: true, force: true }));

it("places a Boat machine's key through the bundle's Node, 0600, and answers without it", async () => {
  const target = await Effect.runPromise(parseSshRoute({ endpoint: "user@fixture" }));
  const key = `boat_${"k".repeat(32)}`;
  const delivery = await Effect.runPromise(makeRemoteStdin(JSON.stringify({ sandboxId: "bx_abcd1234", keyId: "0123abcd", key })));
  const program = await Effect.runPromise(placeBoatMachineKey(target, location, delivery));
  const { text, input } = remoteText(program);
  expect(text).toContain(`${location.installRoot}/current/core/machine-local.cjs`);
  expect(text).not.toContain("bin/junto");

  const environment = { ...process.env };
  delete environment.JUNTO_WORK_TOKEN;
  const result = spawnSync("/bin/sh", ["-c", text], { input, encoding: "utf8", env: environment });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ ok: true, command: "machine boat-key-local", data: { placed: true, sandboxId: "bx_abcd1234" } });
  expect(result.stdout).not.toContain(key);
  const written = join(boatDir(location.juntoHome), "machine-key");
  expect(await readFile(written, "utf8")).toBe(`${key}\n`);
  expect((await stat(written)).mode & 0o777).toBe(0o600);
});
