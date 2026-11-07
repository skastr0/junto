/**
 * The native-config channel through two real sessions over a pair of streams:
 * the contract's typed client at the asking end, the channel's bound handlers
 * at the answering end, and a hand-written peer where an answer must be one no
 * typed handler could send. This machine's own answers use the same code with
 * no link at all.
 */
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostsService } from "../src/core/hosts/service";
import { makeNativeConfigAnswers, makeNativeConfigChannel, NativeConfigLink } from "../src/core/inventory/native-channel";
import { makeNativeConfigClient } from "../src/core/inventory/native-client";
import { NativeSettingRefused } from "../src/core/inventory/native-wire";
import { bindLinkChannel, linkClient, type LinkClient, type LinkContractChannel, type LinkHandlers } from "../src/core/link/contract";
import { decodeLinkFrame, LinkHelloSchema, type LinkFrame } from "../src/core/link/protocol";
import { isMachineLinkError, LinkClosed, LinkUnavailable, MachineLink } from "../src/core/link/service";
import { makeLinkSession } from "../src/core/link/session";
import { linkClosed, type LinkChannelContext, type LinkHello, type LinkSession } from "../src/core/link/types";
import { MachineRepository, makeMachineRepositoryLive } from "../src/core/machines/repository";
import { machineLogDir } from "../src/node/observability/log-file";
import { ModelService } from "../src/core/model/service";
import { makeNativeConfig, NativeConfig } from "../src/core/native-config/service";
import { makeStateEngineLive } from "../src/core/state/engine";
import { HarnessInventory } from "../src/core/term/templates/harness-inventory";
import { WorkRepositoryLive } from "../src/core/work/repository";
import type { MachineInventory } from "../src/shared/harness-domain/inventory";
import { InstallationId } from "../src/shared/installation-id";
import { asCanvasName, type Node } from "../src/shared/model";
import { RemoteHost } from "../src/shared/remote-hosts";
import { THIS_MACHINE } from "./support/machines";
import { seat } from "./support/model-nodes";
import { ModelStoresLive, seedCanvas } from "./support/seed-canvas";
import { clearMachines, seedThisMachine } from "./support/seed-this-machine";
import { makeTestLog } from "./support/test-log";

const testLog = makeTestLog();

const installation = Schema.decodeUnknownSync(InstallationId);
const editor = installation("editor-installation");
const canvas = asCanvasName("native-canvas");
const PEER = "mini";
const BUILD = "a".repeat(64);
const here = seat("here", { host: THIS_MACHINE, agentKey: `${THIS_MACHINE}:here` });

const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => seedThisMachine());
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  for (const close of cleanups.splice(0).reverse()) await close();
  clearMachines();
});

/** The peer session the runtime's `MachineLink` reaches, once a test has built it. */
type Held = { session?: LinkSession };

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
  const held: Held = {};
  const host = Schema.decodeUnknownSync(RemoteHost)({
    id: PEER, label: "Mini", isThisMachine: false, sshEndpoint: "mini", capabilities: ["terminal"],
  });
  const hosts = HostsService.of({
    get: (machine: string) => Effect.succeed(machine === PEER ? host : undefined),
    list: Effect.die("unused"), doctor: Effect.die("unused"), doctorSnapshot: Effect.die("unused"),
    upsert: () => Effect.die("unused"), remove: () => Effect.die("unused"), test: () => Effect.die("unused"),
  } as never);
  const runtime = ManagedRuntime.make(Layer.mergeAll(
    Layer.provideMerge(config, inventory),
    Layer.provideMerge(ModelStoresLive, repositories),
    testLog.log.loggerLayer,
    Layer.succeed(HostsService, hosts),
    Layer.succeed(MachineLink, linkOver(held)),
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
  const run = <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect);
  const channel = await runtime.runPromise(makeNativeConfigChannel());
  const answers = await runtime.runPromise(makeNativeConfigAnswers());
  return { root, home, runtime, run, held, channel, answers };
};

// ── Two ends of one link, over a pair of streams ──────────────────────────

const sessions: LinkSession[] = [];
const helloOf = (machineName: string, installationId: string): LinkHello =>
  Schema.decodeUnknownSync(LinkHelloSchema)({ build: BUILD, installationId, machineName });
const EDITOR_HELLO = helloOf("macbook", "editor-installation");
const PEER_HELLO = helloOf(PEER, "mini-installation");

type NativeHandlers = LinkHandlers<typeof NativeConfigLink>["requests"];
type Run = <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;

/** The asking end binds the contract too: it encodes what it sends and decodes what it gets. */
const asking = (): LinkContractChannel => peerOf();

/** An answering end typed by the contract; every tag a test does not override answers nothing. */
const peerOf = (handlers: Partial<NativeHandlers> = {}): LinkContractChannel => bindLinkChannel(NativeConfigLink, {
  requests: {
    ReadSettings: () => Effect.die("unused"),
    WriteSetting: () => Effect.die("unused"),
    ...handlers,
  },
});

/** A real session at each end. */
const pair = (options: {
  readonly left: LinkHello; readonly right: LinkHello;
  readonly leftChannel: LinkContractChannel; readonly rightChannel: LinkContractChannel;
  readonly run: Run;
}) => {
  const ab = new PassThrough(); const ba = new PassThrough();
  const left = makeLinkSession({ readable: ba, writable: ab, self: options.left, admit: async () => {}, channels: { "native-config": options.leftChannel }, run: options.run });
  const right = makeLinkSession({ readable: ab, writable: ba, self: options.right, admit: async () => {}, channels: { "native-config": options.rightChannel }, run: options.run });
  sessions.push(left, right);
  return { left, right };
};

/** A real session facing an end written by hand, which says hello and writes what `reply` returns to each frame. */
const facingRaw = (options: {
  readonly self: LinkHello; readonly peer: LinkHello; readonly channel: LinkContractChannel; readonly run: Run;
  readonly reply?: (frame: LinkFrame) => unknown;
}) => {
  const toSession = new PassThrough(); const fromSession = new PassThrough();
  const send = (frame: unknown) => toSession.write(`${JSON.stringify(frame)}\n`);
  let pending = "";
  fromSession.on("data", (bytes: Buffer) => {
    pending += bytes.toString();
    for (let newline = pending.indexOf("\n"); newline >= 0; newline = pending.indexOf("\n")) {
      const frame = decodeLinkFrame(JSON.parse(pending.slice(0, newline)));
      pending = pending.slice(newline + 1);
      if (frame.type === "hello") send({ type: "hello", ...options.peer });
      else if (options.reply !== undefined) { const answer = options.reply(frame); if (answer !== undefined) send(answer); }
    }
  });
  const session = makeLinkSession({ readable: toSession, writable: fromSession, self: options.self, admit: async () => {}, channels: { "native-config": options.channel }, run: options.run });
  sessions.push(session);
  return { session, send };
};

/** This core's link, with one peer reached over `held.session`, as `MachineLink` sees it. */
const linkOver = (held: Held) => {
  const unused = Effect.die("unused machine operation");
  const toLink = (machine: string) => (cause: unknown) => isMachineLinkError(cause) ? cause : linkClosed({ machine, by: "this-end", reason: "failed", cause });
  return MachineLink.of({
    setChannels: () => unused, listen: () => unused, connectSetup: () => unused, disconnect: () => unused, peerBuild: () => unused,
    connect: () => Effect.succeed({ machineName: PEER, installationId: editor, boundAt: "2026-10-17" }),
    request: (machine, channel, payload, options) => {
      const open = held.session;
      if (open === undefined) return Effect.fail(new LinkUnavailable({ machine, reason: "not-linked", message: `${machine} is not linked` }));
      return Effect.tryPromise({ try: (signal) => open.request(channel, payload, options?.operationId, options?.tag, signal), catch: toLink(machine) });
    },
    sendEvent: (machine, channel, payload) => {
      const open = held.session;
      if (open === undefined) return Effect.fail(new LinkUnavailable({ machine, reason: "not-linked", message: `${machine} is not linked` }));
      return Effect.tryPromise({ try: () => open.sendEvent(channel, payload), catch: toLink(machine) });
    },
  });
};

describe("native-config channel answer, over a real session pair", () => {
  /** The editing machine's typed client asks this machine's real channel across the pair. */
  const answering = async (options: Parameters<typeof fixture>[0] = {}) => {
    const f = await fixture(options);
    const { left } = pair({ left: EDITOR_HELLO, right: helloOf(THIS_MACHINE, "studio-installation"), leftChannel: asking(), rightChannel: f.channel, run: f.run });
    f.held.session = left;
    await left.ready;
    const call = <A>(use: (client: LinkClient<typeof NativeConfigLink>) => Effect.Effect<A, unknown>) =>
      Effect.flatMap(linkClient(NativeConfigLink), use);
    const ask = <A>(use: (client: LinkClient<typeof NativeConfigLink>) => Effect.Effect<A, unknown>) => f.runtime.runPromise(call(use));
    const refused = <A>(use: (client: LinkClient<typeof NativeConfigLink>) => Effect.Effect<A, unknown>) => f.runtime.runPromise(Effect.flip(call(use)));
    return { ...f, ask, refused };
  };

  const read = (client: LinkClient<typeof NativeConfigLink>, keys: ReadonlyArray<string>, operationId = "op-native-1") =>
    client.ReadSettings(THIS_MACHINE, { canvas, harness: "claude", keys: [...keys] }, { operationId });

  it("reads declared keys; a file value outside its setting crosses as unfit, never its text", async () => {
    const f = await answering({ settings: { model: "opus[1m]", effortLevel: "turbo <x>", env: { SECRET: "nope" } } });
    const answer = await f.ask((client) => read(client, ["model", "effortLevel", "alwaysThinkingEnabled"]));
    expect(answer).toEqual({
      _tag: "Settings", machine: THIS_MACHINE, harness: "claude",
      values: [{ key: "model", value: "opus[1m]" }, { key: "effortLevel", unfit: true }],
    });
    expect(JSON.stringify(answer)).not.toContain("turbo");
    expect(JSON.stringify(answer)).not.toContain("SECRET");
  });

  it("refuses an undeclared key as the channel's typed failure", async () => {
    const f = await answering({ settings: {} });
    expect(await f.refused((client) => read(client, ["env"])))
      .toMatchObject({ _tag: "NativeSettingRefused", reason: "undeclared", key: "env", operationId: "op-native-1" });
  });

  it("writes a declared key after a read, answers the value read back, and a repeat leaves the same file", async () => {
    const f = await answering({ settings: { model: "opus", theme: "dark" } });
    await f.ask((client) => read(client, ["model"]));
    const write = (client: LinkClient<typeof NativeConfigLink>) =>
      client.WriteSetting(THIS_MACHINE, { canvas, harness: "claude", key: "model", value: "sonnet[1m]" }, { operationId: "op-native-1" });
    expect(await f.ask(write)).toEqual({ _tag: "Written", machine: THIS_MACHINE, harness: "claude", key: "model", value: "sonnet[1m]" });
    const once = await readFile(join(f.home, ".claude", "settings.json"), "utf8");
    expect(JSON.parse(once)).toEqual({ model: "sonnet[1m]", theme: "dark" });
    await f.ask(write);
    expect(await readFile(join(f.home, ".claude", "settings.json"), "utf8")).toBe(once);
  });

  it("refuses a value or version outside the setting, and a file changed by hand, with fixed text and no path", async () => {
    const f = await answering({ settings: { model: "opus" } });
    await f.ask((client) => read(client, ["model", "effortLevel"]));
    const value = await f.refused((client) =>
      client.WriteSetting(THIS_MACHINE, { canvas, harness: "claude", key: "effortLevel", value: "ultra" }, { operationId: "op-native-1" }));
    expect(value).toMatchObject({ _tag: "NativeSettingRefused", reason: "value" });
    expect(JSON.stringify(value)).not.toContain("ultra");

    await writeFile(join(f.home, ".claude", "settings.json"), `{"model": "haiku"}\n`);
    const conflict = await f.refused((client) =>
      client.WriteSetting(THIS_MACHINE, { canvas, harness: "claude", key: "model", value: "sonnet" }, { operationId: "op-native-1" }));
    expect(conflict).toMatchObject({ _tag: "NativeConfigWriteFailed", reason: "conflict", key: "model" });
    expect(JSON.stringify(conflict)).not.toContain(f.home);
    expect(JSON.stringify(conflict)).not.toContain("settings.json");

    const old = await answering({ settings: { model: "opus" }, claudeVersion: "2.0.0" });
    await old.ask((client) => read(client, ["model"]));
    expect(await old.refused((client) =>
      client.WriteSetting(THIS_MACHINE, { canvas, harness: "claude", key: "model", value: "sonnet" }, { operationId: "op-native-1" })))
      .toMatchObject({ _tag: "NativeSettingRefused", reason: "version" });
  });

  it("admits only the pinned editor of a canvas with a seat here, as typed failures", async () => {
    const readAll = (client: LinkClient<typeof NativeConfigLink>) => read(client, ["model"]);
    const stranger = await fixture({ settings: {} });
    const { left } = pair({ left: helloOf("macbook", "stranger-installation"), right: helloOf(THIS_MACHINE, "studio-installation"),
      leftChannel: asking(), rightChannel: stranger.channel, run: stranger.run });
    stranger.held.session = left;
    await left.ready;
    const ask = <A>(use: (client: LinkClient<typeof NativeConfigLink>) => Effect.Effect<A, unknown>) =>
      stranger.runtime.runPromise(Effect.flip(Effect.flatMap(linkClient(NativeConfigLink), use)));
    expect(await ask(readAll)).toMatchObject({ _tag: "InventoryPeerNotPinned" });
    expect(await (await answering({ settings: {}, editor: "self" })).refused(readAll)).toMatchObject({ _tag: "InventoryCanvasEditorMismatch" });
    expect(await (await answering({ settings: {}, nodes: [seat("away", { host: "macbook", agentKey: "macbook:away" })] })).refused(readAll))
      .toMatchObject({ _tag: "InventoryNoSeatHere" });
  });

  it("closes on a request with any key beyond the payload's own, before admission", async () => {
    const f = await fixture({ settings: {} });
    for (const payload of [
      { canvas, harness: "claude", keys: ["model"], file: ".claude/settings.json" },
      { canvas, harness: "claude", keys: [] },
      { canvas, harness: "claude", keys: ["../x"] },
      { canvas, harness: "claude", key: "model", value: "$(id)" },
      { canvas, harness: "claude", key: "model", value: "a b" },
      { canvas, harness: "claude", key: "model", value: Number.NaN },
      { canvas, harness: "claude", key: "model", value: { nested: true } },
      { canvas, harness: "claude", key: "alwaysThinkingEnabled" },
    ]) {
      const channel = await f.runtime.runPromise(makeNativeConfigChannel());
      const raw = facingRaw({ self: helloOf(THIS_MACHINE, "studio-installation"), peer: EDITOR_HELLO, channel, run: f.run });
      await raw.session.ready;
      const tag = "key" in payload ? "WriteSetting" : "ReadSettings";
      raw.send({ type: "request", id: "r1", op: "op-1", channel: "native-config", tag, payload });
      const closed = await raw.session.closed;
      expect(closed, JSON.stringify(payload)).toMatchObject({ reason: "frame-invalid" });
    }
  });

  it("closes on a request tag the contract does not name", async () => {
    const f = await fixture({ settings: {} });
    const raw = facingRaw({ self: helloOf(THIS_MACHINE, "studio-installation"), peer: EDITOR_HELLO, channel: f.channel, run: f.run });
    await raw.session.ready;
    raw.send({ type: "request", id: "r1", op: "op-1", channel: "native-config", tag: "Toggle", payload: { canvas } });
    const closed = await raw.session.closed;
    expect(closed).toMatchObject({ reason: "frame-invalid" });
    expect(closed.message).toContain("has no request");
  });

  it("refuses an event frame: the channel carries none", async () => {
    const f = await fixture({ settings: {} });
    const raw = facingRaw({ self: helloOf(THIS_MACHINE, "studio-installation"), peer: EDITOR_HELLO, channel: f.channel, run: f.run });
    await raw.session.ready;
    raw.send({ type: "event", channel: "native-config", payload: {} });
    const closed = await raw.session.closed;
    expect(closed).toMatchObject({ reason: "frame-invalid" });
    expect(closed.message).toContain("does not accept events");
  });

  it("writes nothing for a link that closed before or during admission", async () => {
    const f = await answering({ settings: { model: "opus" } });
    await f.ask((client) => read(client, ["model"]));
    const payload = { canvas, harness: "claude", key: "model", value: "sonnet" };
    const before = new AbortController();
    before.abort();
    // Open at the first look, closed by the time the checks have run.
    let looks = 0;
    const during = { get aborted() { return looks++ > 0; } } as AbortSignal;
    for (const signal of [before.signal, during]) {
      const context: LinkChannelContext = {
        peer: EDITOR_HELLO, keyBound: false, sessionId: "admitted-link", operationId: "op-native-1", signal,
        sendEvent: () => Effect.void, close: () => Effect.void, request: () => Effect.die("unused"),
      };
      const refused = await f.runtime.runPromise(Effect.flip(f.channel.handleRequest("WriteSetting", context, payload)));
      expect(refused).toMatchObject({ _tag: "InventoryLinkClosed", operationId: "op-native-1" });
    }
    expect(JSON.parse(await readFile(join(f.home, ".claude", "settings.json"), "utf8"))).toEqual({ model: "opus" });
  });

  it("never logs a value it reads or writes", async () => {
    const logHome = await mkdtemp(join(tmpdir(), "junto-native-log-"));
    cleanups.push(async () => { testLog.log.closeFile(); await rm(logHome, { recursive: true, force: true }); });
    testLog.log.openFile({ home: logHome });
    const f = await answering({ settings: { model: "secretmodel-a1" } });
    await f.ask((client) => read(client, ["model"]));
    await f.ask((client) => client.WriteSetting(THIS_MACHINE, { canvas, harness: "claude", key: "model", value: "secretmodel-b2" }, { operationId: "op-native-1" }));
    await f.refused((client) => client.WriteSetting(THIS_MACHINE, { canvas, harness: "claude", key: "effortLevel", value: "secretmodel-c3" }, { operationId: "op-native-1" }));
    const log = readFileSync(join(machineLogDir(logHome), "core.jsonl"), "utf8");
    expect(log).toContain("native setting written");
    expect(log).toContain("native setting write failed");
    expect(log).not.toMatch(/secretmodel/);
  });
});

describe("native-config channel request, over a real session pair", () => {
  const remote = seat("on-mini", { host: PEER, agentKey: `${PEER}:on-mini` });

  /** `mini` answers with the contract's typed handlers; the client under test asks through the real pair. */
  const client = async (handlers: Partial<NativeHandlers> = {}) => {
    const f = await fixture({ settings: { model: "opus" }, editor: "self", nodes: [remote] });
    f.held.session = pair({
      left: helloOf(THIS_MACHINE, "studio-installation"),
      right: PEER_HELLO,
      leftChannel: asking(),
      rightChannel: peerOf(handlers),
      run: f.run,
    }).left;
    await f.held.session.ready;
    return { ...f, native: makeNativeConfigClient(f.answers) };
  };

  /** `mini` writes its answer by hand, as bytes no typed handler could send. */
  const rawClient = async (payload: () => unknown) => {
    const f = await fixture({ settings: { model: "opus" }, editor: "self", nodes: [remote] });
    f.held.session = facingRaw({
      self: helloOf(THIS_MACHINE, "studio-installation"), peer: PEER_HELLO, channel: asking(), run: f.run,
      reply: (frame) => frame.type !== "request" ? undefined
        : { type: "response", id: frame.id, op: frame.op, channel: frame.channel, ok: true, payload: payload() },
    }).session;
    await f.held.session.ready;
    return { ...f, native: makeNativeConfigClient(f.answers) };
  };

  it("answers this machine through the same code, with no link", async () => {
    const f = await client();
    f.held.session = undefined;
    expect(await f.runtime.runPromise(f.native.readSettings({ machine: THIS_MACHINE, harness: "claude", keys: ["model"] })))
      .toEqual({ ok: true, values: { model: "opus" }, unfit: [] });
    expect(await f.runtime.runPromise(f.native.writeSetting({ machine: THIS_MACHINE, harness: "claude", key: "model", value: "sonnet" })))
      .toEqual({ ok: true, value: "sonnet" });
  });

  it("asks a peer with the canvas and operation id, and refuses an answer to another question", async () => {
    const seen: Array<{ readonly payload: unknown; readonly operationId?: string }> = [];
    const c = await client({
      ReadSettings: (payload, context) => {
        seen.push({ payload, ...(context.operationId === undefined ? {} : { operationId: context.operationId }) });
        return Effect.succeed({ _tag: "Settings", machine: PEER, harness: "claude", values: [{ key: "model", value: "opus[1m]" }, { key: "effortLevel", unfit: true }] });
      },
    });
    expect(await c.runtime.runPromise(c.native.readSettings({ machine: PEER, harness: "claude", keys: ["model", "effortLevel"] }, "op-read")))
      .toEqual({ ok: true, values: { model: "opus[1m]" }, unfit: ["effortLevel"] });
    expect(seen).toEqual([{ payload: { canvas, harness: "claude", keys: ["model", "effortLevel"] }, operationId: "op-read" }]);

    for (const wrong of [
      { _tag: "Settings", machine: "studio", harness: "claude", values: [] },
      { _tag: "Settings", machine: PEER, harness: "codex", values: [] },
      { _tag: "Settings", machine: PEER, harness: "claude", values: [{ key: "sandbox_mode", value: "x" }] },
      { _tag: "Settings", machine: PEER, harness: "claude", values: [{ key: "model", value: "<script>" }] },
      { _tag: "Written", machine: PEER, harness: "claude", key: "model", value: "x" },
    ]) {
      const bad = await rawClient(() => wrong);
      const answer = await bad.runtime.runPromise(bad.native.readSettings({ machine: PEER, harness: "claude", keys: ["model"] }, "op-wrong")) as { ok: boolean; error: { failure?: string; message: string } };
      expect(answer.ok, JSON.stringify(wrong)).toBe(false);
      expect(answer.error.failure).toBe("NativeConfigAnswerRefused");
      expect(answer.error.message).not.toContain("<script>");
    }
  });

  it("carries the peer's typed refusal with its own tag", async () => {
    const c = await client({
      WriteSetting: () => Effect.fail(new NativeSettingRefused({ machine: PEER, harness: "claude", key: "model", reason: "version", message: "model is not verified." })),
    });
    expect(await c.runtime.runPromise(c.native.writeSetting({ machine: PEER, harness: "claude", key: "model", value: "sonnet" }))).toEqual({
      ok: false,
      error: { _tag: "NativeSettingRefusedError", harness: "claude", key: "model", reason: "version", message: "model is not verified." },
    });
  });

  it("reads a write back once when its link closed before the answer", async () => {
    let stored = "opus";
    let applies = true;
    let closeNext = true;
    const closed = new LinkClosed({ machine: PEER, by: "peer", reason: "closed", causes: [], message: "closed" });
    const unused = Effect.die("unused machine operation");
    const links = MachineLink.of({
      setChannels: () => unused, listen: () => unused, connectSetup: () => unused, disconnect: () => unused, peerBuild: () => unused,
      connect: () => Effect.succeed({ machineName: PEER, installationId: editor, boundAt: "2026-10-17" }),
      sendEvent: () => unused,
      request: (_machine, _channel, payload, options) => {
        const asked = payload as { readonly tag?: string; readonly _tag?: string; readonly value?: unknown };
        const tag = options?.tag ?? asked._tag;
        if (tag === "WriteSetting") {
          if (applies) stored = asked.value as string;
          return closeNext ? Effect.fail(closed) : Effect.succeed({ _tag: "Written", machine: PEER, harness: "claude", key: "model", value: stored });
        }
        return Effect.succeed({ _tag: "Settings", machine: PEER, harness: "claude", values: [{ key: "model", value: stored }] });
      },
    });
    const c = await client();
    const write = (value: string, operationId?: string) => c.runtime.runPromise(
      c.native.writeSetting({ machine: PEER, harness: "claude", key: "model", value }, operationId).pipe(Effect.provideService(MachineLink, links)),
    );
    expect(await write("sonnet")).toEqual({ ok: true, value: "sonnet" });
    // The link closed first, so the write is read back once.
    expect(stored).toBe("sonnet");

    // The read-back shows another value, or cannot be read: unconfirmed, not refused.
    const unconfirmed = {
      ok: false,
      error: {
        _tag: "InventoryUnavailableError", machine: PEER, reason: "failed", failure: "NativeSettingUnconfirmed", operationId: "op-lost",
        message: "model on mini may not have taken: the link closed before the answer. Read it again.",
      },
    };
    closeNext = true;
    applies = false;
    stored = "opus";
    expect(await write("sonnet", "op-lost")).toEqual(unconfirmed);
    const gone = MachineLink.of({
      setChannels: () => unused, listen: () => unused, connectSetup: () => unused, disconnect: () => unused, peerBuild: () => unused,
      connect: () => Effect.succeed({ machineName: PEER, installationId: editor, boundAt: "2026-10-17" }),
      sendEvent: () => unused,
      request: () => Effect.fail(closed),
    });
    expect(await c.runtime.runPromise(c.native.writeSetting({ machine: PEER, harness: "claude", key: "model", value: "sonnet" }, "op-lost")
      .pipe(Effect.provideService(MachineLink, gone))))
      .toEqual(unconfirmed);
  });

  it("refuses a bad request before anything is sent", async () => {
    const c = await client();
    const requests = vi.fn();
    const unused = Effect.die("unused machine operation");
    const links = MachineLink.of({
      setChannels: () => unused, listen: () => unused, connectSetup: () => unused, disconnect: () => unused, peerBuild: () => unused,
      connect: () => Effect.succeed({ machineName: PEER, installationId: editor, boundAt: "2026-10-17" }),
      sendEvent: () => unused,
      request: ((...args: unknown[]) => { requests(...args); return unused; }) as never,
    });
    for (const bad of [
      { machine: PEER, harness: "claude", key: "model", value: "a b" },
      { machine: PEER, harness: "not-a-harness", key: "model", value: "x" },
      { machine: PEER, harness: "claude", key: "../../etc", value: "x" },
    ]) {
      const answer = await c.runtime.runPromise(c.native.writeSetting(bad).pipe(Effect.provideService(MachineLink, links))) as { ok: boolean };
      expect(answer.ok, JSON.stringify(bad)).toBe(false);
    }
    expect(requests).not.toHaveBeenCalled();
  });
});
