import { CrewRepositoryLive } from "../src/main/junto/work/crew-repository";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect, Layer, ManagedRuntime, Schema } from "effect";
import { CanvasesLive, CanvasesService } from "../src/main/junto/canvases";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { WorkRepositoryLive } from "../src/main/junto/work/repository";
import { StationRepository, StationRepositoryLive } from "../src/main/junto/station/repository";
import { StationFleetTargetRepositoryLive } from "../src/main/junto/station/fleet-target-repository";
import { StationLivePeerRegistryLive } from "../src/main/junto/station/session-registry";
import { SettingsLive, SettingsService } from "../src/main/junto/settings/service";
import { WorkLive } from "../src/main/junto/work/service";
import { makeContentServiceLive } from "../src/main/junto/content/service";
import { executeOverseer, type OverseerRuntime } from "../src/main/junto/overseer/dispatch";
import { InstallationId } from "../src/shared/installation-id";
import { RemoteConfiguration } from "../src/shared/station-api";
import { managedAgentEther } from "./helpers/managed-agent-ether";

const caller = { canvasName: "origin", nodeId: "boss" };
const layers = (root: string) => {
  const repositories = Layer.provideMerge(Layer.mergeAll(
    CrewRepositoryLive, WorkRepositoryLive, StationRepositoryLive, StationFleetTargetRepositoryLive,
    SettingsLive, makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true }),
  ), Layer.mergeAll(
    makeStateEngineLive(join(root, "state.db")),
    makeInstallOpsLive(join(root, "install-ops.db")),
  ));
  return Layer.provideMerge(WorkLive, Layer.mergeAll(
    Layer.provideMerge(CanvasesLive, repositories), StationLivePeerRegistryLive,
  ));
};
const makeRuntime = (root: string) => ManagedRuntime.make(layers(root));
let root: string;
let runtime: ReturnType<typeof makeRuntime>;

afterEach(async () => {
  await runtime?.dispose();
  if (root) await rm(root, { recursive: true, force: true });
});

const boot = async () => {
  root = await mkdtemp(join(tmpdir(), "overseer-dispatch-"));
  runtime = makeRuntime(root);
  const settings = await runtime.runPromise(SettingsService);
  await runtime.runPromise(settings.setStationTopology({
    role: "command-center", hostId: "local", supervisedPreferred: false,
  }));
  const canvases = await runtime.runPromise(CanvasesService);
  await runtime.runPromise(canvases.write("origin", {
    nodes: [{
      id: "boss", type: "text", text: "Boss", x: 17, y: -31, width: 240, height: 120,
      ether: managedAgentEther("local:boss"),
    }], edges: [],
  }));
  await runtime.runPromise(canvases.create("target"));
  const toggle = async (overseer: boolean) => {
    const read = await runtime.runPromise(canvases.read("origin"));
    await runtime.runPromise(canvases.canvasOverseerSet({ ...caller, overseer, expectedRevision: read.revision }));
  };
  const adapters: OverseerRuntime = {
    native: vi.fn(() => Effect.succeed({ observed: true })),
    forward: vi.fn<OverseerRuntime["forward"]>((_caller, request) => Effect.succeed({ ok: true, operation: request.operation, data: { forwarded: true } })),
  };
  return { canvases, toggle, adapters };
};

describe("integrated overseer dispatcher", () => {
  it("requires a human grant, authors another canvas without edges, and refuses self deletion", async () => {
    const { canvases, toggle, adapters } = await boot();
    const run = (request: Parameters<typeof executeOverseer>[1]) => runtime.runPromise(executeOverseer(caller, request, adapters));
    expect(await run({ operation: "canvas.list" })).toMatchObject({ ok: false, error: { type: "Forbidden" } });
    await toggle(true);
    expect(await run({ operation: "node.create", args: {
      canvas: "target", node: { type: "text", id: "note", text: "cross-canvas", x: 11, y: -19, width: 200, height: 80 },
    } })).toMatchObject({ ok: true, operation: "node.create" });
    const target = await runtime.runPromise(canvases.read("target"));
    expect(target.doc.nodes[0]).toMatchObject({ id: "note", text: "cross-canvas", x: 11, y: -19 });
    expect(await run({ operation: "node.delete", args: { nodeId: "boss" } })).toMatchObject({ ok: false, error: { type: "Forbidden" } });
    expect(await run({ operation: "canvas.screenshot" })).toEqual({ ok: true, operation: "canvas.screenshot", data: { observed: true } });
    expect(adapters.native).toHaveBeenCalledTimes(1);
    expect(adapters.forward).not.toHaveBeenCalled();
    const wrongSource = Schema.decodeUnknownSync(InstallationId)("different-installation");
    expect(await runtime.runPromise(executeOverseer(caller, { operation: "canvas.list" }, adapters, wrongSource)))
      .toMatchObject({ ok: false, error: { type: "Forbidden" } });
  });

  it("forwards Remote authoring but keeps browser and content resources on the caller installation", async () => {
    const { toggle, adapters } = await boot();
    await toggle(true);
    const stations = await runtime.runPromise(StationRepository);
    const configuration = Schema.decodeUnknownSync(RemoteConfiguration)({
      role: "remote", hostId: "local", agentHostId: "local", commandCenterInstallationId: "cc", supervisedPreferred: false,
    });
    const run = (request: Parameters<typeof executeOverseer>[1]) => runtime.runPromise(
      executeOverseer(caller, request, adapters).pipe(Effect.provideService(StationRepository, {
        ...stations, configuration: Effect.succeed({ configuration, configuredAt: "2026-09-11T00:00:00Z" }),
      })),
    );
    expect(await run({ operation: "canvas.create", args: { canvas: "forwarded" } }))
      .toMatchObject({ ok: true, data: { forwarded: true } });
    expect(await run({ operation: "page.list" })).toMatchObject({ ok: true, data: { observed: true } });
    expect(await run({ operation: "content.ingest", args: { bytesBase64: "aGk=", mediaType: "text/plain" } }))
      .toMatchObject({ ok: true, operation: "content.ingest" });
    expect(adapters.forward).toHaveBeenCalledTimes(1);
    expect(adapters.native).toHaveBeenCalledTimes(1);
  });

  it("keeps secrets on the caller installation and never answers with the value", async () => {
    const { toggle, adapters } = await boot();
    const VALUE = "s3cr3t-never-echoed";
    const held = new Map<string, string>();
    const secrets = () => ({
      backend: "memory",
      save: ({ value, secretId }: { value: string; secretId?: string }) => {
        const id = secretId ?? "5b0f6d0e-2c1a-4b7e-9d3f-8a1c2e4f6a70";
        held.set(id, value);
        return { ok: true as const, secretId: id };
      },
      remove: (secretId: string) => {
        held.delete(secretId);
        return { ok: true as const };
      },
      list: () => [...held.keys()],
    });
    const run = (request: Parameters<typeof executeOverseer>[1], runtimeAdapters: OverseerRuntime = { ...adapters, secrets }) =>
      runtime.runPromise(executeOverseer(caller, request, runtimeAdapters));

    expect(await run({ operation: "secret.put", args: { value: VALUE } }))
      .toMatchObject({ ok: false, error: { type: "Forbidden" } });
    expect(held.size).toBe(0);
    await toggle(true);

    const put = await run({ operation: "secret.put", args: { value: VALUE } });
    expect(put).toEqual({
      ok: true, operation: "secret.put", data: { secretId: "5b0f6d0e-2c1a-4b7e-9d3f-8a1c2e4f6a70", stored: true, backend: "memory" },
    });
    expect(held.get("5b0f6d0e-2c1a-4b7e-9d3f-8a1c2e4f6a70")).toBe(VALUE);
    const bad = await run({ operation: "secret.put", args: { secretId: 7, value: VALUE, [VALUE]: VALUE } });
    expect(bad).toMatchObject({ ok: false, error: { type: "InvalidArguments" } });
    const listed = await run({ operation: "secret.list" });
    expect(listed).toMatchObject({ ok: true, data: { secretIds: ["5b0f6d0e-2c1a-4b7e-9d3f-8a1c2e4f6a70"] } });
    expect(JSON.stringify([put, bad, listed])).not.toContain(VALUE);
    expect(await run({ operation: "secret.delete", args: { secretId: "5b0f6d0e-2c1a-4b7e-9d3f-8a1c2e4f6a70" } }))
      .toMatchObject({ ok: true, data: { deleted: true } });
    expect(held.size).toBe(0);

    expect(await run({ operation: "secret.delete", args: { secretId: "not-a-uuid" } }))
      .toMatchObject({ ok: false, error: { type: "InvalidArguments" } });

    // A Remote keeps its own secrets: nothing is forwarded to Command Center.
    const stations = await runtime.runPromise(StationRepository);
    const configuration = Schema.decodeUnknownSync(RemoteConfiguration)({
      role: "remote", hostId: "local", agentHostId: "local", commandCenterInstallationId: "cc", supervisedPreferred: false,
    });
    expect(await runtime.runPromise(
      executeOverseer(caller, { operation: "secret.put", args: { secretId: "6c1a7e1f-3d2b-4c8f-8e4a-9b2d3f5a7b81", value: VALUE } }, { ...adapters, secrets })
        .pipe(Effect.provideService(StationRepository, {
          ...stations, configuration: Effect.succeed({ configuration, configuredAt: "2026-09-11T00:00:00Z" }),
        })),
    )).toMatchObject({ ok: true, data: { secretId: "6c1a7e1f-3d2b-4c8f-8e4a-9b2d3f5a7b81" } });
    expect(adapters.forward).not.toHaveBeenCalled();
    expect(adapters.native).not.toHaveBeenCalled();
  });

  it("returns the resolver's report for env.doctor, narrowed by node, and edits a region through dispatch", async () => {
    const { canvases, toggle, adapters } = await boot();
    await toggle(true);
    const whole = {
      regions: [{ regionId: "box", regionLabel: "Box", sealed: false, sources: [] }],
      seats: [
        { nodeId: "boss", title: "Boss", regions: ["box"], report: [], folders: [], restartToApply: false },
        { nodeId: "stray", title: "Stray", regions: [], report: [], folders: [], restartToApply: false },
      ],
    };
    const envReport = vi.fn(async (_canvasName: string) => whole);
    const run = (request: Parameters<typeof executeOverseer>[1], runtimeAdapters: OverseerRuntime = { ...adapters, envReport }) =>
      runtime.runPromise(executeOverseer(caller, request, runtimeAdapters));

    expect(await run({ operation: "env.doctor" })).toEqual({ ok: true, operation: "env.doctor", data: whole });
    expect(envReport).toHaveBeenCalledWith("origin");
    expect(await run({ operation: "env.doctor", args: { nodeId: "boss" } })).toMatchObject({
      ok: true, data: { regions: [{ regionId: "box" }], seats: [{ nodeId: "boss" }] },
    });
    expect(await run({ operation: "env.doctor", args: { nodeId: "ghost" } }))
      .toMatchObject({ ok: false, error: { type: "NotFound" } });
    expect(await run({ operation: "env.doctor" }, { ...adapters, envReport: () => Promise.reject(new Error("tool said: hunter2")) }))
      .toEqual({ ok: false, operation: "env.doctor", error: { type: "InternalError", message: "the region environment report could not be produced" } });
    expect(await run({ operation: "env.doctor" }, { ...adapters, envReport: async () => undefined }))
      .toMatchObject({ ok: false, error: { type: "NotFound" } });

    expect(await run({ operation: "node.create", args: {
      node: { type: "group", id: "box", label: "Box", x: 0, y: -200, width: 600, height: 500 },
    } })).toMatchObject({ ok: true });
    expect(await run({ operation: "env.seal", args: { nodeId: "box", sealed: true } }))
      .toMatchObject({ ok: true, operation: "env.seal", data: { nodeId: "box", environment: { sealed: true } } });
    const stored = (await runtime.runPromise(canvases.read("origin"))).doc.nodes.find((node) => node.id === "box");
    expect(stored?.ether?.region?.environment).toEqual({ sealed: true });
    expect(adapters.native).not.toHaveBeenCalled();
  });

  it("interrupts an admitted native effect when the human revokes its grant", async () => {
    const { toggle, adapters } = await boot();
    await toggle(true);
    let entered = false;
    let interrupted = false;
    const native = () => Effect.sync(() => { entered = true; }).pipe(
      Effect.andThen(Effect.never),
      Effect.onInterrupt(() => Effect.sync(() => { interrupted = true; })),
    );
    const pending = runtime.runPromise(executeOverseer(caller, { operation: "canvas.screenshot" }, { ...adapters, native }));
    await vi.waitFor(() => expect(entered).toBe(true));
    await toggle(false);
    expect(await pending).toMatchObject({ ok: false, error: { type: "Forbidden" } });
    expect(interrupted).toBe(true);
  });
});
