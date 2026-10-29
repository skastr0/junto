/**
 * A secret form's value goes where its region declares it (docs/machines.md,
 * The vault): read from the stored form, never the caller, into the vault on
 * `op`'s stdin with the window machine's write token, or into this machine's
 * own store. The signal records names only.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const flags = vi.hoisted(() => ({ vault: true }));
vi.mock("@shared/features", async (original) => ({
  ...(await original<typeof import("../src/shared/features")>()),
  get VAULT_ENABLED() { return flags.vault; },
}));

import { makeMachineRepositoryLive } from "../src/main/junto/machines/repository";
import type { ToolCall, ToolResult } from "../src/main/junto/region-env/tool";
import { AgentSignalRepository, AgentSignalRepositoryLive } from "../src/main/junto/signals/repository";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { makeVaultTokens } from "../src/main/junto/vault/repository";
import { putSignalSecret } from "../src/main/junto/vault/secret-put";
import { writeVaultToken } from "../src/main/junto/vault/token-file";
import { WorkService } from "../src/main/junto/work/service";
import type { EnvSource, RegionEnvironment } from "../src/shared/model/region";
import { canvasOf, region, seat } from "./support/model-nodes";

const TOKEN = "ops_test-only-window-write-token-0123456789abcdef";
const VALUE = "sk-test-only-the-operators-value-9f8e7d";
const OTHER = "test-only-another-field-kept-as-it-was";

let home: string;
let calls: Array<ToolCall>;
let tool: (call: ToolCall) => ToolResult;
let saved: Array<{ value: string; secretId?: string }>;
let environment: RegionEnvironment;

beforeEach(async () => {
  flags.vault = true;
  home = await mkdtemp(join(tmpdir(), "junto-secret-put-"));
  calls = [];
  saved = [];
  tool = () => ({ kind: "ok", stdout: "[]" });
  environment = { vault: { backend: "onepassword", vault: "Junto" }, sources: [{ id: "s1", kind: "onepassword", name: "OPENAI_API_KEY", ref: "op://Junto/OpenAI/credential" }] };
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

const setup = async (options: { readonly permissions?: "read_items" | "read_items,write_items"; readonly machine?: string } = {}) => {
  const board = () => canvasOf([
    seat("agent-a", { x: 0, y: 0, width: 100, height: 40 }),
    region("forge", { x: -20, y: -20, width: 620, height: 120 }, { label: "Forge", environment }),
  ]);
  const work = {
    workSystemMailboxNotify: () => Effect.succeed({ ok: true as const, data: { messageId: "m-answer" } }),
    readTopology: () => Effect.succeed({ canvas: board(), actorRefs: [] }),
  };
  const runtime = ManagedRuntime.make(Layer.mergeAll(
    Layer.provideMerge(Layer.merge(makeMachineRepositoryLive({ defaultName: () => "macbook" }), AgentSignalRepositoryLive), makeStateEngineLive(join(home, "junto.db"))),
    Layer.succeed(WorkService, work as never),
  ));
  await runtime.runPromise(Effect.flatMap(makeVaultTokens, (tokens) =>
    tokens.put({ machineName: "macbook", vault: "Junto", permissions: options.permissions ?? "read_items,write_items", origin: "minted", accountName: "junto-macbook-write", setAtEpochMs: 1 })));
  await writeVaultToken(home, TOKEN);
  const raised = await runtime.runPromise(Effect.flatMap(AgentSignalRepository, (signals) => signals.raise({
    canvasName: "factory", nodeId: "agent-a", kind: "blocked", text: "I need the OpenAI key.",
    form: { kind: "secret", name: "OPENAI_API_KEY", regionId: "forge", machine: options.machine ?? "macbook" },
  })));
  const put = (value = VALUE) => runtime.runPromise(putSignalSecret({ signalId: raised.signalId, value }, {
    home, userHome: "/Users/operator", path: async () => "/usr/bin", now: () => 42,
    run: async (call) => { calls.push(call); return tool(call); },
    store: { save: (input) => { saved.push(input); return { ok: true, secretId: input.secretId ?? "new" }; } },
  }));
  const signal = () => runtime.runPromise(Effect.flatMap(AgentSignalRepository, (signals) => signals.get(raised.signalId)));
  return { runtime, put, signal };
};

const opArgs = () => calls.map((call) => call.args);

describe("a secret form's value into the region's vault", () => {
  it("creates a missing item from a template on stdin, never argv or the environment, and answers with names only", async () => {
    const { runtime, put, signal } = await setup();
    const result = await put();
    expect(result).toMatchObject({ ok: true, item: "OpenAI" });
    expect(opArgs()).toEqual([
      ["item", "list", "--vault", "Junto", "--format", "json"],
      ["item", "create", "--vault", "Junto", "-"],
    ]);
    for (const call of calls) {
      expect(call.env).toEqual({ OP_SERVICE_ACCOUNT_TOKEN: TOKEN, PATH: "/usr/bin", HOME: "/Users/operator" });
      expect(call.args.join(" ")).not.toContain(VALUE);
    }
    expect(JSON.parse(calls[1]!.stdin!)).toEqual({
      title: "OpenAI", category: "PASSWORD",
      fields: [{ id: "credential", label: "credential", type: "CONCEALED", value: VALUE }],
    });
    const answered = await signal();
    expect(answered.state).toBe("answered");
    expect(answered.response?.secret).toEqual({ item: "OpenAI", name: "OPENAI_API_KEY", regionId: "forge", machine: "macbook", setAt: 42 });
    expect(JSON.stringify([answered, result])).not.toContain(VALUE);
    await runtime.dispose();
  });

  it("sets one field of an existing item and keeps the rest, the edit piped on stdin", async () => {
    const item = { id: "abc123", title: "OpenAI", category: "PASSWORD", fields: [
      { id: "credential", label: "credential", type: "CONCEALED", value: "old" },
      { id: "org", label: "org", type: "STRING", value: OTHER },
    ] };
    tool = (call) => call.args[1] === "list" ? { kind: "ok", stdout: JSON.stringify([{ id: "abc123", title: "OpenAI" }]) }
      : call.args[1] === "get" ? { kind: "ok", stdout: JSON.stringify(item) } : { kind: "ok", stdout: "{}" };
    const { runtime, put } = await setup();
    expect(await put()).toMatchObject({ ok: true, item: "OpenAI" });
    expect(opArgs()).toEqual([
      ["item", "list", "--vault", "Junto", "--format", "json"],
      ["item", "get", "abc123", "--vault", "Junto", "--format", "json"],
      ["item", "edit", "abc123", "--vault", "Junto"],
    ]);
    const edited = JSON.parse(calls[2]!.stdin!) as typeof item;
    expect(edited.fields).toEqual([{ ...item.fields[0], value: VALUE }, item.fields[1]]);
    expect(calls[2]!.args.join(" ")).not.toContain(VALUE);
    await runtime.dispose();
  });

  it("refuses in its closed reasons, and runs nothing it does not need", async () => {
    const read = await setup({ permissions: "read_items" });
    expect(await read.put()).toMatchObject({ ok: false, reason: "no-vault-token" });
    expect(calls).toEqual([]);
    await read.runtime.dispose();

    environment = { sources: [{ id: "s1", kind: "onepassword", name: "OPENAI_API_KEY", ref: "op://Personal/OpenAI/credential" }] };
    const outside = await setup();
    expect(await outside.put()).toMatchObject({ ok: false, reason: "not-in-vault" });
    await outside.runtime.dispose();

    environment = { vault: { backend: "onepassword", vault: "Junto" }, sources: [{ id: "s1", kind: "onepassword", name: "OPENAI_API_KEY", ref: "op://Junto/OpenAI/section/credential" }] };
    const section = await setup();
    expect(await section.put()).toMatchObject({ ok: false, reason: "not-in-vault" });
    await section.runtime.dispose();

    environment = { vault: { backend: "onepassword", vault: "Junto" }, sources: [] };
    const gone = await setup();
    expect(await gone.put()).toMatchObject({ ok: false, reason: "not-declared" });
    await gone.runtime.dispose();
    expect(calls).toEqual([]);
  });

  it("classifies op's refusals in fixed words, never repeating what it printed", async () => {
    for (const [stderr, reason] of [
      [`[ERROR] 429 Too Many Requests ${VALUE}`, "rate-limited"],
      ["[ERROR] (401) Unauthorized: invalid service account token", "token-refused"],
      ["[ERROR] something else", "store-failed"],
    ] as const) {
      tool = (call) => call.args[1] === "list" ? { kind: "ok", stdout: "[]" } : { kind: "exit", code: 1, stdout: "", stderr };
      const { runtime, put, signal } = await setup();
      const result = await put();
      expect(result).toMatchObject({ ok: false, reason });
      expect(JSON.stringify(result)).not.toContain("ERROR");
      expect((await signal()).state).toBe("open");
      await runtime.dispose();
    }
    tool = () => ({ kind: "not-installed" });
    const missing = await setup();
    expect(await missing.put()).toMatchObject({ ok: false, reason: "op-missing" });
    await missing.runtime.dispose();
  });
});

describe("a secret form's value into the local store", () => {
  const local = (host?: string): ReadonlyArray<EnvSource> => [{ id: "s2", kind: "secret", name: "OPENAI_API_KEY", secretId: "sec-1", ...(host === undefined ? {} : { host }) }];

  it("saves under the declared id on the window's own machine, and runs no op", async () => {
    environment = { sources: local() };
    const { runtime, put, signal } = await setup();
    expect(await put()).toMatchObject({ ok: true, item: "sec-1" });
    expect(saved).toEqual([{ value: VALUE, secretId: "sec-1" }]);
    expect(calls).toEqual([]);
    expect((await signal()).response?.secret).toMatchObject({ item: "sec-1", machine: "macbook" });
    await runtime.dispose();
  });

  it("refuses another machine's store: its value lives there", async () => {
    environment = { sources: local() };
    const { runtime, put, signal } = await setup({ machine: "mini" });
    expect(await put()).toMatchObject({ ok: false, reason: "other-machine-store" });
    expect(saved).toEqual([]);
    expect((await signal()).state).toBe("open");
    await runtime.dispose();
  });
});

it("refuses a closed signal, an empty value, and everything with VAULT_ENABLED off", async () => {
  environment = { sources: [{ id: "s2", kind: "secret", name: "OPENAI_API_KEY", secretId: "sec-1" }] };
  const { runtime, put } = await setup();
  expect(await put("")).toMatchObject({ ok: false, reason: "store-failed" });
  flags.vault = false;
  expect(await put()).toMatchObject({ ok: false, reason: "off" });
  flags.vault = true;
  expect(await put()).toMatchObject({ ok: true });
  expect(await put()).toMatchObject({ ok: false, reason: "not-open" });
  expect(saved).toHaveLength(1);
  await runtime.dispose();
});
