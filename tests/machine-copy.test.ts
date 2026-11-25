import { wordsText } from "./helpers/command-words";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, Layer, ManagedRuntime, Schema, Stream } from "effect";
import { Reactivity } from "effect/reactivity";
import { SqlClient } from "effect/sql";
import { ChildProcess as Command } from "effect/process";
import { afterEach, expect, it } from "vitest";
import { makeSqliteClient } from "../src/core/state/sqlite-client";
import { MACHINE_STATE_SCHEMA_SQL } from "../src/core/machines/state-schema";
import { MachinePersistenceError, MachineRepository, makeMachineRepositoryLive, RETIRED_PLACED_MESSAGE } from "../src/core/machines/repository";
import { MachineRefused } from "../src/core/machines/configuration";
import { linkClosed } from "../src/core/link/types";
import { LINK_NOT_OPENED_WORDS, makeMachineCopy, PINNED_ELSEWHERE_WORDS, RETIRED_PLACED_WORDS } from "../src/core/hosts/machine-copy";
import { HostsService } from "../src/core/hosts/service";
import { machineBundleFiles } from "../src/node/hosts/bundle";
import { SshTransport } from "../src/core/ssh";
import { SshTransferExitError } from "../src/core/ssh/service";
import type { MachineSendEvent } from "../src/shared/machine-progress";
import { createSshProgramCompiler } from "../src/core/ssh/program";
import { RemoteHost } from "../src/shared/remote-hosts";
import { MachineInstallResult, MachineInstallError, MachineSetupError } from "../src/shared/machine-install";
import type { MachineBundleAcquirer } from "../src/core/hosts/machine-bundle-download";
import { makeTestLog } from "./support/test-log";

const testLog = makeTestLog();

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
const fixture = async (options: { readonly keyBound?: boolean | ReadonlyArray<boolean>; readonly keyState?: "held" | "none" | "unreadable"; readonly cleared?: boolean; platform?: string; helloFailure?: boolean; bundleBuild?: string; acquireBundle?: MachineBundleAcquirer; status?: { readonly runningSeats?: number; readonly installationId?: string }; receiptName?: string; setupRefused?: "name-pinned-elsewhere" | "installation-pinned-elsewhere"; linkAnswer?: "never" | "refused"; farClaimsPinned?: boolean; recordFails?: boolean; helloClose?: "retired-placed-here" | "retired-placed-far" } = {}) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "junto-copy-")));
  await mkdir(join(root, "bin")); await mkdir(join(root, "core"));
  for (const name of ["bin/node", "bin/junto", "core/junto.cjs"]) await writeFile(join(root, name), "fixture\n");
  await chmod(join(root, "bin/node"), 0o755); await chmod(join(root, "bin/junto"), 0o755);
  const build = "a".repeat(64);
  await writeFile(join(root, "manifest.json"), JSON.stringify({ build: options.bundleBuild ?? build, target: "darwin-arm64", node: "26.10.0", appVersion: "1", files: await machineBundleFiles(root) }));
  const receipt = Schema.decodeUnknownSync(MachineInstallResult)({ build, juntoHome: "/home/probe", installRoot: "/home/probe/install", directory: "/home/probe/install/builds/" + build, serviceLabel: "test-service", provider: "launchd", updated: false, disposition: "ready", installationId: "mini-install", machineName: options.receiptName ?? "mini", pid: 71, transitions: [{ step: "ready", build, pid: 71 }] });
  const calls: string[] = [];
  const recorded: Array<{ machineName: string; juntoHome?: string; installRoot?: string; installationId: string }> = [];
  const database = new DatabaseSync(":memory:"); database.exec(MACHINE_STATE_SCHEMA_SQL);
  const sql = Layer.effect(SqlClient.SqlClient, makeSqliteClient(database)).pipe(Layer.provide(Reactivity.layer));
  const machines = makeMachineRepositoryLive({ defaultName: () => "macbook" }).pipe(Layer.provideMerge(sql));
  const compiler = createSshProgramCompiler({ controlDir: "/tmp/junto-copy-test", envExecutable: "/usr/bin/env", sshExecutable: "/usr/bin/ssh", environment: {} });
  let ownId = "";
  // Each setup answers the next keyBound in turn; a single value answers every one.
  const bound = [options.keyBound].flat();
  const nextKeyBound = () => (bound.length > 1 ? bound.shift() : bound[0]);
  const transport = SshTransport.of({
    run: program => Effect.sync(() => {
      const command = compiler.oneShot(program).command;
      if (!Command.isStandardCommand(command)) throw new Error("expected argv command");
      if (wordsText(command.args).at(-1)!.includes("junto-preflight")) {
        calls.push("preflight"); return { stdout: "ready\n", stderr: "" };
      }
      if (wordsText(command.args).at(-1)!.includes("'status'")) {
        calls.push("status");
        return { stdout: JSON.stringify({ ok: true, command: "machine status", data: {
          build, form: "mac-mini", installationId: options.status?.installationId ?? receipt.installationId, machineName: "mini", juntoHome: receipt.juntoHome,
          pid: 71, ...(options.status?.runningSeats === undefined ? {} : { runningSeats: options.status.runningSeats }), ready: true,
        } }), stderr: "" };
      }
      calls.push("platform"); return { stdout: options.platform ?? "Darwin arm64\n", stderr: "" };
    }),
    transfer: (program, input) => Effect.gen(function* () {
      yield* Stream.runDrain(input);
      const command = compiler.stream(program).command;
      if (!Command.isStandardCommand(command)) throw new Error("expected argv command");
      const remote = wordsText(command.args).at(-1)!;
      const op = remote.includes("install-local") ? "install" : remote.includes("configure") ? "configure" : "setup";
      calls.push(op);
      // The far's own refusal of the pin: the CLI's failure line on stderr, with the rule typed (S4).
      if (op === "setup" && options.setupRefused !== undefined) return yield* Effect.fail(SshTransferExitError.of("mac-mini" as never, 1, "", `${JSON.stringify({ ok: false, command: "machine setup",
        error: { type: "io", message: "machine \"macbook\" is pinned to another installation; choose another name", details: { retryable: false, pinRefused: options.setupRefused } } })}\n`));
      const result = op === "install" ? { ok: true, command: "machine install-local",
        data: options.farClaimsPinned === true ? { ...receipt, transitions: [...receipt.transitions, { step: "pinned" }] } : receipt }
        : op === "configure" ? { ok: true, command: "machine configure", data: { machineName: "mini", installationId: receipt.installationId } }
        : (() => { const keyBound = nextKeyBound(); return { ok: true, command: "machine setup", data: { machineName: "macbook", installationId: ownId, boundAt: "now", ...(keyBound === undefined ? {} : { keyBound }) } }; })();
      return { stdout: JSON.stringify(result), stderr: "" };
    }),
    connect: () => Effect.die("unexpected"), forward: () => Effect.die("unexpected"), warm: () => Effect.void, teardown: () => Effect.void,
  });
  const hosts = HostsService.of({ list: Effect.succeed([]), get: () => Effect.succeed(undefined), upsert: value => Effect.sync(() => { calls.push("location"); expect(value).toMatchObject({ juntoHome: receipt.juntoHome, installRoot: receipt.installRoot }); return []; }), remove: () => Effect.succeed([]), test: () => Effect.succeed({ ok: true, detail: "", reachability: "reachable" }), doctor: Effect.succeed({ id: "test", label: "test", detail: "fixture", status: "ok" }), doctorSnapshot: Effect.succeed({ check: { id: "test", label: "test", detail: "fixture", status: "ok" }, observations: [] }) });
  const runtime = ManagedRuntime.make(Layer.mergeAll(machines, Layer.succeed(SshTransport, transport), Layer.succeed(HostsService, hosts), testLog.log.loggerLayer));
  cleanup.push(async () => { await runtime.dispose(); database.close(); await rm(root, { recursive: true, force: true }); });
  const repository = await runtime.runPromise(MachineRepository); ownId = await runtime.runPromise(repository.installationId);
  const copy = await runtime.runPromise(makeMachineCopy({ build, bundles: { "darwin-arm64": root }, acquireBundle: options.acquireBundle,
    disconnect: () => Effect.sync(() => { calls.push("disconnect"); }),
    connect: () => Effect.sync(() => { calls.push("connect"); }),
    linkOpenMs: 50,
    onPinnedElsewhere: (machineName, route, installationId) => Effect.gen(function* () {
      calls.push("record"); recorded.push({ machineName, juntoHome: route.juntoHome, installRoot: route.installRoot, installationId });
      if (options.recordFails === true) return yield* Effect.fail(new Error("the store is closed"));
    }),
    linkAnswers: (host) => Effect.gen(function* () {
      calls.push("answered"); expect(host.id).toBe("mini");
      if (options.linkAnswer === "never") return yield* Effect.never;
      if (options.linkAnswer === "refused") return yield* Effect.fail(new Error("SSH process ended: exit code 0"));
    }),
    settleRemovedLink: (name, route, installationId) => Effect.sync(() => {
      calls.push("settle"); expect(name).toBe("mini"); expect(route).toMatchObject({ juntoHome: receipt.juntoHome, installRoot: receipt.installRoot });
      expect(installationId).toBe(receipt.installationId);
    }),
    linkKeyState: () => options.keyState ?? "none",
    clearStaleLink: (route, holder) => Effect.sync(() => {
      calls.push("clear"); expect(route).toMatchObject({ id: "mini", juntoHome: receipt.juntoHome, installRoot: receipt.installRoot });
      expect(holder).toBe(receipt.installationId);
      return options.cleared ?? true;
    }),
    connectSetup: (host, installationId) => Effect.gen(function* () {
      calls.push("hello");
      expect(host.id).toBe("mini"); expect(installationId).toBe(receipt.installationId);
      if (options.helloFailure) return yield* Effect.fail(new Error("name is pinned to another installation; choose another name"));
      // This machine's own pin refused at the hello, as the link closes it (P2); or the far said the same words.
      if (options.helloClose !== undefined) return yield* Effect.fail(linkClosed({ machine: "mini", reason: "failed",
        ...(options.helloClose === "retired-placed-here"
          ? { by: "this-end" as const, cause: MachinePersistenceError.make({ operation: "pin-peer", message: RETIRED_PLACED_MESSAGE("mini"),
            cause: new MachineRefused({ check: "name-retired-placed", machine: "mini", message: RETIRED_PLACED_MESSAGE("mini") }) }) }
          : { by: "peer" as const, causes: [{ tag: "MachineRefused", message: RETIRED_PLACED_MESSAGE("mini") }] }) }));
      return yield* repository.pinPeer({ machineName: host.id, installationId });
    }),
  }));
  const host = Schema.decodeUnknownSync(RemoteHost)({ id: "mini", label: "Mini", isThisMachine: false, sshEndpoint: "mac-mini", capabilities: ["terminal"],
    ...(options.status === undefined ? {} : { juntoHome: receipt.juntoHome, installRoot: receipt.installRoot }) });
  const events: MachineSendEvent[] = [];
  const told = (event: MachineSendEvent) => { events.push(event); };
  return { root, calls, receipt, repository, runtime, events, recorded,
    copy: (mode: "send" | "update", input: { readonly stopRunningSeats?: boolean } = {}) => runtime.runPromise(copy(host, { name: "mini", ...input }, mode, told)),
    error: (mode: "send" | "update", bundle?: string) => runtime.runPromise(copy(host, { name: "mini", ...(bundle === undefined ? {} : { bundle }) }, mode, told).pipe(Effect.flip)) };
};

it("installs and configures before binding through the checked first hello", async () => {
  const f = await fixture();
  const sent = await f.copy("send");
  expect(sent.installationId).toBe(f.receipt.installationId);
  // The result lists the send's own step after the install's (receipt 24).
  expect(sent.transitions.map((transition) => transition.step)).toEqual(["ready", "pinned"]);
  expect(f.calls).toEqual(["platform", "disconnect", "preflight", "install", "configure", "settle", "setup", "location", "hello", "answered"]);
  expect((await f.runtime.runPromise(f.repository.peer("mini")))?.installationId).toBe(f.receipt.installationId);
});

const STALE = "That machine still accepts an old link from this one, and Junto could not clear it. Send Junto again.";

it("clears a stale link once, against the installation it confirmed, when the machine lets this one in only through a key this one no longer holds, then sets up again", async () => {
  const f = await fixture({ keyBound: [true, false] });
  expect((await f.copy("send")).installationId).toBe(f.receipt.installationId);
  expect(f.calls).toEqual(["platform", "disconnect", "preflight", "install", "configure", "settle", "setup", "clear", "setup", "location", "hello", "answered"]);
});

const UNREADABLE = "This machine's link key for that machine cannot be read. Remove that machine, then add it again and send Junto to it.";

it.each([
  ["the clear did not take", { keyBound: true, cleared: false }, ["setup", "clear"], STALE],
  ["setup is still key-bound after the clear", { keyBound: true }, ["setup", "clear", "setup"], STALE],
  ["the link key here cannot be read", { keyBound: true, keyState: "unreadable" as const }, ["setup"], UNREADABLE],
])("fails in its own words, with no loop and keeping the route but never a pin, when %s", async (_label, options, tail, words) => {
  const f = await fixture(options);
  const error = await f.error("send");
  expect(error).toBeInstanceOf(MachineSetupError);
  expect(await f.runtime.runPromise(f.repository.peer("mini"))).toBeUndefined();
  if (error instanceof MachineSetupError) {
    expect(error.message).toBe(words);
    expect(error.ownWords).toBe(true);
    expect(error.installed).toEqual(f.receipt);
  }
  expect(f.calls).toEqual(["platform", "disconnect", "preflight", "install", "configure", "settle", ...tail, "location"]);
});

it("sends as before for a machine that still holds its link key, or a plain pin, with no clear", async () => {
  const held = await fixture({ keyBound: true, keyState: "held" });
  expect((await held.copy("send")).installationId).toBe(held.receipt.installationId);
  expect(held.calls).not.toContain("clear");
  const plain = await fixture({ keyBound: false });
  expect((await plain.copy("send")).installationId).toBe(plain.receipt.installationId);
  expect(plain.calls).not.toContain("clear");
});

it("updates an active pin without configuring or reviving a binding", async () => {
  const f = await fixture();
  await f.runtime.runPromise(f.repository.pinPeer({ machineName: "mini", installationId: f.receipt.installationId }));
  expect((await f.copy("update")).transitions.map((transition) => transition.step)).toEqual(["ready"]);
  expect(f.calls).toEqual(["platform", "disconnect", "preflight", "install", "location", "connect", "answered"]);
});

it("refuses an update before the transfer when seats run there, and keeps the link", async () => {
  const f = await fixture({ status: { runningSeats: 2 } });
  await f.runtime.runPromise(f.repository.pinPeer({ machineName: "mini", installationId: f.receipt.installationId }));
  const error = await f.error("update");
  expect(error).toBeInstanceOf(MachineInstallError);
  if (error instanceof MachineInstallError) {
    expect(error.disposition).toBe("staged");
    expect(error.runningSeats).toBe(2);
    expect(error.message).toContain("2 seats are running");
    expect(error.ownWords).toBe(true);
  }
  expect(f.calls).toEqual(["platform", "status"]);
});

it("fails closed when the machine cannot say how many seats it runs", async () => {
  const f = await fixture({ status: {} });
  await f.runtime.runPromise(f.repository.pinPeer({ machineName: "mini", installationId: f.receipt.installationId }));
  const error = await f.error("update");
  expect(error).toBeInstanceOf(MachineInstallError);
  if (error instanceof MachineInstallError) {
    expect(error.disposition).toBe("staged");
    expect(error.runningSeatsUnknown).toBe(true);
    expect(error.ownWords).toBe(true);
  }
  expect(f.calls).toEqual(["platform", "status"]);
});

it("skips the fast gate only when the operator confirmed stopping the seats", async () => {
  const f = await fixture({ status: { runningSeats: 2 } });
  await f.runtime.runPromise(f.repository.pinPeer({ machineName: "mini", installationId: f.receipt.installationId }));
  await f.copy("update", { stopRunningSeats: true });
  expect(f.calls).toEqual(["platform", "disconnect", "preflight", "install", "location", "connect", "answered"]);
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

it("says work here is still placed on a removed name when this machine's own pin refused it at the hello (P2)", async () => {
  const f = await fixture({ helloClose: "retired-placed-here" });
  const error = await f.error("send");
  expect(error).toBeInstanceOf(MachineSetupError);
  if (error instanceof MachineSetupError) {
    expect(error.message).toBe(RETIRED_PLACED_WORDS);
    expect(error).toMatchObject({ ownWords: true, retryable: false, installed: f.receipt });
    expect(error.takeoverRemote).toBeUndefined();
  }
  expect(await f.runtime.runPromise(f.repository.peer("mini"))).toBeUndefined();
});

it("never takes the placed-work words from a close the far sent", async () => {
  const f = await fixture({ helloClose: "retired-placed-far" });
  const error = await f.error("send");
  expect(error).toBeInstanceOf(MachineSetupError);
  if (error instanceof MachineSetupError) { expect(error.message).not.toBe(RETIRED_PLACED_WORDS); expect(error.ownWords).toBeUndefined(); }
});

it("refuses an unavailable target bundle or different fingerprint before disconnecting", async () => {
  for (const options of [{ platform: "Linux x86_64\n" }, { bundleBuild: "b".repeat(64) }]) {
    const f = await fixture(options);
    const error = await f.error("send");
    expect(error).toBeInstanceOf(MachineInstallError);
    expect(f.calls).toEqual(["platform"]);
  }
});

it("refuses a release's explicit local override before download or target inspection", async () => {
  let downloads = 0;
  const f = await fixture({ acquireBundle: () => Effect.sync(() => { downloads++; return "/unused"; }) });
  const error = await f.error("send", f.root);
  expect(error).toBeInstanceOf(MachineInstallError);
  expect(error.message).toContain("local package cannot replace");
  expect(f.calls).toEqual([]); expect(downloads).toBe(0);
});

it("leaves the link and service untouched when release download admission fails, even with a local bundle present", async () => {
  const f = await fixture({ acquireBundle: () => Effect.fail(new MachineInstallError({
    message: "Junto's download failed its check. The machine has not changed", disposition: "staged", retryable: true,
  })) });
  const error = await f.error("send");
  expect(error.message).toContain("download failed its check");
  expect(f.calls).toEqual(["platform"]);
});

const CHANGED = "It now answers as a different install of Junto, so nothing changed. Preview a take-over with junto machine takeover to see which seats and automations move.";

it.each(["send", "update"] as const)("refuses a %s to a pinned machine that answers as another install before anything is copied, with the take-over fields", async (mode) => {
  const f = await fixture({ status: { runningSeats: 0, installationId: "fresh-install" } });
  await f.runtime.runPromise(f.repository.pinPeer({ machineName: "mini", installationId: f.receipt.installationId }));
  const error = await f.error(mode);
  expect(error).toBeInstanceOf(MachineInstallError);
  if (error instanceof MachineInstallError) {
    expect(error.message).toBe(CHANGED);
    expect(error.ownWords).toBe(true);
    expect(error.disposition).toBe("staged");
    // The command is never in the words: the CLI builds it from these.
    expect(error.message).not.toContain("fresh-install");
    expect(error.takeover).toEqual({ machineName: "mini", installationId: "fresh-install", previousInstallationId: f.receipt.installationId });
  }
  expect(f.calls).toEqual(["platform", "status"]);
  expect((await f.runtime.runPromise(f.repository.peer("mini")))?.installationId).toBe(f.receipt.installationId);
});

it("sends to a pinned machine whose core does not answer: the installer checks the started core itself", async () => {
  const f = await fixture();
  await f.runtime.runPromise(f.repository.pinPeer({ machineName: "mini", installationId: f.receipt.installationId }));
  await f.copy("send");
  expect(f.calls).toEqual(["platform", "disconnect", "preflight", "install", "setup", "location", "connect", "answered"]);
});

it("names a pinned install it never linked with, as a take-over leaves it, has it pin this machine, then connects", async () => {
  const f = await fixture({ receiptName: "box-node-f10f4a0d6fe5c4ab" });
  await f.runtime.runPromise(f.repository.pinPeer({ machineName: "mini", installationId: f.receipt.installationId }));
  await f.copy("send");
  expect(f.calls).toEqual(["platform", "disconnect", "preflight", "install", "configure", "setup", "location", "connect", "answered"]);
});

// Receipt 22: after a take-over the new install held no pin of this machine, so it refused every link
// from here while the send read ready. A hello seen from it is no proof it pinned this one.
it.each([
  ["a take-over pin never linked", false],
  ["a pin whose hello was seen", true],
])("has the machine pin this one on a send to %s, with the key checks of a first send", async (_label, seen) => {
  const f = await fixture();
  await f.runtime.runPromise(f.repository.pinPeer({ machineName: "mini", installationId: f.receipt.installationId }));
  if (seen) await f.runtime.runPromise(f.repository.notePeerHello({ machineName: "mini", installationId: f.receipt.installationId, build: "a".repeat(64) }));
  await f.copy("send");
  expect(f.calls).toEqual(["platform", "disconnect", "preflight", "install", "setup", "location", "connect", "answered"]);
  // The send says the machine pinned this one again (S5).
  expect(f.events).toContainEqual({ event: "machine-install", juntoHome: f.receipt.juntoHome, installRoot: f.receipt.installRoot, step: "pinned" });
});

it("fails a send to an existing pin in its own words when the machine lets this one in only by a key gone from here", async () => {
  const f = await fixture({ keyBound: true, keyState: "unreadable" });
  await f.runtime.runPromise(f.repository.pinPeer({ machineName: "mini", installationId: f.receipt.installationId }));
  const error = await f.error("send");
  expect(error).toBeInstanceOf(MachineSetupError);
  expect(error.message).toBe(UNREADABLE);
  expect(f.calls).not.toContain("connect");
});

it("still refuses a pinned machine that linked and then took another name there", async () => {
  const f = await fixture({ receiptName: "renamed" });
  await f.runtime.runPromise(f.repository.pinPeer({ machineName: "mini", installationId: f.receipt.installationId }));
  await f.runtime.runPromise(f.repository.notePeerHello({ machineName: "mini", installationId: f.receipt.installationId, build: "a".repeat(64) }));
  const error = await f.error("send");
  expect(error).toBeInstanceOf(MachineSetupError);
  expect(error.message).toContain("calls itself another name");
  expect(f.calls).not.toContain("configure");
});

it("clears a stale link once on a send to an existing pin whose machine lets this one in only by a key gone from here, then sets up again", async () => {
  const f = await fixture({ keyBound: [true, false], keyState: "none" });
  await f.runtime.runPromise(f.repository.pinPeer({ machineName: "mini", installationId: f.receipt.installationId }));
  await f.copy("send");
  expect(f.calls).toEqual(["platform", "disconnect", "preflight", "install", "setup", "clear", "setup", "location", "connect", "answered"]);
});

it.each(["name-pinned-elsewhere", "installation-pinned-elsewhere"] as const)("ends a send to an existing pin not ready when the machine trusts another install under this name (%s), keeping the route and the pin, with the take-over-remote name", async (check) => {
  const f = await fixture({ setupRefused: check });
  await f.runtime.runPromise(f.repository.pinPeer({ machineName: "mini", installationId: f.receipt.installationId }));
  const error = await f.error("send");
  expect(error).toBeInstanceOf(MachineSetupError);
  if (error instanceof MachineSetupError) {
    expect(error.message).toBe(PINNED_ELSEWHERE_WORDS);
    expect(error.ownWords).toBe(true);
    expect(error.retryable).toBe(false);
    expect(error.takeoverRemote).toEqual({ machineName: "mini" });
    expect(error.installed).toEqual(f.receipt);
  }
  // Once, with no retry, no take-over and no link: the route is kept for the preview there.
  expect(f.calls).toEqual(["platform", "disconnect", "preflight", "install", "setup", "location", "record"]);
  expect((await f.runtime.runPromise(f.repository.peer("mini")))?.installationId).toBe(f.receipt.installationId);
  expect(f.events.some((event) => event.event === "machine-install" && event.step === "pinned")).toBe(false);
});

it.each(["never", "refused"] as const)("ends a send not ready, retryable, when the link does not open in time (%s), keeping the route and the pin", async (linkAnswer) => {
  const f = await fixture({ linkAnswer });
  await f.runtime.runPromise(f.repository.pinPeer({ machineName: "mini", installationId: f.receipt.installationId }));
  const error = await f.error("send");
  expect(error).toBeInstanceOf(MachineSetupError);
  if (error instanceof MachineSetupError) {
    expect(error.message).toBe(LINK_NOT_OPENED_WORDS);
    expect(error.retryable).toBe(true);
    expect(error.ownWords).toBe(true);
    expect(error.takeoverRemote).toBeUndefined();
  }
  // Asked once: no loop.
  expect(f.calls).toEqual(["platform", "disconnect", "preflight", "install", "setup", "location", "connect", "answered"]);
  expect((await f.runtime.runPromise(f.repository.peer("mini")))?.installationId).toBe(f.receipt.installationId);
});

it("ends a first send not ready when the link it set up does not open in time", async () => {
  const f = await fixture({ linkAnswer: "never" });
  const error = await f.error("send");
  expect(error).toBeInstanceOf(MachineSetupError);
  expect(error.message).toBe(LINK_NOT_OPENED_WORDS);
  expect(f.calls).toEqual(["platform", "disconnect", "preflight", "install", "configure", "settle", "setup", "location", "hello", "answered"]);
});

it.each(["name-pinned-elsewhere", "installation-pinned-elsewhere"] as const)("ends a first send not ready when the machine still trusts this machine's earlier install (%s), with the take-over-remote name and no pin here (receipt 24)", async (check) => {
  const f = await fixture({ setupRefused: check });
  const error = await f.error("send");
  expect(error).toBeInstanceOf(MachineSetupError);
  if (error instanceof MachineSetupError) {
    expect(error.message).toBe(PINNED_ELSEWHERE_WORDS);
    expect(error.message).not.toContain("choose another name");
    expect(error.ownWords).toBe(true);
    expect(error.retryable).toBe(false);
    expect(error.takeoverRemote).toEqual({ machineName: "mini" });
  }
  expect(f.calls).toEqual(["platform", "disconnect", "preflight", "install", "configure", "settle", "setup", "location", "record"]);
  expect(await f.runtime.runPromise(f.repository.peer("mini"))).toBeUndefined();
  // The installation the install receipt named, with the route kept, for take-over-remote.
  expect(f.recorded).toEqual([{ machineName: "mini", juntoHome: f.receipt.juntoHome, installRoot: f.receipt.installRoot, installationId: f.receipt.installationId }]);
});

it("refuses a far install receipt that claims the pinned step: only this machine adds it (receipt 24, remote-security)", async () => {
  const f = await fixture({ farClaimsPinned: true });
  const error = await f.error("send");
  expect(error).toBeInstanceOf(MachineInstallError);
  expect(f.calls).not.toContain("setup");
  expect(f.events.some((event) => event.event === "machine-install" && event.step === "pinned")).toBe(false);
  expect(await f.runtime.runPromise(f.repository.peer("mini"))).toBeUndefined();
});

it("keeps the S4 refusal as it is when the refused setup cannot be recorded", async () => {
  const f = await fixture({ setupRefused: "name-pinned-elsewhere", recordFails: true });
  const error = await f.error("send");
  expect(error).toBeInstanceOf(MachineSetupError);
  if (error instanceof MachineSetupError) {
    expect(error.message).toBe(PINNED_ELSEWHERE_WORDS);
    expect(error.takeoverRemote).toEqual({ machineName: "mini" });
  }
  expect(f.calls.filter((call) => call === "record")).toHaveLength(1);
});

it("records nothing on a send that ends ready or on a link that does not open", async () => {
  for (const options of [{}, { linkAnswer: "never" as const }]) {
    const f = await fixture(options);
    await f.copy("send").catch(() => undefined);
    expect(f.calls).not.toContain("record");
  }
});
