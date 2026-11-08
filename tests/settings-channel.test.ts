/**
 * The settings channel through two real sessions over a pair of streams: the
 * contract's typed client at the asking end, the channel's bound handlers at
 * the answering end, and a hand-written peer where an answer must be one no
 * typed handler could send.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HostsService } from "../src/core/hosts/service";
import { bindLinkChannel, linkClient, type LinkClient, type LinkContractChannel, type LinkHandlers } from "../src/core/link/contract";
import { decodeLinkFrame, LinkHelloSchema, type LinkFrame } from "../src/core/link/protocol";
import { isMachineLinkError, LinkUnavailable, MachineLink } from "../src/core/link/service";
import { makeLinkSession } from "../src/core/link/session";
import { linkClosed, type LinkHello, type LinkSession } from "../src/core/link/types";
import { MachineRepository, makeMachineRepositoryLive } from "../src/core/machines/repository";
import { ModelService } from "../src/core/model/service";
import { PeerSettings, peerSettingsLayer } from "../src/core/settings/link-client";
import { makeSettingsChannel, SettingsLink } from "../src/core/settings/link-channel";
import {
  CacheWindowsWrite,
  LinkCacheWindows,
  LinkProviders,
  ProvidersWrite,
  SettingsLinkFailure,
  SettingsNoSeatHere,
  StartupWrite,
  wireProviders,
} from "../src/core/settings/link-wire";
import { SettingsService } from "../src/core/settings/service";
import { makeStateEngineLive } from "../src/core/state/engine";
import { WorkRepositoryLive } from "../src/core/work/repository";
import { InstallationId } from "../src/shared/installation-id";
import { asCanvasName, type Node } from "../src/shared/model";
import { RemoteHost } from "../src/shared/remote-hosts";
import { PROVIDER_SECRET_FIELDS, PROVIDER_SECTION_KEYS } from "../src/shared/settings";
import { THIS_MACHINE } from "./support/machines";
import { seat } from "./support/model-nodes";
import { ModelStoresLive, seedCanvas } from "./support/seed-canvas";
import { clearMachines, seedThisMachine } from "./support/seed-this-machine";
import { makeTestLog } from "./support/test-log";

const { log: testLog } = makeTestLog();

const installation = Schema.decodeUnknownSync(InstallationId);
const editor = installation("editor-installation");
const canvas = asCanvasName("settings-canvas");
const PEER = "mini";
const BUILD = "a".repeat(64);

/** A machine's settings as its core holds them, a secret value included. */
const stored = () => ({
  machine: { name: THIS_MACHINE, supervisedPreferred: false },
  providers: {
    enabledSources: ["claude"],
    openai: { apiKey: "sk-secret-value", baseUrl: "https://example.test" },
    openrouter: { apiKeyConfigured: true },
  },
});

const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => seedThisMachine());
afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.close()));
  for (const close of cleanups.splice(0).reverse()) await close();
  clearMachines();
});

/** The peer session the runtime's `MachineLink` reaches, once a test has built it. */
type Held = { session?: LinkSession };

const runtimeWith = async (nodes: ReadonlyArray<Node>, canvasEditor: "editor" | "self", held: Held = {}) => {
  const root = await mkdtemp(join(tmpdir(), "junto-settings-link-"));
  let state = stored() as Record<string, any>;
  const patch = vi.fn((input: Record<string, any>) => Effect.sync(() => {
    if (input.providers) state = { ...state, providers: { ...state.providers, ...input.providers } };
    if (input.offboard) {
      const harness = { ...state.offboard?.harness };
      for (const [id, over] of Object.entries(input.offboard.harness ?? {})) {
        if (over === null) delete harness[id];
        else harness[id] = over;
      }
      state = {
        ...state,
        offboard: {
          cacheWindowMinutes: input.offboard.cacheWindowMinutes ?? state.offboard?.cacheWindowMinutes ?? 60,
          harness,
          ...((input.offboard.cacheMode ?? state.offboard?.cacheMode) === undefined
            ? {} : { cacheMode: input.offboard.cacheMode ?? state.offboard?.cacheMode }),
        },
      };
    }
    return state as never;
  }));
  const setMachinePreferences = vi.fn((input: Record<string, unknown>) => Effect.sync(() => {
    state = { ...state, machine: { ...state.machine, ...input } };
    return state as never;
  }));
  const settingsLayer = Layer.succeed(SettingsService, SettingsService.of({
    get: Effect.sync(() => state as never),
    patch,
    setMachinePreferences,
  } as never));
  const repositories = Layer.provideMerge(Layer.mergeAll(
    WorkRepositoryLive,
    makeMachineRepositoryLive({ defaultName: () => THIS_MACHINE }),
  ), makeStateEngineLive(join(root, "junto.db")));
  const base = Layer.provideMerge(ModelStoresLive, repositories);
  const host = Schema.decodeUnknownSync(RemoteHost)({
    id: PEER, label: "Mini", isThisMachine: false, sshEndpoint: "mini", capabilities: ["terminal"],
  });
  const hosts = HostsService.of({
    get: (machine: string) => Effect.succeed(machine === PEER ? host : undefined),
    list: Effect.die("unused"), doctor: Effect.die("unused"), doctorSnapshot: Effect.die("unused"),
    upsert: () => Effect.die("unused"), remove: () => Effect.die("unused"), test: () => Effect.die("unused"),
  } as never);
  const links = linkOver(held);
  const peer = Layer.provideMerge(peerSettingsLayer(), Layer.mergeAll(Layer.succeed(HostsService, hosts), Layer.succeed(MachineLink, links), base));
  const runtime = ManagedRuntime.make(Layer.mergeAll(settingsLayer, peer, testLog.loggerLayer));
  cleanups.push(async () => {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await runtime.runPromise(Effect.gen(function* () {
    const machines = yield* MachineRepository;
    yield* machines.pinPeer({ machineName: "macbook", installationId: editor });
    yield* machines.pinPeer({ machineName: PEER, installationId: installation("mini-installation") });
    if (canvasEditor === "self") return yield* seedCanvas(canvas, nodes);
    yield* (yield* ModelService).installCopy({ canvas, canvasId: "copied-canvas", seq: 1, editor, nodes, wires: [] });
  }));
  const run = <A, E>(effect: Effect.Effect<A, E>) => runtime.runPromise(effect);
  return { root, runtime, run, patch, setMachinePreferences, held };
};

// ── Two ends of one link, over a pair of streams ──────────────────────────

const sessions: LinkSession[] = [];
const helloOf = (machineName: string, installationId: string): LinkHello =>
  Schema.decodeUnknownSync(LinkHelloSchema)({ build: BUILD, installationId, machineName });
const EDITOR_HELLO = helloOf("macbook", "editor-installation");
const PEER_HELLO = helloOf(PEER, "mini-installation");
const here = seat("here", { host: THIS_MACHINE, agentKey: `${THIS_MACHINE}:here` });

type SettingsHandlers = LinkHandlers<typeof SettingsLink>["requests"];
type Run = <A, E>(effect: Effect.Effect<A, E>) => Promise<A>;

/** The asking end binds the contract too: it encodes what it sends and decodes what it gets. */
const asking = (): LinkContractChannel => peerOf();

/** An answering end typed by the contract; every tag a test does not override answers nothing. */
const peerOf = (handlers: Partial<SettingsHandlers> = {}): LinkContractChannel => bindLinkChannel(SettingsLink, {
  requests: {
    ProvidersRead: () => Effect.die("unused"),
    ProvidersWrite: () => Effect.die("unused"),
    RecordRead: () => Effect.die("unused"),
    StartupWrite: () => Effect.die("unused"),
    CacheWindowsRead: () => Effect.die("unused"),
    CacheWindowsWrite: () => Effect.die("unused"),
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
  const left = makeLinkSession({ readable: ba, writable: ab, self: options.left, admit: async () => {}, channels: { settings: options.leftChannel }, run: options.run });
  const right = makeLinkSession({ readable: ab, writable: ba, self: options.right, admit: async () => {}, channels: { settings: options.rightChannel }, run: options.run });
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
  const session = makeLinkSession({ readable: toSession, writable: fromSession, self: options.self, admit: async () => {}, channels: { settings: options.channel }, run: options.run });
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

const decodeProviders = Schema.decodeUnknownSync(LinkProviders, { onExcessProperty: "error" });
const decodeWindows = Schema.decodeUnknownSync(LinkCacheWindows, { onExcessProperty: "error" });
const strict = { onExcessProperty: "error" } as const;

describe("settings channel wire", () => {
  it("carries each declared credential as set or not, never a value or an undeclared field", () => {
    const wire = wireProviders({
      machine: "mini",
      enabledSources: ["claude", "claude"],
      credentials: { openai: { apiKey: true, baseUrl: true }, extra: { token: true } } as never,
    });
    expect(Object.keys(wire.credentials)).toEqual([...PROVIDER_SECTION_KEYS]);
    for (const section of PROVIDER_SECTION_KEYS)
      expect(Object.keys(wire.credentials[section as keyof typeof wire.credentials])).toEqual([...PROVIDER_SECRET_FIELDS[section]]);
    expect(wire.credentials.openai).toEqual({ apiKey: true });
    expect(wire.enabledSources).toEqual(["claude"]);
    expect(JSON.stringify(wire)).not.toContain("extra");
  });

  it("decodes a providers answer closed: a value, an excess key or an undeclared section is refused", () => {
    const good = JSON.parse(JSON.stringify(wireProviders({ machine: "mini", enabledSources: [], credentials: {} })));
    expect(decodeProviders(good).credentials.openai).toEqual({ apiKey: false });
    expect(() => decodeProviders({ ...good, credentials: { ...good.credentials, openai: { apiKey: "sk-1" } } })).toThrow();
    expect(() => decodeProviders({ ...good, credentials: { ...good.credentials, extra: {} } })).toThrow();
    expect(() => decodeProviders({ ...good, path: "/Users/x" })).toThrow();
  });

  it("names a canvas and a closed change: credentials, a missing or repeated source, or an excess key is refused", () => {
    expect(Schema.decodeUnknownSync(ProvidersWrite, strict)({ canvas, enabledSources: ["claude"] })).toEqual({ canvas, enabledSources: ["claude"] });
    expect(() => Schema.decodeUnknownSync(ProvidersWrite, strict)({ canvas })).toThrow();
    expect(() => Schema.decodeUnknownSync(ProvidersWrite, strict)({ canvas, openai: { apiKey: "sk-1" } })).toThrow();
    expect(() => Schema.decodeUnknownSync(ProvidersWrite, strict)({ canvas, enabledSources: ["claude", "claude"] })).toThrow();
    expect(Schema.decodeUnknownSync(StartupWrite, strict)({ canvas, supervisedPreferred: true })).toEqual({ canvas, supervisedPreferred: true });
    expect(() => Schema.decodeUnknownSync(StartupWrite, strict)({ canvas, supervisedPreferred: true, name: "x" })).toThrow();
  });

  it("decodes a cache windows change closed: an empty write, an undeclared harness or a window out of bounds is refused", () => {
    expect(Schema.decodeUnknownSync(CacheWindowsWrite, strict)({ canvas, harness: { codex: null } })).toEqual({ canvas, harness: { codex: null } });
    expect(() => Schema.decodeUnknownSync(CacheWindowsWrite, strict)({ canvas })).toThrow();
    expect(() => Schema.decodeUnknownSync(CacheWindowsWrite, strict)({ canvas, harness: {} })).toThrow();
    expect(() => Schema.decodeUnknownSync(CacheWindowsWrite, strict)({ canvas, harness: { "made-up": 5 } })).toThrow();
    expect(() => Schema.decodeUnknownSync(CacheWindowsWrite, strict)({ canvas, cacheWindowMinutes: 0 })).toThrow();
    expect(() => Schema.decodeUnknownSync(CacheWindowsWrite, strict)({ canvas, cacheWindowMinutes: 1.5 })).toThrow();
    expect(() => Schema.decodeUnknownSync(CacheWindowsWrite, strict)({ canvas, cacheWindowMinutes: 30, idleNudge: true })).toThrow();
    // The cache mode alone is a change; a mode that is not one of the four is refused.
    expect(Schema.decodeUnknownSync(CacheWindowsWrite, strict)({ canvas, cacheMode: "manual" })).toEqual({ canvas, cacheMode: "manual" });
    expect(() => Schema.decodeUnknownSync(CacheWindowsWrite, strict)({ canvas, cacheMode: "never" })).toThrow();
  });

  it("decodes cache windows closed: an undeclared harness, an excess key or a window out of bounds is refused", () => {
    const good = { machine: "mini", cacheWindowMinutes: 60, harness: { claude: 5 } };
    expect(decodeWindows(good)).toEqual(good);
    expect(() => decodeWindows({ ...good, harness: { "made-up": 5 } })).toThrow();
    expect(() => decodeWindows({ ...good, harness: { claude: 0 } })).toThrow();
    expect(() => decodeWindows({ ...good, idleNudge: true })).toThrow();
    // A machine on a build from before the cache mode answers without one.
    expect(decodeWindows({ ...good, cacheMode: "auto" })).toEqual({ ...good, cacheMode: "auto" });
    expect(() => decodeWindows({ ...good, cacheMode: "never" })).toThrow();
  });

  it("bounds every failure field that crosses as detail", () => {
    const where = { machine: PEER, operationId: "op-1", message: "fine" };
    expect(() => new SettingsNoSeatHere(where)).not.toThrow();
    expect(() => new SettingsNoSeatHere({ ...where, machine: "../etc" })).toThrow();
    expect(() => new SettingsNoSeatHere({ ...where, operationId: "op 1; x" })).toThrow();
    expect(() => new SettingsNoSeatHere({ ...where, message: "x".repeat(1025) })).toThrow();
  });
});

describe("settings channel answer, over a real session pair", () => {
  /** The editing machine's typed client asks this machine's real channel across the pair. */
  const answering = async (nodes: ReadonlyArray<Node>, editorOf: "editor" | "self", asker: LinkHello = EDITOR_HELLO) => {
    const f = await runtimeWith(nodes, editorOf);
    const channel = await f.runtime.runPromise(makeSettingsChannel());
    const { left } = pair({ left: asker, right: helloOf(THIS_MACHINE, "studio-installation"), leftChannel: asking(), rightChannel: channel, run: f.run });
    f.held.session = left;
    await left.ready;
    const call = <A>(use: (client: LinkClient<typeof SettingsLink>) => Effect.Effect<A, unknown>) =>
      Effect.flatMap(linkClient(SettingsLink), use);
    const ask = <A>(use: (client: LinkClient<typeof SettingsLink>) => Effect.Effect<A, unknown>) =>
      f.runtime.runPromise(call(use));
    const refused = <A>(use: (client: LinkClient<typeof SettingsLink>) => Effect.Effect<A, unknown>) =>
      f.runtime.runPromise(Effect.flip(call(use)));
    return { ...f, channel, ask, refused, left };
  };

  it("answers providers from this machine's settings, with its name and no value", async () => {
    const f = await answering([here], "editor");
    const answer = await f.ask((client) => client.ProvidersRead(THIS_MACHINE, { canvas }, { operationId: "op-settings-1" }));
    expect(answer.machine).toBe(THIS_MACHINE);
    expect(answer.credentials.openai).toEqual({ apiKey: true });
    expect(answer.credentials.openrouter).toEqual({ apiKey: true, managementApiKey: false });
    expect(JSON.stringify(answer)).not.toMatch(/sk-secret-value|example\.test/);
  });

  it("sets the named values and answers them read back", async () => {
    const f = await answering([here], "editor");
    const providers = await f.ask((client) => client.ProvidersWrite(THIS_MACHINE,
      { canvas, enabledSources: ["codex"] }, { operationId: "op-write-1" }));
    expect(f.patch).toHaveBeenCalledWith({ providers: { enabledSources: ["codex"] } });
    expect(providers.machine).toBe(THIS_MACHINE);
    const record = await f.ask((client) => client.StartupWrite(THIS_MACHINE,
      { canvas, supervisedPreferred: true }, { operationId: "op-write-2" }));
    expect(f.setMachinePreferences).toHaveBeenCalledWith({ supervisedPreferred: true });
    expect(record).toEqual({ machine: THIS_MACHINE, supervisedPreferred: true });
  });

  it("answers the cache windows, and a write's windows read back", async () => {
    const f = await answering([here], "editor");
    const op = { operationId: "op-cw" };
    expect(await f.ask((client) => client.CacheWindowsRead(THIS_MACHINE, { canvas }, op)))
      .toEqual({ machine: THIS_MACHINE, cacheWindowMinutes: 60, harness: {}, cacheMode: "hybrid" });
    const written = await f.ask((client) => client.CacheWindowsWrite(THIS_MACHINE,
      { canvas, cacheWindowMinutes: 30, harness: { claude: 5 } }, op));
    expect(f.patch).toHaveBeenCalledWith({ offboard: { cacheWindowMinutes: 30, harness: { claude: { cacheWindowMinutes: 5 } } } });
    expect(written).toEqual({ machine: THIS_MACHINE, cacheWindowMinutes: 30, harness: { claude: 5 }, cacheMode: "hybrid" });
    // A harness set to null follows the machine's window again.
    expect(await f.ask((client) => client.CacheWindowsWrite(THIS_MACHINE, { canvas, harness: { claude: null } }, op)))
      .toEqual({ machine: THIS_MACHINE, cacheWindowMinutes: 30, harness: {}, cacheMode: "hybrid" });
    // The mode is the machine's, set on its own and read back.
    expect(await f.ask((client) => client.CacheWindowsWrite(THIS_MACHINE, { canvas, cacheMode: "auto" }, op)))
      .toEqual({ machine: THIS_MACHINE, cacheWindowMinutes: 30, harness: {}, cacheMode: "auto" });
    expect(f.patch).toHaveBeenLastCalledWith({ offboard: { cacheMode: "auto" } });
  });

  it("admits only the pinned editor of a canvas with a seat here, as typed failures", async () => {
    const read = (client: LinkClient<typeof SettingsLink>) =>
      client.StartupWrite(THIS_MACHINE, { canvas, supervisedPreferred: true }, { operationId: "op-settings-1" });
    const stranger = await answering([here], "editor", helloOf("macbook", "stranger-installation"));
    const pin = await stranger.refused(read);
    expect(Schema.is(SettingsLinkFailure)(pin)).toBe(true);
    expect(pin).toMatchObject({ _tag: "SettingsPeerNotPinned", operationId: "op-settings-1" });
    expect(stranger.setMachinePreferences).not.toHaveBeenCalled();
    expect(await (await answering([here], "self")).refused(read)).toMatchObject({ _tag: "SettingsCanvasEditorMismatch" });
    expect(await (await answering([seat("elsewhere", { host: "macbook", agentKey: "macbook:elsewhere" })], "editor")).refused(read))
      .toMatchObject({ _tag: "SettingsNoSeatHere" });
  });

  it("closes on a request with any key beyond the payload's own, before admission", async () => {
    const f = await runtimeWith([here], "editor");
    const channel = await f.runtime.runPromise(makeSettingsChannel());
    const raw = facingRaw({ self: helloOf(THIS_MACHINE, "studio-installation"), peer: EDITOR_HELLO, channel, run: f.run });
    await raw.session.ready;
    raw.send({ type: "request", id: "r1", op: "op-1", channel: "settings", tag: "ProvidersRead", payload: { canvas, credential: "sk-1" } });
    const closed = await raw.session.closed;
    expect(closed).toMatchObject({ reason: "frame-invalid" });
    expect(closed.message).toContain("does not match its schema");
  });

  it("refuses an event frame: the channel carries none", async () => {
    const f = await runtimeWith([here], "editor");
    const channel = await f.runtime.runPromise(makeSettingsChannel());
    const raw = facingRaw({ self: helloOf(THIS_MACHINE, "studio-installation"), peer: EDITOR_HELLO, channel, run: f.run });
    await raw.session.ready;
    raw.send({ type: "event", channel: "settings", payload: {} });
    const closed = await raw.session.closed;
    expect(closed).toMatchObject({ reason: "frame-invalid" });
    expect(closed.message).toContain("does not accept events");
  });
});

describe("settings channel request, over a real session pair", () => {
  const remote = seat("on-mini", { host: PEER, agentKey: `${PEER}:on-mini` });

  /** `mini` answers with the contract's typed handlers; the client under test is the service. */
  const client = async (handlers: Partial<SettingsHandlers> = {}) => {
    const held: Held = {};
    const f = await runtimeWith([remote], "self", held);
    held.session = pair({
      left: helloOf(THIS_MACHINE, "studio-installation"),
      right: PEER_HELLO,
      leftChannel: asking(),
      rightChannel: peerOf(handlers),
      run: f.run,
    }).left;
    await held.session.ready;
    const settings = await f.runtime.runPromise(PeerSettings);
    return { ...f, settings };
  };

  /** `mini` writes its answer by hand, as bytes no typed handler could send. */
  const rawClient = async (payload: () => unknown) => {
    const held: Held = {};
    const f = await runtimeWith([remote], "self", held);
    held.session = facingRaw({
      self: helloOf(THIS_MACHINE, "studio-installation"), peer: PEER_HELLO, channel: asking(), run: f.run,
      reply: (frame) => frame.type !== "request" ? undefined
        : { type: "response", id: frame.id, op: frame.op, channel: frame.channel, ok: true, payload: payload() },
    }).session;
    await held.session.ready;
    const settings = await f.runtime.runPromise(PeerSettings);
    return { ...f, settings };
  };

  const mini = { machine: PEER, supervisedPreferred: true };

  it("sends the canvas, the change and the operation id, and answers the record by the machine's own label", async () => {
    const seen: Array<{ readonly payload: unknown; readonly operationId?: string }> = [];
    const c = await client({
      StartupWrite: (payload, context) => {
        seen.push({ payload, ...(context.operationId === undefined ? {} : { operationId: context.operationId }) });
        return Effect.succeed(mini);
      },
    });
    const answer = await c.run(c.settings.setStartup(PEER, true, "op-ask-1"));
    expect(seen).toEqual([{ payload: { canvas, supervisedPreferred: true }, operationId: "op-ask-1" }]);
    expect(answer).toEqual({ ok: true, value: { machine: PEER, name: PEER, supervisedPreferred: true } });
  });

  it("refuses an answer from another machine or outside the shape as one typed failure", async () => {
    const other = await rawClient(() => ({ machine: "elsewhere", supervisedPreferred: true }));
    expect(await other.run(other.settings.record(PEER, "op-2"))).toMatchObject({
      ok: false, error: { reason: "failed", failure: "SettingsNotFromItsMachine", operationId: "op-2" },
    });
    const bad = await rawClient(() => ({ ...mini, name: "renamed" }));
    expect(await bad.run(bad.settings.record(PEER, "op-3"))).toMatchObject({
      ok: false, error: { reason: "failed", failure: "SettingsAnswerRefused" },
    });
  });

  it("sends a cache windows change as minutes, a harness that follows again as null, and answers it read back", async () => {
    const seen: unknown[] = [];
    const c = await client({
      CacheWindowsWrite: (payload) => {
        seen.push(payload);
        return Effect.succeed({ machine: PEER, cacheWindowMinutes: 30, harness: { codex: 10 } });
      },
    });
    const answer = await c.run(c.settings.setCacheWindows(PEER, {
      cacheWindowMinutes: 30, harness: { codex: { cacheWindowMinutes: 10 }, claude: null },
    }, "op-cw-1"));
    expect(seen).toEqual([{ canvas, cacheWindowMinutes: 30, harness: { codex: 10, claude: null } }]);
    expect(answer).toEqual({ ok: true, value: { machine: PEER, cacheWindowMinutes: 30, harness: { codex: 10 } } });
  });

  it("refuses cache windows outside the shape as one typed failure, and keeps the link open", async () => {
    for (const bad of [
      { machine: PEER, cacheWindowMinutes: 60, harness: { "made-up": 5 } },
      { machine: PEER, cacheWindowMinutes: 0, harness: {} },
      { machine: PEER, cacheWindowMinutes: 60, harness: {}, idleNudge: true },
    ]) {
      const c = await rawClient(() => bad);
      expect(await c.run(c.settings.cacheWindows(PEER, "op-cw-2"))).toMatchObject({
        ok: false, error: { reason: "failed", failure: "SettingsAnswerRefused", operationId: "op-cw-2" },
      });
    }
  });

  it("carries the answering machine's typed refusal, and asks nothing with no seat there", async () => {
    const c = await client({
      ProvidersRead: () => Effect.fail(new SettingsNoSeatHere({ machine: PEER, operationId: "op-4", message: "This canvas has no seat on this machine." })),
    });
    expect(await c.run(c.settings.providers(PEER, "op-4"))).toMatchObject({
      ok: false, error: { reason: "failed", failure: "SettingsNoSeatHere", operationId: "op-4" },
    });
    const none = await runtimeWith([here], "self");
    const absent = await none.runtime.runPromise(PeerSettings);
    expect(await none.run(absent.record(PEER))).toMatchObject({ ok: false, error: { reason: "unreachable", failure: "NoPathToMachine" } });
  });
});
