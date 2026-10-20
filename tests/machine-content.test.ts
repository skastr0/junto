/**
 * A file lands on another machine through that machine's own Junto: a closed
 * content-transfer argv, the bytes on stdin in pieces that resume where the
 * machine's partial ends.
 */
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import * as Command from "effect/unstable/process/ChildProcess";
import { afterEach, expect, it } from "vitest";
import { contentObjectPath, contentStoreRoot } from "../src/main/junto/content/paths";
import { parseSshRoute } from "../src/main/junto/ssh";
import { receiveMachineContent, statMachineContent } from "../src/main/junto/ssh/machine-commands";
import { createSshProgramCompiler, type OneShotProgram } from "../src/main/junto/ssh/program";

const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
const compiler = createSshProgramCompiler({ controlDir: "/tmp/junto-content-mux", envExecutable: "/usr/bin/env", sshExecutable: "/usr/bin/ssh", environment: {} });
const remoteText = (program: OneShotProgram) => {
  const compiled = compiler.oneShot(program);
  if (!Command.isStandardCommand(compiled.command)) throw new Error("expected argv command");
  return { text: compiled.command.args.at(-1)!, input: compiled.input, timeoutMs: compiled.timeoutMs };
};

const roots: string[] = [];
afterEach(async () => { while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true }); });

const machine = async () => {
  const root = await mkdtemp(join(tmpdir(), "junto-machine-content-"));
  roots.push(root);
  const location = { juntoHome: join(root, "home/.junto"), installRoot: join(root, "install") };
  await mkdir(join(location.installRoot, "current/bin"), { recursive: true });
  const bun = execFileSync("/usr/bin/which", ["bun"], { encoding: "utf8" }).trim();
  const junto = join(location.installRoot, "current/bin/junto");
  await writeFile(junto, `#!/bin/sh\nexec ${quote(bun)} ${quote(resolve("src/cli/main.ts"))} "$@"\n`);
  await chmod(junto, 0o755);
  const run = (program: OneShotProgram) => {
    const { text, input } = remoteText(program);
    const result = spawnSync("/bin/sh", ["-c", text], { input, encoding: "utf8" });
    return { status: result.status, answer: JSON.parse(result.stdout) as Record<string, unknown> };
  };
  return { location, run };
};

it("lands an object in pieces, resumes from the partial, and takes it again as a success", async () => {
  const target = await Effect.runPromise(parseSshRoute({ endpoint: "user@fixture" }));
  const { location, run } = await machine();
  const bytes = Buffer.from("the operator's file, carried in two pieces\n");
  const ref = { sha256: createHash("sha256").update(bytes).digest("hex"), byteLength: bytes.length };
  const piece = (offset: number, end: number) => Effect.runPromise(receiveMachineContent(target, location, ref, { offset, bytes: bytes.subarray(offset, end) }));

  const first = await piece(0, 10);
  expect(remoteText(first).text).toBe(
    ["/usr/bin/env", `JUNTO_HOME=${location.juntoHome}`, `${location.installRoot}/current/bin/junto`, "content-transfer", "receive", ref.sha256, String(ref.byteLength), "0"].map(quote).join(" "),
  );
  expect(remoteText(first).timeoutMs).toBe(20_000);
  expect(run(first)).toEqual({ status: 0, answer: expect.objectContaining({ ok: true, state: "partial", receivedBytes: 10 }) });

  // Starting over is refused; the machine says where its partial ends.
  expect(run(await piece(0, bytes.length)).answer).toMatchObject({ ok: false, error: expect.stringContaining("expected 10") });
  expect(run(await Effect.runPromise(statMachineContent(target, location, ref)))).toEqual({ status: 0, answer: expect.objectContaining({ state: "partial", receivedBytes: 10 }) });

  expect(run(await piece(10, bytes.length))).toEqual({ status: 0, answer: expect.objectContaining({ ok: true, state: "verified", created: true }) });
  expect(await readFile(contentObjectPath(contentStoreRoot(location.juntoHome), ref.sha256))).toEqual(bytes);
  expect(run(await piece(0, bytes.length))).toEqual({ status: 0, answer: expect.objectContaining({ ok: true, state: "verified", created: false }) });
}, 30_000);

it("refuses a ref, a piece or a location that is not exact before it reaches argv", async () => {
  const target = await Effect.runPromise(parseSshRoute({ endpoint: "user@fixture" }));
  const location = { juntoHome: "/home/op/.junto", installRoot: "/home/op/.junto-install" };
  const ref = { sha256: "a".repeat(64), byteLength: 4 };
  const refused = async (effect: Effect.Effect<unknown, unknown>) => (await Effect.runPromise(Effect.flip(effect)) as { readonly check?: string }).check;
  const bytes = new Uint8Array(4);
  for (const bad of [{ ...ref, sha256: "A".repeat(64) }, { ...ref, sha256: `${"a".repeat(63)} ` }, { ...ref, byteLength: -1 }, { ...ref, byteLength: 1.5 }, { ...ref, byteLength: Number.MAX_SAFE_INTEGER + 1 }]) {
    expect(await refused(receiveMachineContent(target, location, bad, { offset: 0, bytes: new Uint8Array(0) }))).toBe("content-ref");
    expect(await refused(statMachineContent(target, location, bad))).toBe("content-ref");
  }
  for (const piece of [{ offset: 1, bytes }, { offset: -1, bytes: new Uint8Array(1) }, { offset: 0.5, bytes: new Uint8Array(1) }]) {
    expect(await refused(receiveMachineContent(target, location, ref, piece))).toBe("content-ref");
  }
  for (const bad of [{ ...location, juntoHome: ".junto" }, { ...location, installRoot: "/home/op/\nx" }]) {
    expect(await refused(receiveMachineContent(target, bad, ref, { offset: 0, bytes }))).toBe("install-paths");
    expect(await refused(statMachineContent(target, bad, ref))).toBe("install-paths");
  }
  // A piece past the stdin boundary is the SSH layer's refusal, not a truncation.
  const big = { sha256: "a".repeat(64), byteLength: 17 * 1024 * 1024 };
  expect(await Effect.runPromise(Effect.flip(receiveMachineContent(target, location, big, { offset: 0, bytes: new Uint8Array(big.byteLength) })))).toMatchObject({ _tag: "SshInputError" });
});
