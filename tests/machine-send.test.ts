import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema, Stream } from "effect";
import { afterEach, beforeEach, expect, it } from "vitest";
import { machineBundleFiles } from "../src/main/junto/hosts/bundle";
import { sendMachine } from "../src/main/junto/hosts/send";
import { parseSshRoute, SshInputError, SshTransport } from "../src/main/junto/ssh";
import { InstallationId } from "../src/shared/installation-id";
import { createSshProgramCompiler } from "../src/main/junto/ssh/program";
import * as Command from "effect/unstable/process/ChildProcess";

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "junto-machine-send-")));
  await mkdir(join(root, "bin")); await mkdir(join(root, "core"));
  for (const name of ["bin/node", "bin/junto", "core/junto.cjs"]) await writeFile(join(root, name), "fixture\n");
  await chmod(join(root, "bin/node"), 0o755); await chmod(join(root, "bin/junto"), 0o755);
  await writeFile(join(root, "manifest.json"), JSON.stringify({ build: "a".repeat(64), target: "darwin-arm64", node: "26.10.0", appVersion: "1", files: await machineBundleFiles(root) }));
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it("sends only install selections and retains nonretryable transfer uncertainty", async () => {
  const target = await Effect.runPromise(parseSshRoute({ endpoint: "user@target", port: 19049, knownHostsFile: "/tmp/operator-pin", hostKeyAlias: "sandbox-one" }));
  let remoteText = "";
  let copiedBytes = 0;
  const transport = SshTransport.of({
    run: () => Effect.die("unexpected one-shot"),
    connect: () => Effect.die("unexpected link"),
    forward: () => Effect.die("unexpected forwarding"),
    warm: () => Effect.void, teardown: () => Effect.void,
    transfer: (program, input, timeout) => Effect.gen(function* () {
      expect(timeout).toBe(20 * 60_000);
      const compiler = createSshProgramCompiler({ controlDir: "/tmp/junto-send-test", envExecutable: "/usr/bin/env", sshExecutable: "/usr/bin/ssh", environment: {} });
      const compiled = compiler.stream(program);
      expect(compiled.connection).toBe("dedicated");
      if (!Command.isStandardCommand(compiled.command)) throw new Error("expected argv command");
      remoteText = compiled.command.args.at(-1)!;
      yield* Stream.runForEach(input, bytes => Effect.sync(() => { copiedBytes += bytes.byteLength; }));
      return yield* Effect.fail(new SshInputError({ message: "connection ended after receiving bytes" }));
    }),
  });
  const error = await Effect.runPromise(sendMachine(target, {
    bundle: root, juntoHome: "/home/user/probe", installRoot: "/home/user/probe/install",
    expectedInstallationId: Schema.decodeUnknownSync(InstallationId)("installation-one"), sshKnownHostsFile: "/tmp/operator-pin",
  }).pipe(Effect.provideService(SshTransport, transport), Effect.flip));
  expect(copiedBytes).toBeGreaterThan(0);
  expect(remoteText).toContain("installation-one");
  expect(remoteText).not.toContain("operator-pin");
  expect(error.disposition).toBe("uncertain"); expect(error.retryable).toBe(false);
});
