import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeError } from "../src/main/junto/failure-encode";
import { HostsService } from "../src/main/junto/hosts/service";
import { makeNativeConfigAnswers, makeNativeConfigChannel } from "../src/main/junto/inventory/native-channel";
import { makeNativeConfigClient } from "../src/main/junto/inventory/native-client";
import { NativeConfigLinkFailure, NativeSettingRefused } from "../src/main/junto/inventory/native-wire";
import { LinkClosed, MachineLink } from "../src/main/junto/link/service";
import { type LinkChannelContext, LinkRequestFailed } from "../src/main/junto/link/types";
import { MachineRepository, makeMachineRepositoryLive } from "../src/main/junto/machines/repository";
import { ModelService } from "../src/main/junto/model/service";
import { makeNativeConfig, NativeConfig } from "../src/main/junto/native-config/service";
import { closeMachineLog, installMachineLog, ObservabilityLoggerLive } from "../src/main/junto/observability/logger";
import { machineLogDir } from "../src/main/junto/observability/log-file";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { HarnessInventory } from "../src/main/junto/term/templates/harness-inventory";
import { WorkRepositoryLive } from "../src/main/junto/work/repository";
import type { MachineInventory } from "../src/shared/harness-domain/inventory";
import { InstallationId } from "../src/shared/installation-id";
import { asCanvasName, type Node } from "../src/shared/model";
import { RemoteHost } from "../src/shared/remote-hosts";
import { THIS_MACHINE } from "./support/machines";
import { seat } from "./support/model-nodes";
import { ModelStoresLive, seedCanvas } from "./support/seed-canvas";
import { clearMachines, seedThisMachine } from "./support/seed-this-machine";

const installation = Schema.decodeUnknownSync(InstallationId);
const editor = installation("editor-installation");
const canvas = asCanvasName("native-canvas");
const PEER = "mini";
const here = seat("here", { host: THIS_MACHINE, agentKey: `${THIS_MACHINE}:here` });

const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => seedThisMachine());
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  clearMachines();
});

const fixture = async (options: {
  readonly nodes?: ReadonlyArray<Node>;
  readonly editor?: "editor" | "self";
  readonly claudeVersion?: string;
  readonly settings?: Record<string, unknown>;
} = {}) => {
  const root = await mkdtemp(join(tmpdir(), "junto-native-link-"));
  const home = join(root, "home");
  if (options.settings !== undefined) {
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude", "settings.json"), `${JSON.stringify(options.settings, null, 2)}\n`);
  }
  const snapshot: MachineInventory = {
    machine: THIS_MACHINE,
    harnesses: [{
      harness: "claude", machine: THIS_MACHINE, installed: true, version: options.claudeVersion ?? "2.1.302",
      models: [], efforts: [], refreshing: false,
    }],
  };
  const inventory = Layer.succeed(HarnessInventory, HarnessInventory.of({
    harnesses: () => Effect.die("unused"),
    models: () => Effect.die("unused"),
    machine: Effect.succeed(snapshot),
  }));
  const config = Layer.effect(NativeConfig, makeNativeConfig({ home }));
  const repositories = Layer.provideMerge(Layer.mergeAll(
    WorkRepositoryLive,
    makeMachineRepositoryLive({ defaultName: () => THIS_MACHINE }),
  ), makeStateEngineLive(join(root, "junto.db")));
  const runtime = ManagedRuntime.make(Layer.mergeAll(
    Layer.provideMerge(config, inventory),
    Layer.provideMerge(ModelStoresLive, repositories),
    ObservabilityLoggerLive,
  ));
  cleanups.push(async () => {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await runtime.runPromise(Effect.gen(function* () {
    const machines = yield* MachineRepository;
    yield* machines.pinPeer({ machineName: "macbook", installationId: editor });
    yield* machines.pinPeer({ machineName: PEER, installationId: installation("mini-installation") });
    if (options.editor === "self") return yield* seedCanvas(canvas, options.nodes ?? [here]);
    yield* (yield* ModelService).installCopy({ canvas, canvasId: "copied", seq: 1, editor, nodes: options.nodes ?? [here], wires: [] });
  }));
  const channel = await runtime.runPromise(makeNativeConfigChannel());
  const context: LinkChannelContext = {
    peer: { build: "same-build", installationId: editor, machineName: "macbook" },
    sessionId: "admitted-link", operationId: "op-native-1", signal: new AbortController().signal,
    sendEvent: () => Effect.void, close: () => Effect.void, request: () => Effect.die("unused"),
  };
  const answer = (raw: unknown, caller = context) =>
    runtime.runPromise(channel.handleRequest!(caller, raw).pipe(Effect.provide(ObservabilityLoggerLive)));
  const refusal = (raw: unknown, caller = context) =>
    runtime.runPromise(Effect.flip(channel.handleRequest!(caller, raw)).pipe(Effect.provide(ObservabilityLoggerLive)));
  return { root, home, runtime, channel, context, answer, refusal };
};

describe("native-config channel answer", () => {
  it("reads declared keys; a file value outside its setting crosses as unfit, never its text", async () => {
    const f = await fixture({ settings: { model: "opus[1m]", effortLevel: "turbo <x>", env: { SECRET: "nope" } } });
    const answer = await f.answer({ _tag: "ReadSettings", canvas, harness: "claude", keys: ["model", "effortLevel", "alwaysThinkingEnabled"] });
    expect(answer).toEqual({
      _tag: "Settings", machine: THIS_MACHINE, harness: "claude",
      values: [{ key: "model", value: "opus[1m]" }, { key: "effortLevel", unfit: true }],
    });
    expect(JSON.stringify(answer)).not.toContain("turbo");
    expect(JSON.stringify(answer)).not.toContain("SECRET");
  });

  it("refuses an undeclared key, and decodes requests closed", async () => {
    const f = await fixture({ settings: {} });
    expect(await f.refusal({ _tag: "ReadSettings", canvas, harness: "claude", keys: ["env"] }))
      .toMatchObject({ _tag: "NativeSettingRefused", reason: "undeclared", key: "env", operationId: "op-native-1" });
    for (const bad of [
      { _tag: "ReadSettings", canvas, harness: "claude", keys: ["model"], file: ".claude/settings.json" },
      { _tag: "ReadSettings", canvas, harness: "claude", keys: [] },
      { _tag: "ReadSettings", canvas, harness: "claude", keys: ["../x"] },
      { _tag: "WriteSetting", canvas, harness: "claude", key: "model", value: "$(id)" },
      { _tag: "WriteSetting", canvas, harness: "claude", key: "model", value: "a b" },
      { _tag: "WriteSetting", canvas, harness: "claude", key: "model", value: Number.NaN },
      { _tag: "WriteSetting", canvas, harness: "claude", key: "model", value: { nested: true } },
      { _tag: "Toggle", canvas, harness: "claude", key: "alwaysThinkingEnabled" },
    ]) expect(() => f.channel.decodeRequest(bad), JSON.stringify(bad)).toThrow();
    expect(() => f.channel.decodeEvent({})).toThrow(expect.objectContaining({ _tag: "NativeConfigEventRefused" }));
  });

  it("writes a declared key after a read, answers the value read back, and a repeat leaves the same file", async () => {
    const f = await fixture({ settings: { model: "opus", theme: "dark" } });
    await f.answer({ _tag: "ReadSettings", canvas, harness: "claude", keys: ["model"] });
    const write = { _tag: "WriteSetting", canvas, harness: "claude", key: "model", value: "sonnet[1m]" };
    expect(await f.answer(write)).toEqual({ _tag: "Written", machine: THIS_MACHINE, harness: "claude", key: "model", value: "sonnet[1m]" });
    const once = await readFile(join(f.home, ".claude", "settings.json"), "utf8");
    expect(JSON.parse(once)).toEqual({ model: "sonnet[1m]", theme: "dark" });
    await f.answer(write);
    expect(await readFile(join(f.home, ".claude", "settings.json"), "utf8")).toBe(once);
  });

  it("refuses a value or version outside the setting, and a file changed by hand, with fixed text and no path", async () => {
    const f = await fixture({ settings: { model: "opus" } });
    await f.answer({ _tag: "ReadSettings", canvas, harness: "claude", keys: ["model", "effortLevel"] });
    const value = await f.refusal({ _tag: "WriteSetting", canvas, harness: "claude", key: "effortLevel", value: "ultra" });
    expect(value).toMatchObject({ _tag: "NativeSettingRefused", reason: "value" });
    expect(JSON.stringify(value)).not.toContain("ultra");

    await writeFile(join(f.home, ".claude", "settings.json"), `{"model": "haiku"}\n`);
    const conflict = await f.refusal({ _tag: "WriteSetting", canvas, harness: "claude", key: "model", value: "sonnet" });
    expect(conflict).toMatchObject({ _tag: "NativeConfigWriteFailed", reason: "conflict", key: "model" });
    expect(JSON.stringify(conflict)).not.toContain(f.home);
    expect(JSON.stringify(conflict)).not.toContain("settings.json");
    for (const failure of [value, conflict]) {
      expect(Schema.decodeUnknownSync(NativeConfigLinkFailure)(Schema.encodeSync(NativeConfigLinkFailure)(failure as never))).toBeTruthy();
    }

    const old = await fixture({ settings: { model: "opus" }, claudeVersion: "2.0.0" });
    await old.answer({ _tag: "ReadSettings", canvas, harness: "claude", keys: ["model"] });
    expect(await old.refusal({ _tag: "WriteSetting", canvas, harness: "claude", key: "model", value: "sonnet" }))
      .toMatchObject({ _tag: "NativeSettingRefused", reason: "version" });
  });

  it("admits only the pinned editor of a canvas with a seat here", async () => {
    const read = { _tag: "ReadSettings", canvas, harness: "claude", keys: ["model"] };
    const stranger = await fixture({ settings: {} });
    expect(await stranger.refusal(read, { ...stranger.context, peer: { ...stranger.context.peer, installationId: installation("stranger") } }))
      .toMatchObject({ _tag: "InventoryPeerNotPinned" });
    expect(await (await fixture({ settings: {}, editor: "self" })).refusal(read)).toMatchObject({ _tag: "InventoryCanvasEditorMismatch" });
    expect(await (await fixture({ settings: {}, nodes: [seat("away", { host: "macbook", agentKey: "macbook:away" })] })).refusal(read))
      .toMatchObject({ _tag: "InventoryNoSeatHere" });
  });

  it("never logs a value it reads or writes", async () => {
    const logHome = await mkdtemp(join(tmpdir(), "junto-native-log-"));
    cleanups.push(async () => { closeMachineLog(); await rm(logHome, { recursive: true, force: true }); });
    installMachineLog({ home: logHome, process: "core", echo: false });
    const f = await fixture({ settings: { model: "secretmodel-a1" } });
    await f.answer({ _tag: "ReadSettings", canvas, harness: "claude", keys: ["model"] });
    await f.answer({ _tag: "WriteSetting", canvas, harness: "claude", key: "model", value: "secretmodel-b2" });
    await f.refusal({ _tag: "WriteSetting", canvas, harness: "claude", key: "effortLevel", value: "secretmodel-c3" });
    const log = readFileSync(join(machineLogDir(logHome), "core.jsonl"), "utf8");
    expect(log).toContain("native setting written");
    expect(log).toContain("native setting write failed");
    expect(log).not.toMatch(/secretmodel/);
  });
});

describe("native-config channel request", () => {
  const client = async (respond: (payload: Record<string, unknown>, operationId: string | undefined) => Effect.Effect<unknown, unknown>) => {
    const f = await fixture({ settings: { model: "opus" }, editor: "self", nodes: [seat("on-mini", { host: PEER, agentKey: `${PEER}:on-mini` })] });
    const host = Schema.decodeUnknownSync(RemoteHost)({ id: PEER, label: "Mini", isThisMachine: false, sshEndpoint: "mini", capabilities: ["terminal"] });
    const request = vi.fn((_machine: string, _channel: string, payload: unknown, options?: { readonly operationId?: string }) =>
      respond(payload as Record<string, unknown>, options?.operationId));
    const unused = Effect.die("unused machine operation");
    const links = MachineLink.of({
      setChannels: () => unused, listen: () => unused,
      connect: () => Effect.succeed({ machineName: PEER, installationId: editor, boundAt: "2026-10-17" }),
      connectSetup: () => unused, disconnect: () => unused, peerBuild: () => unused,
      sendEvent: () => unused, request: request as never,
    });
    const hosts = HostsService.of({
      get: () => Effect.succeed(host), list: unused, doctor: unused, doctorSnapshot: unused,
      upsert: () => unused, remove: () => unused, test: () => unused,
    } as never);
    const native = makeNativeConfigClient(await f.runtime.runPromise(makeNativeConfigAnswers()));
    const run = <A>(effect: Effect.Effect<A, never, never>) => f.runtime.runPromise(effect.pipe(
      Effect.provideService(HostsService, hosts), Effect.provideService(MachineLink, links),
    ));
    return { f, native, request, run };
  };

  it("answers this machine through the same code, with no link", async () => {
    const c = await client(() => Effect.die("this machine never uses the link"));
    expect(await c.run(c.native.readSettings({ machine: THIS_MACHINE, harness: "claude", keys: ["model"] }) as never))
      .toEqual({ ok: true, values: { model: "opus" }, unfit: [] });
    expect(await c.run(c.native.writeSetting({ machine: THIS_MACHINE, harness: "claude", key: "model", value: "sonnet" }) as never))
      .toEqual({ ok: true, value: "sonnet" });
    expect(c.request).not.toHaveBeenCalled();
  });

  it("asks a peer with the canvas and operation id, and refuses an answer to another question", async () => {
    let reply: unknown = { _tag: "Settings", machine: PEER, harness: "claude", values: [{ key: "model", value: "opus[1m]" }, { key: "effortLevel", unfit: true }] };
    const c = await client(() => Effect.succeed(reply));
    expect(await c.run(c.native.readSettings({ machine: PEER, harness: "claude", keys: ["model", "effortLevel"] }, "op-read") as never))
      .toEqual({ ok: true, values: { model: "opus[1m]" }, unfit: ["effortLevel"] });
    expect(c.request).toHaveBeenCalledWith(PEER, "native-config",
      { _tag: "ReadSettings", harness: "claude", keys: ["model", "effortLevel"], canvas }, { operationId: "op-read" });

    for (const wrong of [
      { _tag: "Settings", machine: "studio", harness: "claude", values: [] },
      { _tag: "Settings", machine: PEER, harness: "codex", values: [] },
      { _tag: "Settings", machine: PEER, harness: "claude", values: [{ key: "sandbox_mode", value: "x" }] },
      { _tag: "Settings", machine: PEER, harness: "claude", values: [{ key: "model", value: "<script>" }] },
      { _tag: "Written", machine: PEER, harness: "claude", key: "model", value: "x" },
    ]) {
      reply = wrong;
      const answer = await c.run(c.native.readSettings({ machine: PEER, harness: "claude", keys: ["model"] }, "op-wrong") as never) as { ok: boolean; error: { failure?: string; message: string } };
      expect(answer.ok, JSON.stringify(wrong)).toBe(false);
      expect(answer.error.failure).toBe("NativeConfigAnswerRefused");
      expect(answer.error.message).not.toContain("<script>");
    }
  });

  it("carries the peer's typed refusal with its own tag", async () => {
    const c = await client((_payload, operationId) => {
      const cause = new NativeSettingRefused({ machine: PEER, harness: "claude", key: "model", reason: "version", message: "model is not verified." });
      return Effect.fail(new LinkRequestFailed({
        machine: PEER, channel: "native-config", operationId: operationId ?? "minted",
        failure: encodeError(cause, { machine: PEER, operationId: operationId ?? "minted" }), detail: cause, message: cause.message,
      }));
    });
    expect(await c.run(c.native.writeSetting({ machine: PEER, harness: "claude", key: "model", value: "sonnet" }) as never)).toEqual({
      ok: false,
      error: { _tag: "NativeSettingRefusedError", harness: "claude", key: "model", reason: "version", message: "model is not verified." },
    });
  });

  it("reads a write back once when its link closed before the answer", async () => {
    let stored = "opus";
    let closeNext = true;
    const closed = new LinkClosed({ machine: PEER, by: "peer", reason: "closed", causes: [], message: "closed" });
    const c = await client((payload) => {
      if (payload._tag === "WriteSetting") {
        stored = payload.value as string;
        return closeNext ? Effect.fail(closed) : Effect.succeed({ _tag: "Written", machine: PEER, harness: "claude", key: "model", value: stored });
      }
      return Effect.succeed({ _tag: "Settings", machine: PEER, harness: "claude", values: [{ key: "model", value: stored }] });
    });
    expect(await c.run(c.native.writeSetting({ machine: PEER, harness: "claude", key: "model", value: "sonnet" }) as never))
      .toEqual({ ok: true, value: "sonnet" });
    expect(c.request.mock.calls.map((call) => (call[2] as { _tag: string })._tag)).toEqual(["WriteSetting", "ReadSettings"]);

    // The read-back shows another value, or cannot be read: unconfirmed, not refused.
    const unconfirmed = {
      ok: false,
      error: {
        _tag: "InventoryUnavailableError", machine: PEER, reason: "failed", failure: "NativeSettingUnconfirmed", operationId: "op-lost",
        message: "model on mini may not have taken: the link closed before the answer. Read it again.",
      },
    };
    const lost = await client((payload) => payload._tag === "WriteSetting"
      ? Effect.fail(closed)
      : Effect.succeed({ _tag: "Settings", machine: PEER, harness: "claude", values: [{ key: "model", value: "opus" }] }));
    expect(await lost.run(lost.native.writeSetting({ machine: PEER, harness: "claude", key: "model", value: "sonnet" }, "op-lost") as never))
      .toEqual(unconfirmed);
    const gone = await client(() => Effect.fail(closed));
    expect(await gone.run(gone.native.writeSetting({ machine: PEER, harness: "claude", key: "model", value: "sonnet" }, "op-lost") as never))
      .toEqual(unconfirmed);
    closeNext = false;
  });

  it("refuses a bad request before anything is sent", async () => {
    const c = await client(() => Effect.die("never sent"));
    for (const bad of [
      { machine: PEER, harness: "claude", key: "model", value: "a b" },
      { machine: PEER, harness: "not-a-harness", key: "model", value: "x" },
      { machine: PEER, harness: "claude", key: "../../etc", value: "x" },
    ]) {
      expect((await c.run(c.native.writeSetting(bad) as never) as { ok: boolean }).ok, JSON.stringify(bad)).toBe(false);
    }
    expect(c.request).not.toHaveBeenCalled();
  });
});
