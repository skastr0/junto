/**
 * `junto machine link mini vps`, run on the editing machine (hosts/machine-link.ts):
 * three machines in one process, each with its own database, home and
 * authorized_keys. The SSH double compiles every program with the real
 * policy compiler, so each setup session's argv is checked, and hands an
 * owner command to that machine's own setup, as `junto machine <op> -` would.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as Command from "effect/unstable/process/ChildProcess";
import { Effect, Layer, ManagedRuntime, Schema, Stream } from "effect";
import { afterEach, expect, it } from "vitest";
import { generatePairingKey } from "../src/main/junto/companion/pairing-key";
import { makeMachineLinkSetup, type MachineLinkSetup } from "../src/main/junto/hosts/machine-link";
import { HostsService } from "../src/main/junto/hosts/service";
import { linkHomeTag, readBoundRoute } from "../src/main/junto/link/link-keys";
import { MachineLink } from "../src/main/junto/link/service";
import { MachineRepository, makeMachineRepositoryLive } from "../src/main/junto/machines/repository";
import { createSshProgramCompiler } from "../src/main/junto/ssh/program";
import { SshTransport, SshTransferExitError, type SshTransportShape } from "../src/main/junto/ssh/service";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { InstallationId } from "../src/shared/installation-id";
import {
  MachineLinkAcceptInput, MachineLinkKeyInput, MachineLinkOpenInput, MachineLinkRevokeInput,
} from "../src/shared/machine-link";
import { RemoteHost } from "../src/shared/remote-hosts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

const compiler = createSshProgramCompiler({ controlDir: "/tmp/junto-link-setup-test", envExecutable: "/usr/bin/env", sshExecutable: "/usr/bin/ssh", environment: {} });
const argv = (command: Command.Command): ReadonlyArray<string> => {
  if (!Command.isStandardCommand(command)) throw new TypeError("expected StandardCommand");
  return command.args.slice(command.args.indexOf("/usr/bin/ssh") + 1);
};

interface Machine {
  readonly name: string;
  readonly home: string;
  readonly address: string;
  readonly hostKey: string;
  readonly authorizedKeys: string;
  readonly installationId: InstallationId;
  readonly hosts: Map<string, RemoteHost>;
  readonly dialed: Array<{ readonly name: string; readonly installationId: InstallationId }>;
  readonly sessions: Array<ReadonlyArray<string>>;
  readonly runtime: ManagedRuntime.ManagedRuntime<MachineRepository | HostsService | SshTransport | MachineLink, unknown>;
  setup: MachineLinkSetup;
}

const run = <A, E>(machine: Machine, effect: Effect.Effect<A, E, MachineRepository | HostsService | SshTransport | MachineLink>) => machine.runtime.runPromise(effect);

/** The editing machine, the mini and the VPS; the editor has an operator route to both, by alias. */
const fleet = async () => {
  const all = new Map<string, Machine>();
  const byEndpoint = new Map<string, Machine>();
  const make = async (name: string, address: string): Promise<Machine> => {
    const home = await mkdtemp(join(tmpdir(), `junto-link-setup-${name}-`));
    const hosts = new Map<string, RemoteHost>();
    const dialed: Machine["dialed"] = [];
    const sessions: Machine["sessions"] = [];
    const knownHosts = join(home, "known_hosts");
    // This account already verified every other machine's host key, under its resolved address.
    const ssh = SshTransport.of({
      run: (program) => Effect.sync(() => {
        const args = argv(compiler.oneShot(program as never).command);
        expect(args[0]).toBe("-G");
        const target = byEndpoint.get(args.at(-1)!)!;
        return { stdout: [`user ops`, `hostname ${target.address}`, `port 22`, `userknownhostsfile ${knownHosts} ${join(home, "known_hosts2")}`, `globalknownhostsfile /etc/ssh/absent`, ""].join("\n"), stderr: "" };
      }),
      transfer: ((program: never, input: Stream.Stream<Uint8Array>) => Effect.gen(function* () {
        const args = argv(compiler.stream(program).command);
        sessions.push(args);
        const endpoint = args.at(-2)!;
        const target = byEndpoint.get(endpoint);
        if (target === undefined) return yield* Effect.fail(SshTransferExitError.of(endpoint as never, 255, "", "ssh: connect to host: no route to host\n"));
        const op =/'machine' '([a-z-]+)' '-'$/.exec(args.at(-1)!)![1]!;
        const chunks = yield* Stream.runCollect(input);
        const body = JSON.parse(Buffer.concat([...chunks].map((chunk) => Buffer.from(chunk))).toString()) as unknown;
        const decode = <A>(schema: Schema.Codec<A, unknown>) => Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(body);
        const answer = yield* Effect.promise(() => run(target,
          op === "link-key" ? target.setup.key(decode(MachineLinkKeyInput))
            : op === "link-accept" ? target.setup.accept(decode(MachineLinkAcceptInput))
              : op === "link-open" ? target.setup.open(decode(MachineLinkOpenInput))
                : target.setup.revoke(decode(MachineLinkRevokeInput)) as Effect.Effect<unknown, unknown, never>).then(
          (data) => ({ ok: true as const, data }),
          (cause: unknown) => ({ ok: false as const, message: cause instanceof Error ? cause.message : String(cause) })));
        if (!answer.ok) {
          return yield* Effect.fail(SshTransferExitError.of(endpoint as never, 1, "", `${JSON.stringify({ ok: false, command: `machine ${op}`, error: { type: "conflict", message: answer.message } })}\n`));
        }
        return { stdout: `${JSON.stringify({ ok: true, command: `machine ${op}`, data: answer.data })}\n`, stderr: "" };
      })) as unknown as SshTransportShape["transfer"],
      connect: () => Effect.die("no link in this test"),
      forward: () => Effect.die("no forward in this test"),
      warm: () => Effect.void,
      teardown: () => Effect.void,
    });
    const link = MachineLink.of({
      setChannels: () => Effect.void,
      listen: () => Effect.die("no listener in this test"),
      connect: () => Effect.die("no plain dial in this test"),
      // The far end's Junto answers its own id at the checked hello.
      connectSetup: (host: RemoteHost, expected: InstallationId) => Effect.gen(function* () {
        const far = all.get(host.id)!;
        expect(far.installationId).toBe(expected);
        dialed.push({ name: host.id, installationId: expected });
        return yield* (yield* MachineRepository).pinPeer({ machineName: host.id, installationId: expected });
      }),
      disconnect: () => Effect.void,
      peerBuild: () => Effect.succeed(undefined),
      request: () => Effect.die("no request in this test"),
      sendEvent: () => Effect.die("no event in this test"),
    } as never);
    const hostsService = HostsService.of({
      list: Effect.sync(() => [...hosts.values()]),
      get: (id: string) => Effect.sync(() => hosts.get(id)),
      upsert: (value: unknown) => Effect.sync(() => { const host = Schema.decodeUnknownSync(RemoteHost)(value); hosts.set(host.id, host); return [...hosts.values()]; }),
      remove: (id: string) => Effect.sync(() => { hosts.delete(id); return [...hosts.values()]; }),
    } as never);
    const runtime = ManagedRuntime.make(Layer.mergeAll(
      Layer.provide(makeMachineRepositoryLive({ defaultName: () => name }), makeStateEngineLive(join(home, "junto.db"))),
      Layer.succeed(HostsService, hostsService), Layer.succeed(SshTransport, ssh), Layer.succeed(MachineLink, link),
    ));
    cleanups.push(async () => { await runtime.dispose(); await rm(home, { recursive: true, force: true }); });
    const installationId = await runtime.runPromise(Effect.flatMap(MachineRepository, (machines) => machines.installationId));
    const authorizedKeys = join(home, "authorized_keys");
    await writeFile(authorizedKeys, "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOperatorsOwnKeyOperatorsOwnKeyOperators operator@laptop\n");
    const machine: Machine = { name, home, address, hostKey: generatePairingKey().publicKey, authorizedKeys, installationId, hosts, dialed, sessions, runtime, setup: undefined as never };
    machine.setup = await runtime.runPromise(makeMachineLinkSetup({ home, juntoPath: () => `/opt/${name}/current/bin/junto`, authorizedKeysPath: authorizedKeys }));
    all.set(name, machine);
    byEndpoint.set(`${name}-alias`, machine);
    byEndpoint.set(`ops@${address}`, machine);
    return machine;
  };
  const editor = await make("book", "10.0.0.1");
  const mini = await make("mini", "10.0.0.2");
  const vps = await make("vps", "10.0.0.3");
  await writeFile(join(editor.home, "known_hosts"), `${mini.address} ${mini.hostKey}\n${vps.address} ${vps.hostKey}\n`);
  // Setup as send leaves it: the editor routes to and pins both; each pins the editor.
  for (const far of [mini, vps]) {
    editor.hosts.set(far.name, Schema.decodeUnknownSync(RemoteHost)({
      id: far.name, label: far.name, isThisMachine: false, sshEndpoint: `${far.name}-alias`, capabilities: ["terminal"],
      juntoHome: far.home, installRoot: `/opt/${far.name}`,
    }));
    await run(editor, Effect.flatMap(MachineRepository, (machines) => machines.pinPeer({ machineName: far.name, installationId: far.installationId })));
    await run(far, Effect.flatMap(MachineRepository, (machines) => machines.pinPeer({ machineName: editor.name, installationId: editor.installationId })));
  }
  return { editor, mini, vps };
};

it("keys the mini to the VPS and the editor to both, over setup sessions strict against the verified host keys", async () => {
  const { editor, mini, vps } = await fleet();
  const result = await run(editor, editor.setup.link({ from: "mini", to: "vps" }));

  // The operator reads every recorded route: the mini dials the VPS where the editor does.
  expect(result.routes).toEqual([
    { from: "mini", machine: "vps", user: "ops", host: vps.address, port: 22 },
    { from: "book", machine: "vps", user: "ops", host: vps.address, port: 22 },
    { from: "book", machine: "mini", user: "ops", host: mini.address, port: 22 },
  ]);
  // Every setup session pinned the one host key this account verified, strictly, and dialed by the operator's alias.
  expect(editor.sessions.length).toBe(4);
  for (const args of editor.sessions) {
    const far = args.at(-2)!.replace("-alias", "");
    expect(args).toContain("StrictHostKeyChecking=yes");
    expect(args).toContain(`UserKnownHostsFile=${join(editor.home, ".junto/core/link-keys", far, "known_hosts")}`);
    expect(args).not.toContain("-F");
  }
  // The VPS holds one restricted line for the mini and one for the editor; the operator's key survives.
  const vpsKeys = await readFile(vps.authorizedKeys, "utf8");
  expect(vpsKeys.startsWith("ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOperatorsOwnKey")).toBe(true);
  for (const opener of [mini, editor]) {
    expect(vpsKeys).toContain(`command="/usr/bin/env JUNTO_HOME='${vps.home}' '/opt/vps/current/bin/junto' link --opener ${opener.installationId}",restrict ssh-ed25519 `);
    expect(vpsKeys).toContain(`junto-link:${linkHomeTag(vps.home)}:${opener.installationId}\n`);
  }
  expect(await readFile(mini.authorizedKeys, "utf8")).toContain(`link --opener ${editor.installationId}",restrict`);
  // The mini pinned the VPS from its checked dial, by its bound route with the VPS host key only.
  expect(mini.dialed).toEqual([{ name: "vps", installationId: vps.installationId }]);
  const miniRoute = readBoundRoute(mini.home, "vps")!;
  expect(miniRoute).toMatchObject({ user: "ops", host: vps.address, port: 22 });
  expect(await readFile(miniRoute.knownHostsFile, "utf8")).toBe(`${vps.address} ${vps.hostKey}\n`);
  expect(mini.hosts.get("vps")).toMatchObject({ sshEndpoint: `ops@${vps.address}`, juntoHome: vps.home, installRoot: "/opt/vps" });
  // The editor now dials both by key.
  expect(readBoundRoute(editor.home, "vps")).toBeDefined();
  expect(readBoundRoute(editor.home, "mini")).toBeDefined();
  // The VPS pinned the mini as a new peer under its own name.
  expect(await run(vps, Effect.flatMap(MachineRepository, (machines) => machines.peer("mini")))).toMatchObject({ installationId: mini.installationId });
});

it("dials the VPS from the mini at the address the operator gives, still pinned to the verified key", async () => {
  const { editor, mini, vps } = await fleet();
  const result = await run(editor, editor.setup.link({ from: "mini", to: "vps", sshTarget: "deploy@vps.tailnet.ts.net" as never, sshPort: 2222 }));
  expect(result.routes[0]).toEqual({ from: "mini", machine: "vps", user: "deploy", host: "vps.tailnet.ts.net", port: 2222 });
  expect(await readFile(readBoundRoute(mini.home, "vps")!.knownHostsFile, "utf8")).toBe(`[vps.tailnet.ts.net]:2222 ${vps.hostKey}\n`);
});

it("never gives a machine a route to the editing machine", async () => {
  const { editor } = await fleet();
  await expect(run(editor, editor.setup.link({ from: "mini", to: "book" }))).rejects.toThrow(/dials out/);
});

it("refuses a host the editor never verified, before any key or session", async () => {
  const { editor, vps } = await fleet();
  await writeFile(join(editor.home, "known_hosts"), "");
  await expect(run(editor, editor.setup.link({ from: "mini", to: vps.name }))).rejects.toThrow(/No ed25519 host key is known/);
  expect(editor.sessions).toEqual([]);
});

it("takes a removed machine's line off the machines it reached, and keeps one it could not reach as still holding it", async () => {
  const { editor, mini, vps } = await fleet();
  await run(editor, editor.setup.link({ from: "mini", to: "vps" }));
  // The mini goes away for good: the editor removes it, and the VPS loses its line.
  await run(editor, Effect.flatMap(MachineRepository, (machines) => machines.retirePeer("mini")));
  editor.hosts.delete("mini");
  const still = await run(editor, editor.setup.revokeEverywhere({ machineName: "mini", installationId: mini.installationId }));
  expect(still).toEqual([]);
  expect(await readFile(vps.authorizedKeys, "utf8")).not.toContain(mini.installationId);
  expect(await readFile(vps.authorizedKeys, "utf8")).toContain(editor.installationId);

  // A holder that cannot be reached keeps the key listed until a later pass reaches it.
  const unreachable = { ...editor.hosts.get("vps")!, sshEndpoint: "nowhere-alias" as never };
  editor.hosts.set("vps", unreachable);
  const ghost = { machineName: "ghost", installationId: Schema.decodeUnknownSync(InstallationId)("ghost-installation") };
  await expect(run(editor, editor.setup.revokeEverywhere(ghost))).resolves.toEqual([{ holder: "vps", ...ghost }]);
  expect(editor.setup.pending()).toEqual([{ holder: "vps", ...ghost }]);
});
