/**
 * What runs on a machine's own files runs on that machine's own junto: the SSH
 * session that places a Boat machine's key runs `<install>/current/bin/junto
 * machine boat-key-local`, never a Node entry beside the core, and the delivery
 * rides stdin only.
 */
import { wordsText } from "./helpers/command-words";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { ChildProcess as Command } from "effect/process";
import { afterAll, beforeAll, expect, it } from "vitest";
import { parseSshRoute } from "../src/core/ssh";
import { makeRemoteStdin } from "../src/core/ssh/domain";
import { placeBoatMachineKey } from "../src/core/ssh/machine-commands";
import { createSshProgramCompiler, type OneShotProgram } from "../src/core/ssh/program";

const compiler = createSshProgramCompiler({ controlDir: "/tmp/junto-local-mux", envExecutable: "/usr/bin/env", sshExecutable: "/usr/bin/ssh", environment: {} });
const remoteText = (program: OneShotProgram) => {
  const compiled = compiler.oneShot(program);
  if (!Command.isStandardCommand(compiled.command)) throw new Error("expected argv command");
  return { text: wordsText(compiled.command.args).at(-1)!, input: compiled.input };
};

let root: string;
let location: { readonly juntoHome: string; readonly installRoot: string };

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "junto-machine-local-"));
  location = { juntoHome: join(root, "home"), installRoot: join(root, "install") };
  const current = join(location.installRoot, "current");
  await mkdir(join(current, "bin"), { recursive: true });
  await mkdir(join(current, "core"), { recursive: true });
  // The bundle's own junto as the machine build compiles it: here a stand-in
  // that answers the one command, so the program text is what is proven.
  await writeFile(
    join(current, "bin/junto"),
    '#!/bin/sh\n[ "$1 $2" = "machine boat-key-local" ] || exit 2\ncat >/dev/null\nprintf \'%s\\n\' \'{"ok":true,"command":"machine boat-key-local","data":{"placed":true,"sandboxId":"bx_abcd1234"}}\'\n',
    { mode: 0o755 },
  );
}, 30_000);

afterAll(async () => rm(root, { recursive: true, force: true }));

it("places a Boat machine's key through the installed junto, never a Node entry, and answers without it", async () => {
  const target = await Effect.runPromise(parseSshRoute({ endpoint: "user@fixture" }));
  const key = `boat_${"k".repeat(32)}`;
  const delivery = JSON.stringify({ sandboxId: "bx_abcd1234", keyId: "0123abcd", key });
  const program = await Effect.runPromise(placeBoatMachineKey(target, location, await Effect.runPromise(makeRemoteStdin(delivery))));
  const { text, input } = remoteText(program);
  expect(text).toContain(`${location.installRoot}/current/bin/junto`);
  // The command is the CLI's own words, however the compiler quotes them.
  expect(text.replaceAll("'", "")).toContain("machine boat-key-local");
  expect(text).not.toContain("machine-local.cjs");
  expect(text).not.toContain("bin/node");
  // The delivery is on stdin, never in the command an SSH server could log.
  expect(text).not.toContain(delivery);

  const environment = { ...process.env };
  delete environment.JUNTO_WORK_TOKEN;
  const result = spawnSync("/bin/sh", ["-c", text], { input, encoding: "utf8", env: environment });
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ ok: true, command: "machine boat-key-local", data: { placed: true, sandboxId: "bx_abcd1234" } });
  expect(result.stdout).not.toContain(key);
});
