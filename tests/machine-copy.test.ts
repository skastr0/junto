import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Layer, ManagedRuntime, Schema, Stream } from "effect";
import { Reactivity } from "effect/unstable/reactivity";
import { SqlClient } from "effect/unstable/sql";
import * as Command from "effect/unstable/process/ChildProcess";
import { afterEach, expect, it } from "vitest";
import { makeSqliteClient } from "../src/main/junto/state/sqlite-client";
import { MACHINE_STATE_SCHEMA_SQL } from "../src/main/junto/machines/state-schema";
import { MachineRepository, makeMachineRepositoryLive } from "../src/main/junto/machines/repository";
import { makeMachineCopy } from "../src/main/junto/hosts/machine-copy";
import { HostsService } from "../src/main/junto/hosts/service";
import { machineBundleFiles } from "../src/main/junto/hosts/bundle";
import { SshTransport } from "../src/main/junto/ssh";
import { createSshProgramCompiler } from "../src/main/junto/ssh/program";
import { RemoteHost } from "../src/shared/remote-hosts";
import { MachineInstallResult, MachineInstallError, MachineSetupError } from "../src/shared/machine-install";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const fixture = async (options: { platform?: string; helloFailure?: boolean; bundleBuild?: string } = {}) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "junto-copy-")));
  await mkdir(join(root, "bin")); await mkdir(join(root, "core"));
  for (const name of ["bin/node", "bin/junto", "core/junto.cjs"]) await writeFile(join(root, name), "fixture\n");
  await chmod(join(root, "bin/node"), 0o755); await chmod(join(root, "bin/junto"), 0o755);
  const build = "a".repeat(64);
  await writeFile(join(root, "manifest.json"), JSON.stringify({ build: options.bundleBuild ?? build, target: "darwin-arm64", node: "26.10.0", appVersion: "1", files: await machineBundleFiles(root) }));
  const receipt = Schema.decodeUnknownSync(MachineInstallResult)({ build, juntoHome: "/home/probe", installRoot: "/home/probe/install", directory: "/home/probe/install/builds/" + build, serviceLabel: "test-service", provider: "launchd", updated: false, disposition: "ready", installationId: "mini-install", machineName: "mini", pid: 71, transitions: [{ step: "ready", build, pid: 71 }] });
  const calls: string[] = [];
  const database = new DatabaseSync(":memory:"); database.exec(MACHINE_STATE_SCHEMA_SQL);
  const sql = Layer.effect(SqlClient.SqlClient, makeSqliteClient(database)).pipe(Layer.provide(Reactivity.layer));
  const machines = makeMachineRepositoryLive({ defaultName: () => "macbook" }).pipe(Layer.provideMerge(sql));
  const compiler = createSshProgramCompiler({ controlDir: "/tmp/junto-copy-test", envExecutable: "/usr/bin/env", sshExecutable: "/usr/bin/ssh", environment: {} });
  let ownId = "";
  const transport = SshTransport.of({
    run: program => Effect.sync(() => {
      const command = compiler.oneShot(program).command;
      if (!Command.isStandardCommand(command)) throw new Error("expected argv command");
      if (command.args.at(-1)!.includes("junto-preflight")) {
        calls.push("preflight"); return { stdout: "ready\n", stderr: "" };
      }
      calls.push("platform"); return { stdout: options.platform ?? "Darwin arm64\n", stderr: "" };
    }),
    transfer: (program, input) => Effect.gen(function* () {
      yield* Stream.runDrain(input);
      const command = compiler.stream(program).command;
      if (!Command.isStandardCommand(command)) throw new Error("expected argv command");
      const remote = command.args.at(-1)!;
      const op = remote.includes("install-local") ? "install" : remote.includes("configure") ? "configure" : "setup";
      calls.push(op);
      const result = op === "install" ? { ok: true, command: "machine install-local", data: receipt }
        : op === "configure" ? { ok: true, command: "machine configure", data: { machineName: "mini", installationId: receipt.installationId } }
        : { ok: true, command: "machine setup", data: { machineName: "macbook", installationId: ownId, boundAt: "now" } };
      return { stdout: JSON.stringify(result), stderr: "" };
    }),
    connect: () => Effect.die("unexpected"), forward: () => Effect.die("unexpected"), warm: () => Effect.void, teardown: () => Effect.void,
  });
  const hosts = HostsService.of({ list: Effect.succeed([]), get: () => Effect.succeed(undefined), upsert: value => Effect.sync(() => { calls.push("location"); expect(value).toMatchObject({ juntoHome: receipt.juntoHome, installRoot: receipt.installRoot }); return []; }), remove: () => Effect.succeed([]), test: () => Effect.succeed({ ok: true, detail: "", reachability: "reachable" }), doctor: Effect.succeed({ id: "test", label: "test", detail: "fixture", status: "ok" }), doctorSnapshot: Effect.succeed({ check: { id: "test", label: "test", detail: "fixture", status: "ok" }, observations: [] }) });
  const runtime = ManagedRuntime.make(Layer.mergeAll(machines, Layer.succeed(SshTransport, transport), Layer.succeed(HostsService, hosts)));
  cleanup.push(async () => { await runtime.dispose(); database.close(); await rm(root, { recursive: true, force: true }); });
  const repository = await runtime.runPromise(MachineRepository); ownId = await runtime.runPromise(repository.installationId);
  const copy = await runtime.runPromise(makeMachineCopy({ build, bundles: { "darwin-arm64": root },
    disconnect: () => Effect.sync(() => { calls.push("disconnect"); }),
    connect: () => Effect.sync(() => { calls.push("connect"); }),
    connectSetup: (host, installationId) => Effect.gen(function* () {
      calls.push("hello");
      expect(host.id).toBe("mini"); expect(installationId).toBe(receipt.installationId);
      if (options.helloFailure) return yield* Effect.fail(new Error("name is pinned to another installation; choose another name"));
      return yield* repository.pinPeer({ machineName: host.id, installationId });
    }),
  }));
  const host = Schema.decodeUnknownSync(RemoteHost)({ id: "mini", label: "Mini", isThisMachine: false, sshEndpoint: "mac-mini", capabilities: ["terminal", "hermes"] });
  return { root, calls, receipt, repository, runtime, copy: (mode: "send" | "update") => runtime.runPromise(copy(host, { name: "mini" }, mode)), error: (mode: "send" | "update") => runtime.runPromise(copy(host, { name: "mini" }, mode).pipe(Effect.flip)) };
};

it("installs and configures before binding through the checked first hello", async () => {
  const f = await fixture();
  expect((await f.copy("send")).installationId).toBe(f.receipt.installationId);
  expect(f.calls).toEqual(["platform", "disconnect", "preflight", "install", "configure", "setup", "location", "hello"]);
  expect((await f.runtime.runPromise(f.repository.peer("mini")))?.installationId).toBe(f.receipt.installationId);
});

it("updates an active pin without configuring or reviving a binding", async () => {
  const f = await fixture();
  await f.runtime.runPromise(f.repository.pinPeer({ machineName: "mini", installationId: f.receipt.installationId }));
  await f.copy("update");
  expect(f.calls).toEqual(["platform", "disconnect", "preflight", "install", "location", "connect"]);
});

it("refuses update without setup before touching the target", async () => {
  const f = await fixture();
  expect(await f.error("update")).toBeInstanceOf(MachineInstallError);
  expect(f.calls).toEqual([]);
});

it("keeps the installed receipt when first hello refuses setup and never resends", async () => {
  const f = await fixture({ helloFailure: true });
  const error = await f.error("send");
  expect(error).toBeInstanceOf(MachineSetupError);
  if (error instanceof MachineSetupError) { expect(error.installed).toEqual(f.receipt); expect(error.message).toContain("choose another name"); expect(error.retryable).toBe(false); }
  expect(f.calls.filter(call => call === "install")).toHaveLength(1);
  expect(await f.runtime.runPromise(f.repository.peer("mini"))).toBeUndefined();
});

it("refuses an unavailable target bundle or different fingerprint before disconnecting", async () => {
  for (const options of [{ platform: "Linux x86_64\n" }, { bundleBuild: "b".repeat(64) }]) {
    const f = await fixture(options);
    const error = await f.error("send");
    expect(error).toBeInstanceOf(MachineInstallError);
    expect(f.calls).toEqual(["platform"]);
  }
});
