/**
 * A link to a peer with a bound route dials with that route only: no SSH
 * config, no agent, its own key, strict against the one host key recorded at
 * setup (docs/machines.md, The link). A peer whose host key changed is
 * refused by OpenSSH before anything is sent, and the refusal names it.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import * as Command from "effect/unstable/process/ChildProcess";
import { Effect, Layer, ManagedRuntime, Schema, Stream } from "effect";
import { afterEach, expect, it } from "vitest";
import { generatePairingKey } from "../src/main/junto/companion/pairing-key";
import { makeLinkKey, writeBoundRoute, writeLinkKnownHosts } from "../src/main/junto/link/link-keys";
import { coreControlSocketPath } from "../src/main/junto/link/listener";
import { machineLinkLayer } from "../src/main/junto/link/live";
import { MachineLink } from "../src/main/junto/link/service";
import { MachineRepository, makeMachineRepositoryLive } from "../src/main/junto/machines/repository";
import { SshExitError } from "../src/main/junto/ssh/domain";
import { createSshProgramCompiler } from "../src/main/junto/ssh/program";
import { SshTransport, type SshLease, type SshTransportShape } from "../src/main/junto/ssh/service";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { InstallationId } from "../src/shared/installation-id";
import { RemoteHost } from "../src/shared/remote-hosts";
import { allChannels } from "./support/link-channels";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const compiler = createSshProgramCompiler({ controlDir: "/tmp/junto-bound-dial-test", envExecutable: "/usr/bin/env", sshExecutable: "/usr/bin/ssh", environment: {} });

it("dials a bound peer with its own key and known hosts only, and names the machine when its host key changed", async () => {
  const home = await mkdtemp("/tmp/junto-bound-dial-");
  const dialed: Array<ReadonlyArray<string>> = [];
  // OpenSSH's own answer when the host's key is not the one in the pinned file.
  const ssh = SshTransport.of({
    run: () => Effect.die("no one-shot commands in this test"),
    transfer: () => Effect.die("no transfers in this test"),
    forward: () => Effect.die("no forwards in this test"),
    warm: () => Effect.void,
    teardown: () => Effect.void,
    connect: ((program: never) => Effect.suspend(() => {
      const command = compiler.stream(program).command;
      if (!Command.isStandardCommand(command)) return Effect.die("expected StandardCommand");
      dialed.push(command.args.slice(command.args.indexOf("/usr/bin/ssh") + 1));
      return Effect.fail(new SshExitError({ endpoint: "ops@10.0.0.3", operation: "connect", code: 255,
        stderrTail: "@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@\nHost key for 10.0.0.3 has changed and you have requested strict checking.\nHost key verification failed.\n" }));
    })) as unknown as SshTransportShape["connect"],
  });
  const runtime = ManagedRuntime.make(Layer.provideMerge(machineLinkLayer("c".repeat(64), home), Layer.mergeAll(
    Layer.provide(makeMachineRepositoryLive({ defaultName: () => "mini" }), makeStateEngineLive(join(home, "junto.db"))),
    Layer.succeed(SshTransport, ssh),
  )));
  cleanups.push(async () => { await runtime.dispose(); await rm(home, { recursive: true, force: true }); });

  const self = await runtime.runPromise(Effect.flatMap(MachineRepository, (machines) => machines.installationId));
  makeLinkKey(home, "vps", self);
  const route = { user: "ops", host: "10.0.0.3", port: 22 };
  const knownHostsFile = writeLinkKnownHosts(home, "vps", route, [generatePairingKey().publicKey]);
  const bound = writeBoundRoute(home, "vps", route);
  await runtime.runPromise(Effect.gen(function* () {
    yield* (yield* MachineRepository).pinPeer({ machineName: "vps", installationId: Schema.decodeUnknownSync(InstallationId)("vps-installation") });
    const link = yield* MachineLink;
    yield* link.setChannels(allChannels());
    yield* link.listen(home);
  }));
  // The operator's route by alias stays recorded; the bound route replaces it for the link.
  const host = Schema.decodeUnknownSync(RemoteHost)({
    id: "vps", label: "vps", isThisMachine: false, sshEndpoint: "vps-alias", capabilities: ["terminal"],
    juntoHome: "/home/ops/junto", installRoot: "/home/ops/.local/junto",
  });

  const failed = await runtime.runPromise(Effect.flip(Effect.flatMap(MachineLink, (link) => link.connect(host))));
  expect(failed).toMatchObject({ machine: "vps", reason: "process-exited", exitCode: 255 });
  expect(String((failed as { stderrTail?: string }).stderrTail)).toContain("Host key verification failed");

  const args = dialed[0]!;
  expect(args[args.indexOf("-F") + 1]).toBe("none");
  for (const option of ["IdentityAgent=none", "StrictHostKeyChecking=yes", `UserKnownHostsFile=${knownHostsFile}`,
    "GlobalKnownHostsFile=/dev/null", "UpdateHostKeys=no", `IdentityFile=${bound.identityFile}`, "IdentitiesOnly=yes"]) {
    expect(args).toContain(option);
  }
  expect(args).toContain("ops@10.0.0.3");
  expect(args).not.toContain("vps-alias");
  expect(args.some((arg) => /accept-new/.test(arg))).toBe(false);
});

/** An SSH double whose dial reaches the peer's owner socket, as `junto link` relays it. */
const relayTo = (peerHome: () => string): SshTransportShape => SshTransport.of({
  run: () => Effect.die("no one-shot commands in this test"),
  transfer: () => Effect.die("no transfers in this test"),
  forward: () => Effect.die("no forwards in this test"),
  warm: () => Effect.void,
  teardown: () => Effect.void,
  connect: ((_program: unknown, awaitReady: (lease: SshLease, confirm: <A>(value: A) => never) => Effect.Effect<{ value: unknown }>) => Effect.gen(function* () {
    const socket = yield* Effect.callback<Socket>((resume) => {
      const opened = createConnection(coreControlSocketPath(peerHome()));
      opened.once("connect", () => resume(Effect.succeed(opened)));
      opened.once("error", (cause) => resume(Effect.die(cause)));
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => socket.destroy()));
    const lease: SshLease = {
      write: (bytes) => Effect.callback<void>((resume) => { socket.write(bytes, () => resume(Effect.void)); }),
      writeSensitive: () => Effect.die("no secrets in this test"),
      closeInput: Effect.sync(() => { socket.end(); }),
      stdout: Stream.fromAsyncIterable(socket as AsyncIterable<Uint8Array>, (cause) => cause as never),
      stderr: Stream.empty,
      exitCode: Effect.never,
      close: Effect.sync(() => { socket.destroy(); }),
    };
    return (yield* awaitReady(lease, (<A>(value: A) => ({ value })) as never)).value;
  })) as unknown as SshTransportShape["connect"],
});

it("tells a channel the link is key-bound at the end that dialed a bound route, and not over the operator's route", async () => {
  for (const bound of [true, false]) {
    let peerHome = "";
    const machine = async (name: string) => {
      const home = await mkdtemp(`/tmp/junto-keybound-${name}-`);
      const seen: Array<boolean> = [];
      const runtime = ManagedRuntime.make(Layer.provideMerge(machineLinkLayer("c".repeat(64), home), Layer.mergeAll(
        Layer.provide(makeMachineRepositoryLive({ defaultName: () => name }), makeStateEngineLive(join(home, "junto.db"))),
        Layer.succeed(SshTransport, relayTo(() => peerHome)),
      )));
      cleanups.push(async () => { await runtime.dispose(); await rm(home, { recursive: true, force: true }); });
      const id = await runtime.runPromise(Effect.flatMap(MachineRepository, (machines) => machines.installationId));
      return { name, home, seen, runtime, id };
    };
    const mini = await machine("mini");
    const vps = await machine("vps");
    peerHome = vps.home;
    const none = () => { throw new Error("no payloads in this test"); };
    for (const [at, peer] of [[mini, vps], [vps, mini]] as const) {
      await at.runtime.runPromise(Effect.gen(function* () {
        yield* (yield* MachineRepository).pinPeer({ machineName: peer.name, installationId: peer.id });
        const link = yield* MachineLink;
        yield* link.setChannels(allChannels({ consensus: { decodeRequest: none, decodeResponse: none, decodeEvent: none, opened: (context) => Effect.sync(() => { at.seen.push(context.keyBound); }) } }));
        yield* link.listen(at.home);
      }));
    }
    if (bound) {
      makeLinkKey(mini.home, "vps", mini.id);
      const route = { user: "ops", host: "10.0.0.3", port: 22 };
      writeLinkKnownHosts(mini.home, "vps", route, [generatePairingKey().publicKey]);
      writeBoundRoute(mini.home, "vps", route);
    }
    const host = Schema.decodeUnknownSync(RemoteHost)({
      id: "vps", label: "vps", isThisMachine: false, sshEndpoint: "vps-alias", capabilities: ["terminal"],
      juntoHome: vps.home, installRoot: join(vps.home, "install"),
    });
    await mini.runtime.runPromise(Effect.flatMap(MachineLink, (link) => link.connect(host)));
    await expect.poll(() => mini.seen.length + vps.seen.length).toBe(2);
    // The relay double names no opener, so the accepting end is never key-bound here.
    expect({ bound, dialer: mini.seen[0], accepter: vps.seen[0] }).toEqual({ bound, dialer: bound, accepter: false });
  }
});
