/**
 * `junto machine link mini vps`, run on the editing machine (hosts/machine-link.ts):
 * three machines in one process, each with its own database, home and
 * authorized_keys. The SSH double compiles every program with the real
 * policy compiler, so each setup session's argv is checked, and hands an
 * owner command to that machine's own setup, as `junto machine <op> -` would.
 */
import { wordsText } from "./helpers/command-words";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ChildProcess as Command } from "effect/process";
import { Effect, Layer, ManagedRuntime, Schema, Stream } from "effect";
import { afterEach, expect, it } from "vitest";
import { generatePairingKey } from "../src/core/companion/pairing-key";
import { makeMachineLinkSetup, type MachineLinkSetup } from "../src/core/hosts/machine-link";
import { HostsService } from "../src/core/hosts/service";
import { linkHomeTag, ownLinkKeySha256, readBoundRoute } from "../src/core/link/link-keys";
import { MachineLink } from "../src/core/link/service";
import { MachineRepository, makeMachineRepositoryLive } from "../src/core/machines/repository";
import { createSshProgramCompiler } from "../src/core/ssh/program";
import { SshTransport, SshTransferExitError, type SshTransportShape } from "../src/core/ssh/service";
import { makeStateEngineLive } from "../src/core/state/engine";
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
  return wordsText(command.args).slice(command.args.indexOf("/usr/bin/ssh") + 1);
};

interface Machine {
  readonly name: string;
  readonly home: string;
  readonly address: string;
  readonly hostKey: string;
  readonly authorizedKeys: string;
  readonly installRoot: string;
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
    // The installed layout this machine's core runs from: an owned root with an
    // owner marker and `current` as the selection link to one build.
    const installRoot = join(home, "install");
    const build = join("builds", `${"b".repeat(64)}-linux-x64`);
    await mkdir(join(installRoot, build, "bin"), { recursive: true, mode: 0o700 });
    await writeFile(join(installRoot, build, "bin", "junto"), "", { mode: 0o755 });
    await symlink(build, join(installRoot, "current"));
    await writeFile(join(installRoot, "owner.json"), JSON.stringify({ serviceLabel: "dev.junto.machine.0123456789abcdef", juntoHome: home }), { mode: 0o600 });
    const machine: Machine = { name, home, address, hostKey: generatePairingKey().publicKey, authorizedKeys, installRoot, installationId, hosts, dialed, sessions, runtime, setup: undefined as never };
    machine.setup = await runtime.runPromise(makeMachineLinkSetup({ home, juntoPath: () => join(installRoot, "current/bin/junto"), authorizedKeysPath: authorizedKeys }));
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
      juntoHome: far.home, installRoot: far.installRoot,
    }));
    await run(editor, Effect.flatMap(MachineRepository, (machines) => machines.pinPeer({ machineName: far.name, installationId: far.installationId })));
    await run(far, Effect.flatMap(MachineRepository, (machines) => machines.pinPeer({ machineName: editor.name, installationId: editor.installationId })));
  }
  /** Makes an address that dialed nowhere reach that machine: the far end came back. */
  const reach = (endpoint: string, machine: Machine) => { byEndpoint.set(endpoint, machine); };
  return { editor, mini, vps, reach };
};

const pinOf = (machine: Machine, name: string) => run(machine, Effect.flatMap(MachineRepository, (machines) => machines.peer(name)));
const pinRows = (machine: Machine) => run(machine, Effect.flatMap(MachineRepository, (machines) => machines.peers));
/** The editor's remove, after the far clear: its route, pin and key for that machine go here. */
const removeHere = async (editor: Machine, far: Machine) => {
  await run(editor, Effect.flatMap(MachineRepository, (machines) => machines.retirePeer(far.name)));
  editor.hosts.delete(far.name);
  await run(editor, editor.setup.forget(far.name, far.installationId));
};
/** The operator adds it again and sends: the editor routes to and pins it plainly. */
const addAgain = async (editor: Machine, far: Machine) => {
  editor.hosts.set(far.name, Schema.decodeUnknownSync(RemoteHost)({
    id: far.name, label: far.name, isThisMachine: false, sshEndpoint: `${far.name}-alias`, capabilities: ["terminal"], juntoHome: far.home, installRoot: far.installRoot,
  }));
  await run(editor, Effect.flatMap(MachineRepository, (machines) => machines.pinPeer({ machineName: far.name, installationId: far.installationId })));
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
    expect(vpsKeys).toContain(`command="/usr/bin/env JUNTO_HOME='${vps.home}' '${vps.installRoot}/current/bin/junto' link --opener ${opener.installationId}",restrict ssh-ed25519 `);
    expect(vpsKeys).toContain(`junto-link:${linkHomeTag(vps.home)}:${opener.installationId}\n`);
  }
  expect(await readFile(mini.authorizedKeys, "utf8")).toContain(`link --opener ${editor.installationId}",restrict`);
  // The mini pinned the VPS from its checked dial, by its bound route with the VPS host key only.
  expect(mini.dialed).toEqual([{ name: "vps", installationId: vps.installationId }]);
  const miniRoute = readBoundRoute(mini.home, "vps")!;
  expect(miniRoute).toMatchObject({ user: "ops", host: vps.address, port: 22 });
  expect(await readFile(miniRoute.knownHostsFile, "utf8")).toBe(`${vps.address} ${vps.hostKey}\n`);
  expect(mini.hosts.get("vps")).toMatchObject({ sshEndpoint: `ops@${vps.address}`, juntoHome: vps.home, installRoot: vps.installRoot });
  // The editor now dials both by key.
  expect(readBoundRoute(editor.home, "vps")).toBeDefined();
  expect(readBoundRoute(editor.home, "mini")).toBeDefined();
  // The VPS pinned the mini as a new peer under its own name.
  expect(await run(vps, Effect.flatMap(MachineRepository, (machines) => machines.peer("mini")))).toMatchObject({ installationId: mini.installationId });
});

it("refuses a junto path outside an installed current build before pinning or writing", async () => {
  const { mini } = await fleet();
  const before = await readFile(mini.authorizedKeys, "utf8");
  const opener = { machineName: "ghost", installationId: Schema.decodeUnknownSync(InstallationId)("ghost-installation"), publicKey: generatePairingKey().publicKey };
  const attempt = (juntoPath: string) => run(mini, Effect.flatMap(
    makeMachineLinkSetup({ home: mini.home, juntoPath: () => juntoPath, authorizedKeysPath: mini.authorizedKeys }),
    (setup) => setup.accept({ openers: [opener] })));
  await expect(attempt(join(mini.installRoot, "builds", `${"b".repeat(64)}-linux-x64`, "bin/junto"))).rejects.toThrow(/installed current/);
  await expect(attempt(join(mini.home, "unpacked/current/bin/junto"))).rejects.toThrow(/owned install/);
  expect(await readFile(mini.authorizedKeys, "utf8")).toBe(before);
  expect(await run(mini, Effect.flatMap(MachineRepository, (machines) => machines.peer("ghost")))).toBeUndefined();
  // The installer admits an existing root at 0755 and an owner marker at 0644;
  // the lock uses the same no-group-or-other-write rule, not stricter modes.
  await chmod(mini.installRoot, 0o755);
  await chmod(join(mini.installRoot, "owner.json"), 0o644);
  const accepted = await run(mini, mini.setup.accept({ openers: [opener] }));
  expect(accepted.pins).toHaveLength(1);
  expect(await readFile(mini.authorizedKeys, "utf8")).toContain(`'${mini.installRoot}/current/bin/junto' link --opener ghost-installation`);
});

it("dials the VPS from the mini at the address the operator gives, still pinned to the verified key", async () => {
  const { editor, mini, vps } = await fleet();
  const result = await run(editor, editor.setup.link({ from: "mini", to: "vps", sshTarget: "deploy@vps.tailnet.ts.net" as never, sshPort: 2222 }));
  expect(result.routes[0]).toEqual({ from: "mini", machine: "vps", user: "deploy", host: "vps.tailnet.ts.net", port: 2222 });
  expect(await readFile(readBoundRoute(mini.home, "vps")!.knownHostsFile, "utf8")).toBe(`[vps.tailnet.ts.net]:2222 ${vps.hostKey}\n`);
});

it("dials the VPS from the mini at a bare IPv6 address, stored canonical", async () => {
  const { editor, mini, vps } = await fleet();
  const result = await run(editor, editor.setup.link({ from: "mini", to: "vps", sshTarget: "deploy@2001:0DB8:0::1" as never, sshPort: 2222 }));
  expect(result.routes[0]).toEqual({ from: "mini", machine: "vps", user: "deploy", host: "2001:db8::1", port: 2222 });
  expect(readBoundRoute(mini.home, "vps")).toMatchObject({ user: "deploy", host: "2001:db8::1", port: 2222 });
  expect(await readFile(readBoundRoute(mini.home, "vps")!.knownHostsFile, "utf8")).toBe(`[2001:db8::1]:2222 ${vps.hostKey}\n`);
});

it("refuses an IPv6 address in brackets when the operator gives the route to dial", async () => {
  const { editor } = await fleet();
  await expect(run(editor, editor.setup.link({ from: "mini", to: "vps", sshTarget: "deploy@[2001:db8::1]" as never, sshPort: 2222 })))
    .rejects.toThrow(/Leave the brackets out/);
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

it("clears a removed machine's trust in the editor's link key: its line of that key, and its pin of the editor by installation id, nothing else", async () => {
  const { editor, mini, vps } = await fleet();
  await run(editor, editor.setup.link({ from: "mini", to: "vps" }));
  expect(await pinOf(vps, "book")).toMatchObject({ installationId: editor.installationId, binding: "key" });
  const before = await readFile(vps.authorizedKeys, "utf8");

  await expect(run(editor, editor.setup.clearRemoved(editor.hosts.get("vps")!, vps.installationId))).resolves.toBe("clear");
  const after = await readFile(vps.authorizedKeys, "utf8");
  expect(after).not.toContain(`junto-link:${linkHomeTag(vps.home)}:${editor.installationId}`);
  // The mini's line, its pin and the operator's own key are untouched.
  expect(after).toBe(before.split("\n").filter((line) => !line.endsWith(`:${editor.installationId}`)).join("\n"));
  expect(await pinOf(vps, "book")).toBeUndefined();
  expect(await pinOf(vps, "mini")).toMatchObject({ installationId: mini.installationId, binding: "key" });
  expect((await pinRows(vps)).map((pin) => pin.machineName)).toEqual(["mini"]);
  // The clear ran over the operator's route, strict against the host key the bound route pinned.
  const last = editor.sessions.at(-1)!;
  expect(last.at(-2)).toBe("vps-alias");
  expect(last.at(-1)).toContain("'machine' 'link-revoke' '-'");
  expect(last).toContain(`UserKnownHostsFile=${join(editor.home, ".junto/core/link-keys/unlinked/vps.known_hosts")}`);
});

it("refuses an unpin that names no key, and a key that is not the line's changes nothing", async () => {
  const { editor, vps } = await fleet();
  await run(editor, editor.setup.link({ from: "mini", to: "vps" }));
  const before = await readFile(vps.authorizedKeys, "utf8");
  await expect(run(vps, vps.setup.revoke({ installationId: editor.installationId, unpin: true }))).rejects.toThrow(/names the link key/);
  await expect(run(vps, vps.setup.revoke({ installationId: editor.installationId, unpin: true, linkKeySha256: "0".repeat(64) })))
    .resolves.toEqual({ installationId: editor.installationId, removed: false, unpinned: false, holder: vps.installationId });
  expect(await readFile(vps.authorizedKeys, "utf8")).toBe(before);
  expect(await pinOf(vps, "book")).toMatchObject({ binding: "key" });
  // A link key runs only `junto link --opener <its own installation>`: no line Junto writes reaches an owner command.
  for (const line of before.split("\n").filter((row) => row.includes("junto-link:"))) {
    expect(line).toMatch(/^command="\/usr\/bin\/env JUNTO_HOME='[^']+' '[^']+\/current\/bin\/junto' link --opener ([A-Za-z0-9._:-]+)",restrict ssh-ed25519 \S+ junto-link:[0-9a-f]{12}:\1$/u);
    expect(line).not.toContain(" machine ");
  }
});

it("keeps the clear of a machine it cannot reach, without the link key, and a retry after a new link leaves the new link whole", async () => {
  const { editor, mini, vps, reach } = await fleet();
  await run(editor, editor.setup.link({ from: "mini", to: "vps" }));
  const oldKey = ownLinkKeySha256(editor.home, "vps")!;
  const linkPublic = (await readFile(join(editor.home, ".junto/core/link-keys/vps/id_ed25519.pub"), "utf8")).trim().split(/\s+/u)[1]!;
  // The VPS is off the network when the operator removes it.
  editor.hosts.set("vps", { ...editor.hosts.get("vps")!, sshEndpoint: "later-alias" as never });
  await expect(run(editor, editor.setup.clearRemoved(editor.hosts.get("vps")!, vps.installationId))).resolves.toBe("kept");
  await removeHere(editor, vps);
  const kept = await readFile(join(editor.home, ".junto/core/link-keys/unlinked.json"), "utf8");
  expect(JSON.parse(kept)).toEqual([expect.objectContaining({ machineName: "vps", installationId: editor.installationId, linkKeySha256: oldKey })]);
  // Only the route and the host keys it had pinned: never the link key, its file or its path.
  expect(kept).not.toContain(linkPublic);
  expect(kept).not.toMatch(/PRIVATE KEY|id_ed25519/u);
  expect(kept).toContain(`${vps.address} ${vps.hostKey}`);
  expect(await readdir(join(editor.home, ".junto/core/link-keys"))).not.toContain("vps");

  // Added again and linked again: a new key, a new line, the same pin, kept key-bound.
  await addAgain(editor, vps);
  editor.hosts.set("vps", { ...editor.hosts.get("vps")!, sshEndpoint: "vps-alias" as never });
  await run(editor, editor.setup.link({ from: "mini", to: "vps" }));
  const newKey = ownLinkKeySha256(editor.home, "vps")!;
  expect(newKey).not.toBe(oldKey);
  const relinked = await readFile(vps.authorizedKeys, "utf8");

  // The kept route answers at last: the retry names the old key's line, which is gone, so nothing changes.
  reach("later-alias", vps);
  await expect(run(editor, editor.setup.settleRemoved())).resolves.toEqual([]);
  expect(await readFile(vps.authorizedKeys, "utf8")).toBe(relinked);
  expect(await pinOf(vps, "book")).toMatchObject({ installationId: editor.installationId, binding: "key" });
  expect(readBoundRoute(editor.home, "vps")).toBeDefined();
  expect(await pinOf(vps, "mini")).toMatchObject({ installationId: mini.installationId });
  await expect(readFile(join(editor.home, ".junto/core/link-keys/unlinked.json"), "utf8")).rejects.toThrow(/ENOENT/);
});

it("settles a kept clear over the route a send just reached, before setup pins the editor again", async () => {
  const { editor, vps } = await fleet();
  await run(editor, editor.setup.link({ from: "mini", to: "vps" }));
  editor.hosts.set("vps", { ...editor.hosts.get("vps")!, sshEndpoint: "later-alias" as never });
  await expect(run(editor, editor.setup.clearRemoved(editor.hosts.get("vps")!, vps.installationId))).resolves.toBe("kept");
  await removeHere(editor, vps);
  expect(await pinOf(vps, "book")).toMatchObject({ binding: "key" });

  await addAgain(editor, vps);
  await expect(run(editor, editor.setup.settleRemoved({ machineName: "vps", route: editor.hosts.get("vps")!, installationId: vps.installationId }))).resolves.toEqual([]);
  // The old line and the key-bound pin are gone, so setup pins the editor plainly and a send ends ready.
  expect(await readFile(vps.authorizedKeys, "utf8")).not.toContain(`:${editor.installationId}`);
  expect(await pinOf(vps, "book")).toBeUndefined();
  expect(editor.sessions.at(-1)!.at(-2)).toBe("vps-alias");
  expect(editor.setup.holdsLinkKey("vps")).toBe(false);
});

it("keeps a clear pending when the address now answers as another installation, by a retry or by a send", async () => {
  const { editor, mini, vps, reach } = await fleet();
  await run(editor, editor.setup.link({ from: "mini", to: "vps" }));
  editor.hosts.set("vps", { ...editor.hosts.get("vps")!, sshEndpoint: "later-alias" as never });
  await expect(run(editor, editor.setup.clearRemoved(editor.hosts.get("vps")!, vps.installationId))).resolves.toBe("kept");
  await removeHere(editor, vps);
  const pending = join(editor.home, ".junto/core/link-keys/unlinked.json");
  expect(JSON.parse(await readFile(pending, "utf8"))).toEqual([expect.objectContaining({ machineName: "vps", holder: vps.installationId })]);

  // The address comes back as a rebuilt machine, another installation: it answers removed:false as itself, and the row stays.
  reach("later-alias", mini);
  await expect(run(editor, editor.setup.settleRemoved())).resolves.toEqual(["vps"]);
  expect(editor.sessions.at(-1)!.at(-2)).toBe("later-alias");
  // The name is added again for that installation and sent: the send's settle does not dial, and the row stays.
  const sessions = editor.sessions.length;
  await expect(run(editor, editor.setup.settleRemoved({ machineName: "vps", route: { ...editor.hosts.get("mini")!, id: "vps" as never }, installationId: mini.installationId })))
    .resolves.toEqual(["vps"]);
  expect(editor.sessions.length).toBe(sessions);
  expect(JSON.parse(await readFile(pending, "utf8"))).toEqual([expect.objectContaining({ machineName: "vps", holder: vps.installationId })]);
  // The old installation still trusts the key until a retry reaches it.
  expect(await readFile(vps.authorizedKeys, "utf8")).toContain(`:${editor.installationId}`);
});

it("keeps a clear for a machine with a link key and no route to dial", async () => {
  const { editor, vps } = await fleet();
  await run(editor, editor.setup.link({ from: "mini", to: "vps" }));
  const { sshEndpoint: _endpoint, juntoHome: _home, ...routeless } = editor.hosts.get("vps")!;
  await expect(run(editor, editor.setup.clearRemoved(routeless as RemoteHost, vps.installationId))).resolves.toBe("kept");
  expect(JSON.parse(await readFile(join(editor.home, ".junto/core/link-keys/unlinked.json"), "utf8")))
    .toEqual([expect.objectContaining({ machineName: "vps", holder: vps.installationId })]);
});

it("moves an unreadable list of pending clears aside, never over it, and says where", async () => {
  const { editor, vps } = await fleet();
  await run(editor, editor.setup.link({ from: "mini", to: "vps" }));
  const dir = join(editor.home, ".junto/core/link-keys");
  await writeFile(join(dir, "unlinked.json"), "[{\"machineName\":\"ghost\"");
  await expect(run(editor, editor.setup.settleRemoved())).resolves.toEqual([]);
  const aside = (await readdir(dir)).filter((name) => name.startsWith("unlinked.json.bad-"));
  expect(aside).toHaveLength(1);
  expect(await readFile(join(dir, aside[0]!), "utf8")).toBe("[{\"machineName\":\"ghost\"");
  expect(editor.setup.takeSetAside()).toEqual([join(dir, aside[0]!)]);
  expect(editor.setup.takeSetAside()).toEqual([]);
  // A row Junto did not write sets the whole file aside too.
  editor.hosts.set("vps", { ...editor.hosts.get("vps")!, sshEndpoint: "later-alias" as never });
  await writeFile(join(dir, "unlinked.json"), JSON.stringify([{ machineName: "ghost" }]));
  await expect(run(editor, editor.setup.clearRemoved(editor.hosts.get("vps")!, vps.installationId))).resolves.toBe("kept");
  expect(editor.setup.takeSetAside()).toHaveLength(1);
  expect(JSON.parse(await readFile(join(dir, "unlinked.json"), "utf8"))).toEqual([expect.objectContaining({ machineName: "vps" })]);
});
