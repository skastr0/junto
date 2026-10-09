import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { gunzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema, Stream } from "effect";
import { afterEach, beforeEach, expect, it } from "vitest";
import { machineBundleFiles } from "../src/main/junto/hosts/bundle";
import { sendMachine } from "../src/main/junto/hosts/send";
import { parseSshEndpoint, parseSshRoute, SshInputError, SshTransport } from "../src/main/junto/ssh";
import { InstallationId } from "../src/shared/installation-id";
import { createSshProgramCompiler } from "../src/main/junto/ssh/program";
import { SshTransferExitError } from "../src/main/junto/ssh/service";
import * as Command from "effect/unstable/process/ChildProcess";

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "junto-machine-send-")));
  await mkdir(join(root, "bin")); await mkdir(join(root, "core"));
  for (const name of ["bin/node", "bin/junto", "core/junto.cjs"]) await writeFile(join(root, name), "fixture\n");
  await chmod(join(root, "bin/node"), 0o755); await chmod(join(root, "bin/junto"), 0o755);
  await writeFile(join(root, "manifest.json"), JSON.stringify({ build: "a".repeat(64), target: "darwin-arm64", node: "26.10.0", appVersion: "1", files: await machineBundleFiles(root) }));
});

it("preserves a closed installer failure receipt from the chosen SSH account", async () => {
  const target = await Effect.runPromise(parseSshRoute({ endpoint: "user@target" }));
  const endpoint = await Effect.runPromise(parseSshEndpoint("user@target"));
  const transitions = [{ step: "selected" as const, build: "a".repeat(64) }];
  const transport = SshTransport.of({ run: () => Effect.succeed({ stdout: "ready\n", stderr: "" }), connect: () => Effect.die("unexpected"), forward: () => Effect.die("unexpected"), warm: () => Effect.void, teardown: () => Effect.void,
    transfer: (program, input) => Stream.runDrain(input).pipe(Effect.andThen(Effect.fail(new SshTransferExitError(endpoint, 1, "", JSON.stringify({ ok: false, command: "machine install-local", error: { type: "MachineInstallError", message: "service did not become ready", details: { disposition: "activated", retryable: false, transitions } } }))))),
  });
  const error = await Effect.runPromise(sendMachine(target, { bundle: root }).pipe(Effect.provideService(SshTransport, transport), Effect.flip));
  expect(error.disposition).toBe("activated");
  expect(error.transitions).toEqual(transitions);
  expect(error.retryable).toBe(false);
});

it("retains observed selection when a successful transfer has a malformed final response", async () => {
  const target = await Effect.runPromise(parseSshRoute({ endpoint: "user@target" }));
  const transition = { step: "selected" as const, build: "a".repeat(64) };
  const transport = SshTransport.of({ run: () => Effect.succeed({ stdout: "ready\n", stderr: "" }), connect: () => Effect.die("unexpected"), forward: () => Effect.die("unexpected"), warm: () => Effect.void, teardown: () => Effect.void,
    transfer: (_program, input, _timeout, onStderr) => Stream.runDrain(input).pipe(Effect.andThen(Effect.sync(() => {
      onStderr?.(new TextEncoder().encode(JSON.stringify({ event: "machine-install", juntoHome: "/home/probe", installRoot: "/home/probe/install", ...transition }) + "\n"));
      return { stdout: "not a JSON receipt", stderr: "" };
    }))),
  });
  const error = await Effect.runPromise(sendMachine(target, { bundle: root }).pipe(Effect.provideService(SshTransport, transport), Effect.flip));
  expect(error.disposition).toBe("uncertain");
  expect(error.transitions).toEqual([transition]);
  expect(error.retryable).toBe(false);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it.runIf(process.platform === "darwin")("excludes AppleDouble files from an archive made from macOS resources", async () => {
  execFileSync("/usr/bin/xattr", ["-w", "com.junto.archive-test", "metadata", join(root, "bin/junto")]);
  const chunks: Uint8Array[] = [];
  const target = await Effect.runPromise(parseSshRoute({ endpoint: "user@target" }));
  const transport = SshTransport.of({
    run: () => Effect.succeed({ stdout: "ready\n", stderr: "" }),
    transfer: (_program, input) => Stream.runForEach(input, bytes => Effect.sync(() => { chunks.push(bytes); })).pipe(Effect.andThen(Effect.succeed({ stdout: "fixture", stderr: "" }))),
    connect: () => Effect.die("unexpected"), forward: () => Effect.die("unexpected"), warm: () => Effect.void, teardown: () => Effect.void,
  });
  await Effect.runPromise(sendMachine(target, { bundle: root }).pipe(Effect.provideService(SshTransport, transport), Effect.flip));
  // Read raw tar headers. macOS tar's listing hides its own AppleDouble files.
  const archive = gunzipSync(Buffer.concat(chunks));
  const names: string[] = [];
  for (let offset = 0; offset < archive.length && archive[offset] !== 0;) {
    const header = archive.subarray(offset, offset + 512);
    names.push(header.subarray(0, 100).toString().split("\0")[0]!);
    const size = parseInt(header.subarray(124, 136).toString().replace(/\0/g, "").trim(), 8) || 0;
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  expect(names).toContain("./bin/junto");
  expect(names.filter(name => name.split("/").some(part => part.startsWith("._")))).toEqual([]);
});

it("reports all failed preflight checks before any archive bytes are transferred", async () => {
  const target = await Effect.runPromise(parseSshRoute({ endpoint: "user@target" }));
  const problems = "Cannot send Junto:\n- Free at least 100 KiB\n- Make the install folder writable\nFix these problems, then send again.\n";
  let transferred = false;
  const transport = SshTransport.of({
    run: () => Effect.succeed({ stdout: problems, stderr: "" }),
    transfer: () => { transferred = true; return Effect.die("must not transfer"); },
    connect: () => Effect.die("unexpected"), forward: () => Effect.die("unexpected"), warm: () => Effect.void, teardown: () => Effect.void,
  });
  const error = await Effect.runPromise(sendMachine(target, { bundle: root }).pipe(Effect.provideService(SshTransport, transport), Effect.flip));
  expect(error.message).toBe(problems.trim());
  expect(error.disposition).toBe("staged");
  expect(transferred).toBe(false);
});

it("sends only install selections and retains nonretryable transfer uncertainty", async () => {
  const target = await Effect.runPromise(parseSshRoute({ endpoint: "user@target", port: 19049, knownHostsFile: "/tmp/operator-pin", hostKeyAlias: "sandbox-one" }));
  let remoteText = "";
  let copiedBytes = 0;
  const observed: unknown[] = [];
  const transport = SshTransport.of({
    run: () => Effect.succeed({ stdout: "ready\n", stderr: "" }),
    connect: () => Effect.die("unexpected link"),
    forward: () => Effect.die("unexpected forwarding"),
    warm: () => Effect.void, teardown: () => Effect.void,
    transfer: (program, input, timeout, onStderr, onInputBytes) => Effect.gen(function* () {
      expect(timeout).toBe(20 * 60_000);
      const compiler = createSshProgramCompiler({ controlDir: "/tmp/junto-send-test", envExecutable: "/usr/bin/env", sshExecutable: "/usr/bin/ssh", environment: {} });
      const compiled = compiler.stream(program);
      expect(compiled.connection).toBe("dedicated");
      if (!Command.isStandardCommand(compiled.command)) throw new Error("expected argv command");
      remoteText = compiled.command.args.at(-1)!;
      yield* Stream.runForEach(input, bytes => Effect.sync(() => { copiedBytes += bytes.byteLength; onInputBytes?.(bytes.byteLength); }));
      const event = { event: "machine-install", juntoHome: "/home/user/probe", installRoot: "/home/user/probe/install", step: "verified" };
      const encoder = new TextEncoder();
      const first = JSON.stringify(event);
      onStderr?.(encoder.encode(first.slice(0, 20)));
      onStderr?.(encoder.encode(first.slice(20) + "\nordinary diagnostic\n" + JSON.stringify({ ...event, secretValue: "refuse" }) + "\n" + "x".repeat(9000) + "\n" + Array.from({ length: 8 }, () => JSON.stringify(event) + "\n").join("")));
      return yield* Effect.fail(new SshInputError({ message: "connection ended after receiving bytes" }));
    }),
  });
  const error = await Effect.runPromise(sendMachine(target, {
    bundle: root, juntoHome: "/home/user/probe", installRoot: "/home/user/probe/install",
    expectedInstallationId: Schema.decodeUnknownSync(InstallationId)("installation-one"), sshKnownHostsFile: "/tmp/operator-pin",
  }, event => { observed.push(event); throw new Error("view detached"); }).pipe(Effect.provideService(SshTransport, transport), Effect.flip));
  expect(copiedBytes).toBeGreaterThan(0);
  expect(remoteText).toContain("installation-one");
  expect(remoteText).not.toContain("operator-pin");
  expect(error.disposition).toBe("uncertain"); expect(error.retryable).toBe(false);
  const installs = observed.filter(event => JSON.stringify(event).includes('"event":"machine-install"'));
  expect(installs).toHaveLength(5);
  expect(installs.every(event => JSON.stringify(event).includes('"step":"verified"'))).toBe(true);
  expect(observed.filter(event => JSON.stringify(event).includes('"event":"machine-copy"'))).toMatchObject([
    { copiedBytes: 0, state: "copying" }, { copiedBytes, totalBytes: copiedBytes, state: "copied" },
  ]);
  expect(JSON.stringify(observed)).not.toContain("secretValue");
});
