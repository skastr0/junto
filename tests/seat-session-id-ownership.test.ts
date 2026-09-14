import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Layer, ManagedRuntime, Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CanvasesLive, CanvasesService } from "../src/main/vellum-command/canvases";
import { makeStateEngineLive } from "../src/main/vellum-command/state/engine";
import { WorkRepositoryLive } from "../src/main/vellum-command/work/repository";
import { StationRepositoryLive } from "../src/main/vellum-command/station/repository";
import { StationFleetTargetRepository, StationFleetTargetRepositoryLive } from "../src/main/vellum-command/station/fleet-target-repository";
import { makeSettingsLive, SettingsService } from "../src/main/vellum-command/settings/service";
import { makeContentServiceLive } from "../src/main/vellum-command/content/service";
import { makeInstallOpsLive } from "../src/main/vellum-command/install-ops/engine";
import { applyMirrorLaw, type CanvasDoc } from "../src/shared/canvas";
import { InstallationId } from "../src/shared/installation-id";
import { managedAgentEther } from "./helpers/managed-agent-ether";

// Keep the public writer's app-runtime boundary while executing its actual
// Effect against a disposable, fully composed canvas authority store.
const app = vi.hoisted(() => ({ runPromise: vi.fn() }));
vi.mock("../src/main/runtime", () => ({ AppRuntime: app }));
import { writeSeatSessionId } from "../src/main/vellum-command/term/seat-session-id";

const SESSION = "1787761861883-1787761861883720000-7afaf80c8f5acd35";
const OTHER_SESSION = "1787761862883-1787761862883720000-97d25f70d04d6c5e";

const agentDoc = (
  bindingId: string,
  options: { readonly harness?: "fx" | "muse"; readonly host?: string; readonly sessionId?: string } = {},
): CanvasDoc => {
  const ether = managedAgentEther(`command:${bindingId}`, { bindingId, harness: options.harness ?? "fx", host: options.host ?? "command" });
  return applyMirrorLaw({
    nodes: [{
      id: "agent", type: "text", text: "Agent", x: 0, y: 0, width: 240, height: 120,
      ether: { ...ether, terminal: { ...ether.terminal, ...(options.sessionId ? { sessionId: options.sessionId } : {}) } },
    }],
    edges: [],
  });
};

const makeRuntime = (root: string) => ManagedRuntime.make(Layer.provideMerge(
  CanvasesLive,
  Layer.provideMerge(
    Layer.mergeAll(
      WorkRepositoryLive, StationRepositoryLive, StationFleetTargetRepositoryLive,
      makeSettingsLive({ ensureDefaultCommandCenter: false }),
      makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true }),
    ),
    Layer.mergeAll(makeStateEngineLive(join(root, "state.db")), makeInstallOpsLive(join(root, "install-ops.db"))),
  ),
));

let runtime: ReturnType<typeof makeRuntime> | undefined;
let root: string | undefined;

const fixture = async () => {
  root = await mkdtemp(join(tmpdir(), "vc-session-ownership-"));
  const live = runtime = makeRuntime(root);
  app.runPromise.mockImplementation((effect) => live.runPromise(effect));
  const settings = await live.runPromise(SettingsService);
  await live.runPromise(settings.setStationTopology({ role: "command-center", hostId: "command", supervisedPreferred: true }));
  const canvases = await live.runPromise(CanvasesService);
  return {
    runtime: live,
    canvases,
    write: (name: string, doc: CanvasDoc) => live.runPromise(canvases.write(name, doc)),
    sessionId: async (name: string) => {
      const snapshot = await live.runPromise(canvases.authoritySnapshot());
      return snapshot.documents.get(name)?.nodes[0]?.ether?.terminal?.sessionId;
    },
  };
};

const capture = (canvasName: string, bindingId: string, sessionId = SESSION, harness = "fx", isCurrent = () => true) =>
  writeSeatSessionId({ canvasName, nodeId: "agent", sessionId, onlyIfAbsent: true, capture: { bindingId, harness, isCurrent } });

afterEach(async () => {
  await runtime?.dispose();
  runtime = undefined;
  app.runPromise.mockReset();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

describe("captured session persistence ownership", () => {
  it("rejects a session already owned on another canvas after the original writer completed", async () => {
    const f = await fixture();
    await f.write("first", agentDoc("a"));
    await f.write("second", agentDoc("b", { host: "command" }));
    expect(await capture("first", "a")).toEqual({ ok: true });

    expect(await capture("second", "b")).toMatchObject({ ok: false, reason: expect.stringContaining("another seat") });
    expect(await f.sessionId("first")).toBe(SESSION);
    expect(await f.sessionId("second")).toBeUndefined();
  });

  it("atomically permits only one of two concurrent cross-canvas claims", async () => {
    const f = await fixture();
    await f.write("first", agentDoc("a"));
    await f.write("second", agentDoc("b"));

    const results = await Promise.all([capture("first", "a"), capture("second", "b")]);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const ids = [await f.sessionId("first"), await f.sessionId("second")];
    expect(ids.filter((id) => id === SESSION)).toHaveLength(1);
  });

  it("accepts distinct sessions and does not collide identical text from another harness", async () => {
    const f = await fixture();
    await f.write("first", agentDoc("a"));
    await f.write("second", agentDoc("b"));
    await f.write("muse", agentDoc("c", { harness: "muse" }));

    expect(await capture("first", "a")).toEqual({ ok: true });
    expect(await capture("second", "b", OTHER_SESSION)).toEqual({ ok: true });
    expect(await capture("muse", "c", SESSION, "muse")).toEqual({ ok: true });
    expect(await f.sessionId("second")).toBe(OTHER_SESSION);
    expect(await f.sessionId("muse")).toBe(SESSION);
  });

  it("does not collide a session on another installation or capture its projected seat", async () => {
    const f = await fixture();
    const fleet = await f.runtime.runPromise(StationFleetTargetRepository);
    await f.runtime.runPromise(fleet.bind({ hostId: "local", stationInstallationId: Schema.decodeUnknownSync(InstallationId)("install_remote") }));
    await f.write("remote", agentDoc("remote-seat", { host: "local", sessionId: SESSION }));
    await f.write("local", agentDoc("local-seat"));

    expect(await capture("local", "local-seat")).toEqual({ ok: true });
    expect(await capture("remote", "remote-seat", OTHER_SESSION)).toMatchObject({ ok: false, reason: expect.stringContaining("another installation") });
    expect(await f.sessionId("remote")).toBe(SESSION);
  });

  it("updates the same seat's cross-canvas aliases together", async () => {
    const f = await fixture();
    await f.write("first", agentDoc("shared"));
    await f.write("second", agentDoc("shared", { host: "command" }));

    expect(await capture("first", "shared")).toEqual({ ok: true });
    expect(await f.sessionId("first")).toBe(SESSION);
    expect(await f.sessionId("second")).toBe(SESSION);
  });

  it("refuses stale generations, changed bindings, changed harnesses and existing named sessions", async () => {
    const f = await fixture();
    await f.write("seat", agentDoc("a"));
    expect(await capture("seat", "a", SESSION, "fx", () => false)).toMatchObject({ ok: false });
    expect(await capture("seat", "replaced")).toMatchObject({ ok: false });
    expect(await capture("seat", "a", SESSION, "muse")).toMatchObject({ ok: false });
    expect(await f.sessionId("seat")).toBeUndefined();

    expect(await capture("seat", "a")).toEqual({ ok: true });
    expect(await capture("seat", "a", OTHER_SESSION)).toMatchObject({ ok: false });
    expect(await f.sessionId("seat")).toBe(SESSION);
  });

  it("retains the non-capture writer used by provisioned harnesses", async () => {
    const f = await fixture();
    await f.write("seat", agentDoc("a"));
    expect(await writeSeatSessionId({ canvasName: "seat", nodeId: "agent", sessionId: SESSION })).toEqual({ ok: true });
    expect(await writeSeatSessionId({ canvasName: "seat", nodeId: "agent", sessionId: OTHER_SESSION })).toEqual({ ok: true });
    expect(await f.sessionId("seat")).toBe(OTHER_SESSION);
  });
});
