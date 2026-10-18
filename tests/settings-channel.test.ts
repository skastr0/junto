import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeError } from "../src/main/junto/failure-encode";
import { HostsService } from "../src/main/junto/hosts/service";
import { MachineLink } from "../src/main/junto/link/service";
import { type LinkChannelContext, LinkRequestFailed } from "../src/main/junto/link/types";
import { MachineRepository, makeMachineRepositoryLive } from "../src/main/junto/machines/repository";
import { ModelService } from "../src/main/junto/model/service";
import { makePeerSettingsClient } from "../src/main/junto/settings/link-client";
import { makeSettingsChannel } from "../src/main/junto/settings/link-channel";
import {
  decodeLinkCacheWindows,
  decodeLinkProviders,
  decodeLinkSettingsRequest,
  SettingsLinkFailure,
  SettingsNoSeatHere,
  wireProviders,
} from "../src/main/junto/settings/link-wire";
import { SettingsService } from "../src/main/junto/settings/service";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { ObservabilityLoggerLive } from "../src/main/junto/observability/logger";
import { WorkRepositoryLive } from "../src/main/junto/work/repository";
import { InstallationId } from "../src/shared/installation-id";
import { asCanvasName, type Node } from "../src/shared/model";
import { RemoteHost } from "../src/shared/remote-hosts";
import { PROVIDER_SECRET_FIELDS, PROVIDER_SECTION_KEYS } from "../src/shared/settings";
import { THIS_MACHINE } from "./support/machines";
import { seat } from "./support/model-nodes";
import { ModelStoresLive, seedCanvas } from "./support/seed-canvas";
import { clearMachines, seedThisMachine } from "./support/seed-this-machine";

const installation = Schema.decodeUnknownSync(InstallationId);
const editor = installation("editor-installation");
const canvas = asCanvasName("settings-canvas");
const PEER = "mini";

/** A machine's settings as its core holds them, a secret value included. */
const stored = () => ({
  machine: { name: THIS_MACHINE, supervisedPreferred: false },
  providers: {
    enabledSources: ["claude"],
    hermesHostSnapshots: false,
    openai: { apiKey: "sk-secret-value", baseUrl: "https://example.test" },
    openrouter: { apiKeyConfigured: true },
  },
});

const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => seedThisMachine());
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  clearMachines();
});

const runtimeWith = async (nodes: ReadonlyArray<Node>, canvasEditor: "editor" | "self") => {
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
  const runtime = ManagedRuntime.make(Layer.mergeAll(settingsLayer, Layer.provideMerge(ModelStoresLive, repositories)));
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
  return { runtime, patch, setMachinePreferences };
};

const context: LinkChannelContext = {
  peer: { build: "same-build", installationId: editor, machineName: "macbook" },
  sessionId: "admitted-link",
  operationId: "op-settings-1",
  signal: new AbortController().signal,
  sendEvent: () => Effect.void,
} as unknown as LinkChannelContext;

const here = seat("here", { host: THIS_MACHINE, agentKey: `${THIS_MACHINE}:here` });

describe("settings channel wire", () => {
  it("carries each declared credential as set or not, never a value or an undeclared field", () => {
    const wire = wireProviders({
      machine: "mini",
      enabledSources: ["claude", "claude"],
      hermesHostSnapshots: true,
      credentials: { openai: { apiKey: true, baseUrl: true }, extra: { token: true } } as never,
    });
    expect(Object.keys(wire.credentials)).toEqual([...PROVIDER_SECTION_KEYS]);
    for (const section of PROVIDER_SECTION_KEYS)
      expect(Object.keys(wire.credentials[section as keyof typeof wire.credentials])).toEqual([...PROVIDER_SECRET_FIELDS[section]]);
    expect(wire.credentials.openai).toEqual({ apiKey: true });
    expect(wire.enabledSources).toEqual(["claude"]);
    expect(JSON.stringify(wire)).not.toContain("extra");
  });

  it("decodes closed: a value, an excess key or an undeclared section is refused", () => {
    const good = JSON.parse(JSON.stringify(wireProviders({ machine: "mini", enabledSources: [], hermesHostSnapshots: false, credentials: {} })));
    expect(decodeLinkProviders(good).credentials.openai).toEqual({ apiKey: false });
    expect(() => decodeLinkProviders({ ...good, credentials: { ...good.credentials, openai: { apiKey: "sk-1" } } })).toThrow();
    expect(() => decodeLinkProviders({ ...good, credentials: { ...good.credentials, extra: {} } })).toThrow();
    expect(() => decodeLinkProviders({ ...good, path: "/Users/x" })).toThrow();
  });

  it("names a canvas and a closed change: credentials, a name, a toggle or an empty write are refused", () => {
    expect(decodeLinkSettingsRequest({ _tag: "ProvidersRead", canvas })).toEqual({ _tag: "ProvidersRead", canvas });
    expect(() => decodeLinkSettingsRequest({ _tag: "ProvidersWrite", canvas, openai: { apiKey: "sk-1" } })).toThrow();
    expect(() => decodeLinkSettingsRequest({ _tag: "ProvidersWrite", canvas })).toThrow();
    expect(() => decodeLinkSettingsRequest({ _tag: "ProvidersWrite", canvas, enabledSources: ["claude", "claude"] })).toThrow();
    expect(() => decodeLinkSettingsRequest({ _tag: "StartupWrite", canvas, supervisedPreferred: true, name: "x" })).toThrow();
    expect(() => decodeLinkSettingsRequest({ _tag: "StartupToggle", canvas })).toThrow();
  });

  it("decodes a cache windows change closed: an empty write, an undeclared harness or a window out of bounds is refused", () => {
    expect(decodeLinkSettingsRequest({ _tag: "CacheWindowsRead", canvas })).toEqual({ _tag: "CacheWindowsRead", canvas });
    expect(decodeLinkSettingsRequest({ _tag: "CacheWindowsWrite", canvas, harness: { codex: null } }))
      .toEqual({ _tag: "CacheWindowsWrite", canvas, harness: { codex: null } });
    expect(() => decodeLinkSettingsRequest({ _tag: "CacheWindowsWrite", canvas })).toThrow();
    expect(() => decodeLinkSettingsRequest({ _tag: "CacheWindowsWrite", canvas, harness: {} })).toThrow();
    expect(() => decodeLinkSettingsRequest({ _tag: "CacheWindowsWrite", canvas, harness: { "made-up": 5 } })).toThrow();
    expect(() => decodeLinkSettingsRequest({ _tag: "CacheWindowsWrite", canvas, cacheWindowMinutes: 0 })).toThrow();
    expect(() => decodeLinkSettingsRequest({ _tag: "CacheWindowsWrite", canvas, cacheWindowMinutes: 1.5 })).toThrow();
    expect(() => decodeLinkSettingsRequest({ _tag: "CacheWindowsWrite", canvas, cacheWindowMinutes: 30, idleNudge: true })).toThrow();
    // The cache mode alone is a change; a mode that is not one of the four is refused.
    expect(decodeLinkSettingsRequest({ _tag: "CacheWindowsWrite", canvas, cacheMode: "manual" }))
      .toEqual({ _tag: "CacheWindowsWrite", canvas, cacheMode: "manual" });
    expect(() => decodeLinkSettingsRequest({ _tag: "CacheWindowsWrite", canvas, cacheMode: "never" })).toThrow();
  });

  it("decodes cache windows closed: an undeclared harness, an excess key or a window out of bounds is refused", () => {
    const good = { machine: "mini", cacheWindowMinutes: 60, harness: { claude: 5 } };
    expect(decodeLinkCacheWindows(good)).toEqual(good);
    expect(() => decodeLinkCacheWindows({ ...good, harness: { "made-up": 5 } })).toThrow();
    expect(() => decodeLinkCacheWindows({ ...good, harness: { claude: 0 } })).toThrow();
    expect(() => decodeLinkCacheWindows({ ...good, idleNudge: true })).toThrow();
    // A machine on a build from before the cache mode answers without one.
    expect(decodeLinkCacheWindows({ ...good, cacheMode: "auto" })).toEqual({ ...good, cacheMode: "auto" });
    expect(() => decodeLinkCacheWindows({ ...good, cacheMode: "never" })).toThrow();
  });
});

describe("settings channel answer", () => {
  it("answers providers from this machine's settings, with its name and no value", async () => {
    const f = await runtimeWith([here], "editor");
    const channel = await f.runtime.runPromise(makeSettingsChannel());
    const answer = decodeLinkProviders(await f.runtime.runPromise(channel.handleRequest!(context, { _tag: "ProvidersRead", canvas })));
    expect(answer.machine).toBe(THIS_MACHINE);
    expect(answer.credentials.openai).toEqual({ apiKey: true });
    expect(answer.credentials.openrouter).toEqual({ apiKey: true, managementApiKey: false });
    expect(JSON.stringify(answer)).not.toMatch(/sk-secret-value|example\.test/);
  });

  it("sets the named values and answers them read back", async () => {
    const f = await runtimeWith([here], "editor");
    const channel = await f.runtime.runPromise(makeSettingsChannel());
    const providers = decodeLinkProviders(await f.runtime.runPromise(
      channel.handleRequest!(context, { _tag: "ProvidersWrite", canvas, hermesHostSnapshots: true })));
    expect(f.patch).toHaveBeenCalledWith({ providers: { hermesHostSnapshots: true } });
    expect(providers.hermesHostSnapshots).toBe(true);
    const record = await f.runtime.runPromise(
      channel.handleRequest!(context, { _tag: "StartupWrite", canvas, supervisedPreferred: true }));
    expect(f.setMachinePreferences).toHaveBeenCalledWith({ supervisedPreferred: true });
    expect(record).toEqual({ machine: THIS_MACHINE, supervisedPreferred: true });
  });

  it("answers the cache windows, and a write's windows read back", async () => {
    const f = await runtimeWith([here], "editor");
    const channel = await f.runtime.runPromise(makeSettingsChannel());
    const ask = (request: Record<string, unknown>) =>
      f.runtime.runPromise(channel.handleRequest!(context, { canvas, ...request } as never)).then(decodeLinkCacheWindows);
    expect(await ask({ _tag: "CacheWindowsRead" })).toEqual({ machine: THIS_MACHINE, cacheWindowMinutes: 60, harness: {}, cacheMode: "hybrid" });
    const written = await ask({ _tag: "CacheWindowsWrite", cacheWindowMinutes: 30, harness: { claude: 5 } });
    expect(f.patch).toHaveBeenCalledWith({ offboard: { cacheWindowMinutes: 30, harness: { claude: { cacheWindowMinutes: 5 } } } });
    expect(written).toEqual({ machine: THIS_MACHINE, cacheWindowMinutes: 30, harness: { claude: 5 }, cacheMode: "hybrid" });
    expect(await ask({ _tag: "CacheWindowsRead" })).toEqual(written);
    // A harness set to null follows the machine's window again.
    expect(await ask({ _tag: "CacheWindowsWrite", harness: { claude: null } }))
      .toEqual({ machine: THIS_MACHINE, cacheWindowMinutes: 30, harness: {}, cacheMode: "hybrid" });
    // The mode is the machine's, set on its own and read back.
    expect(await ask({ _tag: "CacheWindowsWrite", cacheMode: "auto" }))
      .toEqual({ machine: THIS_MACHINE, cacheWindowMinutes: 30, harness: {}, cacheMode: "auto" });
    expect(f.patch).toHaveBeenLastCalledWith({ offboard: { cacheMode: "auto" } });
  });

  it("admits a cache windows write only as it admits any other, and changes nothing when it refuses", async () => {
    const f = await runtimeWith([here], "editor");
    const channel = await f.runtime.runPromise(makeSettingsChannel());
    const stranger = { ...context, peer: { ...context.peer, installationId: installation("stranger-installation") } };
    expect(await f.runtime.runPromise(Effect.flip(channel.handleRequest!(stranger,
      { _tag: "CacheWindowsWrite", canvas, cacheWindowMinutes: 30 })))).toMatchObject({ _tag: "SettingsPeerNotPinned" });
    expect(f.patch).not.toHaveBeenCalled();
  });

  it("refuses an unpinned peer, another canvas editor, and a canvas with no seat here, and changes nothing", async () => {
    const run = async (nodes: ReadonlyArray<Node>, editorOf: "editor" | "self", caller = context) => {
      const f = await runtimeWith(nodes, editorOf);
      const channel = await f.runtime.runPromise(makeSettingsChannel());
      const failure = await f.runtime.runPromise(Effect.flip(
        channel.handleRequest!(caller, { _tag: "StartupWrite", canvas, supervisedPreferred: true })));
      // Every failure crosses under the channel's closed failure schema.
      expect(Schema.decodeUnknownSync(SettingsLinkFailure)(Schema.encodeSync(SettingsLinkFailure)(failure as never))).toBeTruthy();
      expect(f.setMachinePreferences).not.toHaveBeenCalled();
      return failure as { readonly _tag: string; readonly operationId?: string };
    };
    const stranger = { ...context, peer: { ...context.peer, installationId: installation("stranger-installation") } };
    expect(await run([here], "editor", stranger)).toMatchObject({ _tag: "SettingsPeerNotPinned", operationId: "op-settings-1" });
    expect(await run([here], "self")).toMatchObject({ _tag: "SettingsCanvasEditorMismatch" });
    expect(await run([seat("elsewhere", { host: "macbook", agentKey: "macbook:elsewhere" })], "editor"))
      .toMatchObject({ _tag: "SettingsNoSeatHere" });
  });
});

describe("settings channel request", () => {
  const remote = seat("on-mini", { host: PEER, agentKey: `${PEER}:on-mini` });

  const client = async (nodes: ReadonlyArray<Node>, respond: (payload: unknown) => Effect.Effect<unknown, unknown>) => {
    const f = await runtimeWith(nodes, "self");
    const host = Schema.decodeUnknownSync(RemoteHost)({
      id: PEER, label: "Mini", isThisMachine: false, sshEndpoint: "mini", capabilities: ["terminal"],
    });
    const request = vi.fn((_machine: string, _channel: string, payload: unknown, _options?: { readonly operationId?: string }) =>
      respond(payload));
    const unused = Effect.die("unused machine operation");
    const disconnect = vi.fn(() => Effect.void);
    const links = MachineLink.of({
      setChannels: () => unused, listen: () => unused,
      connect: () => Effect.succeed({ machineName: PEER, installationId: editor, boundAt: "2026-10-17" }),
      connectSetup: () => unused, disconnect: disconnect as never, peerBuild: () => unused,
      sendEvent: () => unused, request: request as never,
    });
    const hosts = HostsService.of({
      get: () => Effect.succeed(host), list: unused, doctor: unused, doctorSnapshot: unused,
      upsert: () => unused, remove: () => unused, test: () => unused,
    } as never);
    const peer = makePeerSettingsClient();
    const run = <A>(effect: Effect.Effect<A, never, any>) => f.runtime.runPromise(effect.pipe(
      Effect.provideService(HostsService, hosts), Effect.provideService(MachineLink, links),
      Effect.provide(ObservabilityLoggerLive),
    ) as Effect.Effect<A>);
    return { peer, run, request, disconnect };
  };

  const mini = { machine: PEER, supervisedPreferred: true };

  it("sends the canvas, the change and the operation id, and answers the record by the machine's own label", async () => {
    const c = await client([remote], () => Effect.succeed(mini));
    const answer = await c.run(c.peer.setStartup(PEER, true, "op-ask-1"));
    expect(c.request).toHaveBeenCalledWith(PEER, "settings", { _tag: "StartupWrite", canvas, supervisedPreferred: true }, { operationId: "op-ask-1" });
    expect(answer).toEqual({ ok: true, value: { machine: PEER, name: PEER, supervisedPreferred: true } });
  });

  it("refuses an answer from another machine or outside the shape as one typed failure", async () => {
    const other = await client([remote], () => Effect.succeed({ machine: "elsewhere", supervisedPreferred: true }));
    expect(await other.run(other.peer.record(PEER, "op-2"))).toMatchObject({
      ok: false, error: { reason: "failed", failure: "SettingsNotFromItsMachine", operationId: "op-2" },
    });
    const bad = await client([remote], () => Effect.succeed({ ...mini, name: "renamed" }));
    expect(await bad.run(bad.peer.record(PEER, "op-3"))).toMatchObject({
      ok: false, error: { reason: "failed", failure: "SettingsAnswerRefused" },
    });
  });

  it("sends a cache windows change as minutes, a harness that follows again as null, and answers it read back", async () => {
    const c = await client([remote], () => Effect.succeed({ machine: PEER, cacheWindowMinutes: 30, harness: { codex: 10 } }));
    const answer = await c.run(c.peer.setCacheWindows(PEER, {
      cacheWindowMinutes: 30, harness: { codex: { cacheWindowMinutes: 10 }, claude: null },
    }, "op-cw-1"));
    expect(c.request).toHaveBeenCalledWith(PEER, "settings",
      { _tag: "CacheWindowsWrite", canvas, cacheWindowMinutes: 30, harness: { codex: 10, claude: null } }, { operationId: "op-cw-1" });
    expect(answer).toEqual({ ok: true, value: { machine: PEER, cacheWindowMinutes: 30, harness: { codex: 10 } } });
  });

  it("refuses cache windows outside the shape as one typed failure, and keeps the link open", async () => {
    for (const bad of [
      { machine: PEER, cacheWindowMinutes: 60, harness: { "made-up": 5 } },
      { machine: PEER, cacheWindowMinutes: 0, harness: {} },
      { machine: PEER, cacheWindowMinutes: 60, harness: {}, idleNudge: true },
    ]) {
      const c = await client([remote], () => Effect.succeed(bad));
      expect(await c.run(c.peer.cacheWindows(PEER, "op-cw-2"))).toMatchObject({
        ok: false, error: { reason: "failed", failure: "SettingsAnswerRefused", operationId: "op-cw-2" },
      });
      expect(c.disconnect).not.toHaveBeenCalled();
    }
  });

  it("carries the answering machine's typed refusal, and asks nothing with no seat there", async () => {
    const cause = new SettingsNoSeatHere({ machine: PEER, operationId: "op-4", message: "This canvas has no seat on this machine." });
    const refused = await client([remote], () => Effect.fail(new LinkRequestFailed({
      machine: PEER, channel: "settings", operationId: "op-4",
      failure: encodeError(cause, { machine: PEER, operationId: "op-4" }), detail: cause, message: cause.message,
    } as never)));
    expect(await refused.run(refused.peer.providers(PEER, "op-4"))).toMatchObject({
      ok: false, error: { reason: "failed", failure: "SettingsNoSeatHere", operationId: "op-4" },
    });
    const none = await client([here], () => Effect.succeed(mini));
    expect(await none.run(none.peer.record(PEER))).toMatchObject({ ok: false, error: { reason: "unreachable", failure: "NoPathToMachine" } });
    expect(none.request).not.toHaveBeenCalled();
  });
});
