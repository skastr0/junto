/**
 * Placing a pasted vault token (docs/machines.md, The vault): the window's
 * machine keeps the write token, another machine gets a read token over its
 * SSH stdin and records it through its own core, each end keeps a
 * names-only record, and `op vault get` checks liveness in a closed
 * environment. With VAULT_ENABLED off nothing is written, run or dialed.
 */
import { lstat, mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as Command from "effect/unstable/process/ChildProcess";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const flags = vi.hoisted(() => ({ vault: true }));
vi.mock("@shared/features", async (original) => ({
  ...(await original<typeof import("../src/shared/features")>()),
  get VAULT_ENABLED() { return flags.vault; },
}));

import { HostsService } from "../src/main/junto/hosts/service";
import { MachineRepository, makeMachineRepositoryLive } from "../src/main/junto/machines/repository";
import type { ToolCall, ToolResult } from "../src/main/junto/region-env/tool";
import { SshExitError } from "../src/main/junto/ssh/domain";
import { createSshProgramCompiler } from "../src/main/junto/ssh/program";
import { SshTransport, type SshTransportShape } from "../src/main/junto/ssh/service";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { makeVaultTokens } from "../src/main/junto/vault/repository";
import { makeVaultSetup, mintArgv } from "../src/main/junto/vault/setup";
import { readVaultToken, vaultDir } from "../src/main/junto/vault/token-file";
import { InstallationId } from "../src/shared/installation-id";
import { RemoteHost } from "../src/shared/remote-hosts";

const TOKEN = "ops_test-only-pasted-vault-token-0123456789abcdef";
const MINTED = "ops_test-only-minted-vault-token-0123456789abcdef";
/** The app's environment: the operator's session lives here, and so may stray credentials. */
const ambient = {
  PATH: "/usr/bin", HOME: "/Users/operator", USER: "operator",
  OP_SERVICE_ACCOUNT_TOKEN: "ops_stray-ambient-service-account-token-000000", OP_CONNECT_HOST: "https://connect.example.invalid", OP_CONNECT_TOKEN: "fake-connect",
};
const compiler = createSshProgramCompiler({ controlDir: "/tmp/junto-vault-setup-test", envExecutable: "/usr/bin/env", sshExecutable: "/usr/bin/ssh", environment: {} });
const mini = Schema.decodeUnknownSync(RemoteHost)({
  id: "mini", label: "mini", isThisMachine: false, sshEndpoint: "ops@mini.example", capabilities: ["terminal"],
  juntoHome: "/Users/ops", installRoot: "/Users/ops/.local/junto",
});

let home: string;
let calls: ToolCall[];
let sent: Array<{ readonly args: ReadonlyArray<string>; readonly stdin: string }>;
let farAnswer: () => Effect.Effect<{ readonly stdout: string; readonly stderr: string }, SshExitError>;
const cleanups: Array<() => Promise<void>> = [];
beforeEach(async () => {
  flags.vault = true;
  home = await mkdtemp(join(tmpdir(), "junto-vault-setup-"));
  calls = [];
  sent = [];
});
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); await rm(home, { recursive: true, force: true }); });

const answer = (call: ToolCall): ToolResult => call.args[1] === "list"
  ? { kind: "ok", stdout: JSON.stringify([{ id: "a", name: "Junto" }, { id: "b", name: "Other" }]) }
  : { kind: "ok", stdout: JSON.stringify({ id: "a", name: "Junto" }) };

const setup = async (tool: (call: ToolCall) => ToolResult = answer) => {
  const ssh = SshTransport.of({
    run: ((program: never) => Effect.suspend(() => {
      const compiled = compiler.oneShot(program);
      if (!Command.isStandardCommand(compiled.command)) return Effect.die("expected StandardCommand");
      sent.push({ args: compiled.command.args, stdin: new TextDecoder().decode(compiled.input) });
      return farAnswer();
    })) as unknown as SshTransportShape["run"],
    transfer: () => Effect.die("no transfers in this test"),
    forward: () => Effect.die("no forwards in this test"),
    connect: () => Effect.die("no streams in this test"),
    warm: () => Effect.void,
    teardown: () => Effect.void,
  });
  const hosts = { get: (name: string) => Effect.succeed(name === "mini" ? mini : undefined) } as unknown as HostsService["Service"];
  const runtime = ManagedRuntime.make(Layer.mergeAll(
    Layer.provideMerge(makeMachineRepositoryLive({ defaultName: () => "macbook" }), makeStateEngineLive(join(home, "junto.db"))),
    Layer.succeed(SshTransport, ssh),
    Layer.succeed(HostsService, hosts),
  ));
  cleanups.push(() => runtime.dispose());
  await runtime.runPromise(Effect.flatMap(MachineRepository, (machines) =>
    machines.pinPeer({ machineName: "mini", installationId: Schema.decodeUnknownSync(InstallationId)("mini-installation") })));
  const vault = await runtime.runPromise(makeVaultSetup({
    home, userHome: home, toolEnv: async () => ambient,
    run: async (call) => { calls.push(call); return tool(call); }, now: () => 5 * 86_400_000,
  }));
  const records = () => runtime.runPromise(Effect.flatMap(makeVaultTokens, (tokens) => tokens.list));
  return { runtime, vault, records };
};

it("keeps the window's own token as the write token, and checks it in op's closed environment", async () => {
  const { runtime, vault, records } = await setup();
  const placed = await runtime.runPromise(vault.place({ name: "macbook", vault: "Junto", token: TOKEN }));
  expect(placed).toEqual({
    machineName: "macbook", liveness: "ready", seesOtherVaults: true,
    token: { vault: "Junto", permissions: "read_items,write_items", origin: "pasted", scope: "unverified", setAtEpochMs: 5 * 86_400_000, ageDays: 0 },
  });
  expect(await readVaultToken(home)).toBe(TOKEN);
  expect((await lstat(join(vaultDir(home), "op-token"))).mode & 0o777).toBe(0o600);
  expect(calls.map((call) => call.args)).toEqual([["vault", "get", "Junto", "--format", "json"], ["vault", "list", "--format", "json"]]);
  for (const call of calls) {
    expect(call.command).toBe("op");
    expect(call.env).toEqual({ OP_SERVICE_ACCOUNT_TOKEN: TOKEN, PATH: "/usr/bin", HOME: home });
  }
  expect(await records()).toEqual([{ machineName: "macbook", vault: "Junto", permissions: "read_items,write_items", origin: "pasted", setAtEpochMs: 5 * 86_400_000 }]);
  expect(sent).toEqual([]);
  expect(JSON.stringify(placed)).not.toContain(TOKEN);
});

it("sends another machine a read token on its SSH stdin, never argv, and keeps that machine's record here", async () => {
  const { runtime, vault, records } = await setup();
  const far = { machineName: "mini", liveness: "ready", token: { vault: "Junto", permissions: "read_items", origin: "pasted", scope: "unverified", setAtEpochMs: 7, ageDays: 0 } };
  farAnswer = () => Effect.succeed({ stdout: `${JSON.stringify({ ok: true, command: "machine vault-token-local", data: far })}\n`, stderr: "" });
  const placed = await runtime.runPromise(vault.place({ name: "mini", vault: "Junto", token: TOKEN }));
  expect(placed).toEqual(far);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.args.join(" ")).not.toContain(TOKEN);
  const remote = sent[0]!.args.join(" ");
  for (const part of ["JUNTO_HOME=/Users/ops", "/Users/ops/.local/junto/current/bin/junto", "machine", "vault-token-local"]) expect(remote).toContain(part);
  expect(JSON.parse(sent[0]!.stdin)).toEqual({ vault: "Junto", permissions: "read_items", token: TOKEN });
  // Nothing is written or run here for another machine's token.
  expect(await readVaultToken(home)).toBeUndefined();
  expect(calls).toEqual([]);
  expect(await records()).toEqual([{ machineName: "mini", vault: "Junto", permissions: "read_items", origin: "pasted", setAtEpochMs: 7 }]);
});

it("names the far machine's own refusal, and never repeats the token from what it said", async () => {
  const { runtime, vault, records } = await setup();
  farAnswer = () => Effect.fail(new SshExitError({ endpoint: "ops@mini.example", operation: "run", code: 1,
    stderrTail: `noise ${TOKEN}\n${JSON.stringify({ ok: false, command: "machine vault-token-local", error: { type: "io", message: "The vault is not in this build" } })}\n` }));
  const refused = await runtime.runPromise(Effect.flip(vault.place({ name: "mini", vault: "Junto", token: TOKEN })));
  expect(refused).toMatchObject({ code: "conflict", message: "mini: The vault is not in this build" });
  farAnswer = () => Effect.fail(new SshExitError({ endpoint: "ops@mini.example", operation: "run", code: 255, stderrTail: `ssh: ${TOKEN}` }));
  const unreachable = await runtime.runPromise(Effect.flip(vault.place({ name: "mini", vault: "Junto", token: TOKEN })));
  expect(String((unreachable as Error).message)).toBe("The vault token could not be placed on mini");
  expect(JSON.stringify([refused, unreachable])).not.toContain(TOKEN);
  expect(await records()).toEqual([]);
});

it("refuses a machine it has not set up, and a far record with no token placed", async () => {
  const { runtime, vault } = await setup();
  await expect(runtime.runPromise(vault.place({ name: "vps", vault: "Junto", token: TOKEN }))).rejects.toThrow("Set up vps from this machine");
  await expect(runtime.runPromise(vault.record({ vault: "Junto", permissions: "read_items", origin: "pasted" }))).rejects.toThrow("No vault token is placed on this machine");
});

it("classifies liveness from op's stderr without returning it", async () => {
  const said = (stderr: string) => (): ToolResult => ({ kind: "exit", code: 1, stdout: "", stderr });
  for (const [stderr, liveness] of [
    [`[ERROR] "Junto" isn't a vault in this account`, "vault-missing"],
    [`[ERROR] invalid service account token ${TOKEN}`, "token-refused"],
    ["[ERROR] connection reset", "unreachable"],
  ] as const) {
    const { runtime, vault } = await setup(said(stderr));
    const placed = await runtime.runPromise(vault.place({ name: "macbook", vault: "Junto", token: TOKEN }));
    expect(placed.liveness).toBe(liveness);
    expect(JSON.stringify(placed)).not.toContain("ERROR");
  }
  const { runtime, vault } = await setup(() => ({ kind: "not-installed" }));
  expect((await runtime.runPromise(vault.place({ name: "macbook", vault: "Junto", token: TOKEN }))).liveness).toBe("op-missing");
});

it("with VAULT_ENABLED off, places, records and lists nothing, and runs and dials nothing", async () => {
  const { runtime, vault, records } = await setup();
  flags.vault = false;
  await expect(runtime.runPromise(vault.place({ name: "macbook", vault: "Junto", token: TOKEN }))).rejects.toThrow("The vault is not in this build");
  await expect(runtime.runPromise(vault.place({ name: "mini", vault: "Junto", token: TOKEN }))).rejects.toThrow("The vault is not in this build");
  await expect(runtime.runPromise(vault.record({ vault: "Junto", permissions: "read_items", origin: "pasted" }))).rejects.toThrow("The vault is not in this build");
  expect((await runtime.runPromise(vault.views)).size).toBe(0);
  await expect(readFile(join(vaultDir(home), "op-token"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(calls).toEqual([]);
  expect(sent).toEqual([]);
  expect(await records()).toEqual([]);
});

describe("--mint: Junto makes the token itself, so its scope is verified", () => {
  const minting = (call: ToolCall): ToolResult => call.args[0] === "service-account" ? { kind: "ok", stdout: `${MINTED}\n` } : answer(call);

  it("runs the one fixed create under the operator's own session, never a service account or Connect, never --can-create-vaults", async () => {
    const { runtime, vault, records } = await setup(minting);
    const placed = await runtime.runPromise(vault.place({ name: "macbook", vault: "Junto", mint: true }));
    const create = calls[0]!;
    expect(create.command).toBe("op");
    expect(create.args).toEqual(["service-account", "create", "junto-macbook-write", "--vault", "Junto:read_items,write_items", "--raw"]);
    expect(create.args).not.toContain("--can-create-vaults");
    expect(create.env).toEqual({ PATH: "/usr/bin", HOME: "/Users/operator", USER: "operator" });
    // The minted token, not the stray ambient one, is what the liveness check then uses.
    expect(calls[1]!.env).toEqual({ OP_SERVICE_ACCOUNT_TOKEN: MINTED, PATH: "/usr/bin", HOME: home });
    expect(await readVaultToken(home)).toBe(MINTED);
    expect(placed.token).toMatchObject({ origin: "minted", scope: "verified", accountName: "junto-macbook-write", permissions: "read_items,write_items" });
    expect(await records()).toEqual([{ machineName: "macbook", vault: "Junto", permissions: "read_items,write_items", origin: "minted", accountName: "junto-macbook-write", setAtEpochMs: 5 * 86_400_000 }]);
    expect(JSON.stringify(placed)).not.toContain(MINTED);
  });

  it("mints another machine a read token and sends it with its account name on SSH stdin", async () => {
    const { runtime, vault, records } = await setup(minting);
    const far = { machineName: "mini", liveness: "ready", token: { vault: "Junto", permissions: "read_items", origin: "minted", scope: "verified", accountName: "junto-mini-read", setAtEpochMs: 7, ageDays: 0 } };
    farAnswer = () => Effect.succeed({ stdout: JSON.stringify({ ok: true, command: "machine vault-token-local", data: far }), stderr: "" });
    expect(await runtime.runPromise(vault.place({ name: "mini", vault: "Junto", mint: true }))).toEqual(far);
    expect(calls.map((call) => call.args)).toEqual([["service-account", "create", "junto-mini-read", "--vault", "Junto:read_items", "--raw"]]);
    expect(JSON.parse(sent[0]!.stdin)).toEqual({ vault: "Junto", permissions: "read_items", token: MINTED, accountName: "junto-mini-read" });
    expect(sent[0]!.args.join(" ")).not.toContain(MINTED);
    expect(await records()).toEqual([{ machineName: "mini", vault: "Junto", permissions: "read_items", origin: "minted", accountName: "junto-mini-read", setAtEpochMs: 7 }]);
  });

  it("mints nothing for a machine that is not ready, and names the unused account when placing fails after the mint", async () => {
    const { runtime, vault } = await setup(minting);
    await expect(runtime.runPromise(vault.place({ name: "vps", vault: "Junto", mint: true }))).rejects.toThrow("Set up vps from this machine");
    expect(calls).toEqual([]);
    farAnswer = () => Effect.fail(new SshExitError({ endpoint: "ops@mini.example", operation: "run", code: 255, stderrTail: `ssh: lost ${MINTED}` }));
    const failed = await runtime.runPromise(Effect.flip(vault.place({ name: "mini", vault: "Junto", mint: true })));
    expect(String((failed as Error).message)).toBe("The vault token could not be placed on mini; the service account junto-mini-read was made in 1Password and is unused, so delete it there");
    expect(JSON.stringify(failed)).not.toContain(MINTED);
  });

  it("classifies a refused mint from stderr in fixed words, and never repeats what op printed", async () => {
    for (const [stderr, words] of [
      ["[ERROR] You are not currently signed in", "Sign in to 1Password on this machine, then mint again"],
      [`[ERROR] "Junto" isn't a vault in this account`, "1Password has no vault named Junto"],
      ["[ERROR] permission denied: only owners and administrators may create service accounts", "This 1Password account may not create service accounts"],
      ["[ERROR] something else entirely", "1Password refused to mint the vault token"],
    ] as const) {
      const { runtime, vault } = await setup((call) => call.args[0] === "service-account" ? { kind: "exit", code: 1, stdout: "", stderr } : answer(call));
      const refused = await runtime.runPromise(Effect.flip(vault.place({ name: "macbook", vault: "Junto", mint: true })));
      expect(String((refused as Error).message)).toBe(words);
      expect(await readVaultToken(home)).toBeUndefined();
    }
  });

  it("builds no create argv for a vault name that would widen --vault", () => {
    expect(mintArgv("junto-mini-read", "Junto", "read_items")).toEqual(["service-account", "create", "junto-mini-read", "--vault", "Junto:read_items", "--raw"]);
    for (const name of ["Dev:write_items", "Dev,Other", "a/b", ""]) expect(mintArgv("junto-mini-read", name, "read_items"), name).toBeUndefined();
  });
});
