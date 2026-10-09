/**
 * First exercise slice: copy a native bundle, boot in a fresh home, query its
 * sockets, and shut it down. This does not claim seat/mail acceptance.
 * Build with the native builder first; pass its complete bundle.
 * scripts/with-app-run-lock.sh bun scripts/machine-exercise.ts run @input.json
 * Input: {sshTarget, bundle}
 * Receipts and logs remain in a unique local temporary directory.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, Schema } from "effect";
import { Argument, Command } from "effect/unstable/cli";
import { inspectMachineBundle } from "../src/main/junto/hosts/bundle";
import { loadJsonInput } from "../src/cli/core/json";
import { executeJsonCommandWithVerdict } from "../src/cli/core/output";

const NonEmpty = Schema.String.pipe(Schema.check(Schema.isMinLength(1)));
const Input = Schema.Struct({
  sshTarget: NonEmpty,
  bundle: NonEmpty,
});
const TargetReceipt = Schema.Struct({
  ok: Schema.Boolean,
  error: Schema.optionalKey(Schema.String),
  root: Schema.optionalKey(Schema.String),
  home: Schema.optionalKey(Schema.String),
  entrySha256: Schema.optionalKey(Schema.String),
  platform: Schema.optionalKey(Schema.String),
  architecture: Schema.optionalKey(Schema.String),
  node: Schema.optionalKey(Schema.String),
  steps: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
const scriptDir = dirname(fileURLToPath(import.meta.url));
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

function run(program: string, args: string[], timeout = 30_000) {
  const result = spawnSync(program, args, { encoding: "utf8", timeout, maxBuffer: 4 * 1024 * 1024 });
  if (result.error) throw result.error;
  return { exit: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function exercise(input: typeof Input.Type) {
  if (process.env.JUNTO_APP_RUN_LOCK_HELD !== "1") throw new Error("run through scripts/with-app-run-lock.sh");
  // Targets are SSH aliases/addresses, never options or shell fragments.
  if (!/^[a-zA-Z0-9_][a-zA-Z0-9_.@:-]*$/.test(input.sshTarget)) throw new Error("invalid SSH target");
  const receipts = await mkdtemp(join(tmpdir(), "junto-machine-exercise-"));
  const owner = randomUUID();
  const install = join(receipts, "install");
  await inspectMachineBundle(input.bundle);
  await cp(resolve(input.bundle), install, { recursive: true, dereference: true });
  const entrySha256 = createHash("sha256").update(await readFile(join(install, "core/junto.cjs"))).digest("hex");
  const ssh = (command: string, timeout?: number) => run("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", input.sshTarget, command], timeout);
  const create = ssh(`/bin/sh -c ${quote('umask 077; mktemp -d "$HOME/.junto-exercise-XXXXXXXX"')}`);
  if (create.exit !== 0) throw new Error(`SSH target unavailable: ${create.stderr}`);
  const root = create.stdout.trim();
  if (!root.startsWith("/") || root.includes("\n") || !root.includes("/.junto-exercise-")) throw new Error("target returned an invalid exercise root");
  await writeFile(join(receipts, "exercise-owner"), owner + "\n");
  const result: { ok: boolean; sshTarget: string; root: string; receipts: string; steps: Record<string, unknown>; error?: string } = {
    ok: false, sshTarget: input.sshTarget, root, receipts, steps: {},
  };
  try {
    const copy = run("scp", ["-q", "-r", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", install,
      join(receipts, "exercise-owner"), join(scriptDir, "machine-exercise-probe.mjs"), join(scriptDir, "machine-exercise-process.mjs"), `${input.sshTarget}:${root}/`], 60_000);
    result.steps.copy = { ok: copy.exit === 0, entrySha256 };
    if (copy.exit !== 0) throw new Error(`copy failed: ${copy.stderr}`);
    const config = { root, owner };
    const probe = ssh(`${quote(join(root, "install/bin/node"))} ${quote(join(root, "machine-exercise-probe.mjs"))} ${quote(JSON.stringify(config))}`, 45_000);
    await writeFile(join(receipts, "probe.stdout"), probe.stdout);
    await writeFile(join(receipts, "probe.stderr"), probe.stderr);
    const receipt = Schema.decodeUnknownSync(Schema.fromJsonString(TargetReceipt))(probe.stdout);
    result.steps = { ...result.steps, ...receipt.steps };
    result.ok = probe.exit === 0 && receipt.ok && receipt.entrySha256 === entrySha256;
    if (receipt.entrySha256 !== entrySha256) result.error = "target entry digest differs from the copied bundle";
    if (receipt.error) result.error = receipt.error;
    await writeFile(join(receipts, "target-receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
    const logs = run("scp", ["-q", "-o", "BatchMode=yes", `${input.sshTarget}:${join(root, "runtime.log")}`, join(receipts, "runtime.log")]);
    if (logs.exit !== 0) throw new Error(`could not collect runtime log: ${logs.stderr}`);
    // The helper returned only after its owned child exited. Never delete a
    // home on transport uncertainty: preserve its exact location in the receipt.
    if ((receipt.steps?.shutdown as { ok?: boolean } | undefined)?.ok === true) {
      const cleanup = ssh(`${quote(join(root, "install/bin/node"))} ${quote(join(root, "machine-exercise-probe.mjs"))} ${quote(JSON.stringify({ root, owner, remove: true }))}`);
      result.steps.cleanup = { ok: cleanup.exit === 0 };
      if (cleanup.exit !== 0) throw new Error(`cleanup failed: ${cleanup.stderr}`);
    }
  } catch (error) {
    result.ok = false;
    result.error = error instanceof Error ? error.message : String(error);
  } finally {
    await rm(install, { recursive: true, force: true });
  }
  await writeFile(join(receipts, "receipt.json"), JSON.stringify(result, null, 2) + "\n");
  return result;
}

const command = Command.make("run", { input: Argument.string("input") }, ({ input }) =>
  executeJsonCommandWithVerdict("machine exercise", loadJsonInput(Input, input).pipe(
    Effect.flatMap(value => Effect.tryPromise({ try: () => exercise(value), catch: error => error instanceof Error ? error : new Error(String(error)) })),
  ), result => !result.ok));
const root = Command.make("machine-exercise").pipe(Command.withSubcommands([command]));
BunRuntime.runMain(Command.runWith(root, { version: "1" })(process.argv.slice(2)).pipe(Effect.provide(BunServices.layer)));
