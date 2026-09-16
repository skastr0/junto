import { CrewRepositoryLive } from "../src/main/vellum-command/work/crew-repository";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Fiber, Layer, ManagedRuntime, Result } from "effect";
import {
  CanvasesLive,
  CanvasesService,
} from "../src/main/vellum-command/canvases";
import {
  executeOverseerCanvas,
  setOverseerNativeDeleteHooks,
  type OverseerNativeDeleteHooks,
} from "../src/main/vellum-command/overseer/canvas";
import { makeStateEngineLive } from "../src/main/vellum-command/state/engine";
import { WorkRepositoryLive } from "../src/main/vellum-command/work/repository";
import { StationRepositoryLive } from "../src/main/vellum-command/station/repository";
import { StationFleetTargetRepositoryLive } from "../src/main/vellum-command/station/fleet-target-repository";
import { StationLivePeerRegistryLive } from "../src/main/vellum-command/station/session-registry";
import { WorkLive } from "../src/main/vellum-command/work/service";
import { SettingsLive } from "../src/main/vellum-command/settings/service";
import { makeContentServiceLive } from "../src/main/vellum-command/content/service";
import { makeInstallOpsLive } from "../src/main/vellum-command/install-ops/engine";
import { applyMirrorLaw, type CanvasDoc, type CanvasNode } from "../src/shared/canvas";
import type { OverseerCaller, OverseerRequest } from "../src/shared/overseer-control";
import type { WorkErrorBody } from "../src/shared/work-control";

const agent = (
  id: string,
  bindingId: string,
  overseer = false,
): CanvasNode => ({
  id,
  type: "text",
  text: id,
  x: 0,
  y: 0,
  width: 260,
  height: 96,
  ether: {
    entity: { kind: "agent", name: "local:amp" },
    host: "local",
    terminal: { bindingId, harness: "amp" },
    ...(overseer ? { overseer: true } : {}),
  },
});

const note = (
  id: string,
  geometry: { x: number; y: number; width: number; height: number },
): CanvasNode => ({
  id,
  type: "text",
  text: id,
  ...geometry,
});

const task = (id: string, x: number): CanvasNode => ({
  id,
  type: "text",
  text: id,
  x,
  y: 200,
  width: 240,
  height: 120,
  ether: { entity: { kind: "task" } },
});

const sheet = (id: string): CanvasNode => ({
  id,
  type: "text",
  text: "sheet",
  x: 400,
  y: 0,
  width: 260,
  height: 120,
  ether: {
    entity: { kind: "sheet" },
    sheet: {
      columns: [{ id: "c1", name: "A" }],
      rows: [{ id: "r1", cells: { c1: "one" } }],
    },
  },
});

const overseerDoc = (): CanvasDoc =>
  applyMirrorLaw({
    nodes: [
      agent("overseer", "bind-overseer", true),
      agent("peer", "bind-peer"),
      note("n1", { x: 300, y: 0, width: 120, height: 40 }),
      note("wide", { x: 10, y: 400, width: 400, height: 40 }),
      task("t1", 0),
      task("t2", 300),
      sheet("s1"),
      {
        id: "region",
        type: "group",
        label: "box",
        x: -10,
        y: -10,
        width: 80,
        height: 80,
      },
    ],
    edges: [],
  });

const aliasDoc = (overseer = false): CanvasDoc =>
  applyMirrorLaw({
    nodes: [agent("alias", "bind-overseer", overseer)],
    edges: [],
  });

const CALLER: OverseerCaller = { canvasName: "ops", nodeId: "overseer" };

describe("executeOverseerCanvas", () => {
  let canvasesDir = "";
  let stateDir = "";
  let previousCanvases: string | undefined;
  const makeRuntime = (path: string) => {
    const contentRoot = join(stateDir || path, "..", "content");
    const installOpsPath = join(stateDir || path, "install-ops.db");
    const repositories = Layer.provideMerge(
      Layer.mergeAll(
        WorkRepositoryLive,
        CrewRepositoryLive,
        StationRepositoryLive,
        StationFleetTargetRepositoryLive,
        SettingsLive,
        makeContentServiceLive({
          root: contentRoot,
          skipInlineMediaMigration: true,
        }),
      ),
      Layer.mergeAll(
        makeStateEngineLive(path),
        makeInstallOpsLive(installOpsPath),
      ),
    );
    const canvases = Layer.provideMerge(CanvasesLive, repositories);
    return ManagedRuntime.make(
      Layer.provideMerge(
        WorkLive,
        Layer.mergeAll(canvases, StationLivePeerRegistryLive) as never,
      ),
    );
  };
  let runtime: ReturnType<typeof makeRuntime> | undefined;

  const installEnv = async (): Promise<void> => {
    canvasesDir = await mkdtemp(join(tmpdir(), "vellum-overseer-canvases-"));
    stateDir = await mkdtemp(join(tmpdir(), "vellum-overseer-state-"));
    previousCanvases = process.env.JUNTO_CANVASES_DIR;
    process.env.JUNTO_CANVASES_DIR = canvasesDir;
  };

  const restoreEnv = async (): Promise<void> => {
    setOverseerNativeDeleteHooks(undefined);
    if (runtime) {
      await runtime.dispose();
      runtime = undefined;
    }
    if (previousCanvases === undefined) delete process.env.JUNTO_CANVASES_DIR;
    else process.env.JUNTO_CANVASES_DIR = previousCanvases;
    if (canvasesDir) await rm(canvasesDir, { recursive: true, force: true });
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
    canvasesDir = "";
    stateDir = "";
  };

  afterEach(async () => {
    await restoreEnv();
  });

  const boot = async () => {
    await installEnv();
    runtime = makeRuntime(join(stateDir, "junto.db"));
    const canvases = await runtime.runPromise(CanvasesService);
    await runtime.runPromise(canvases.write("ops", overseerDoc()));
    await runtime.runPromise(canvases.write("other", aliasDoc()));
    const ops = await runtime.runPromise(canvases.read("ops"));
    await runtime.runPromise(
      canvases.canvasOverseerSet({
        canvasName: "ops",
        nodeId: "overseer",
        overseer: true,
        expectedRevision: ops.revision,
      }),
    );
    return canvases;
  };

  const run = (
    request: OverseerRequest,
    caller: OverseerCaller = CALLER,
  ): Promise<Result.Result<unknown, WorkErrorBody>> =>
    runtime!.runPromise(Effect.result(executeOverseerCanvas(caller, request)));

  const expectOk = async (request: OverseerRequest) => {
    const result = await run(request);
    expect(result._tag).toBe("Success");
    return Result.isSuccess(result) ? result.success : undefined;
  };

  const expectErr = async (
    request: OverseerRequest,
    type: WorkErrorBody["type"],
    caller: OverseerCaller = CALLER,
  ) => {
    const result = await run(request, caller);
    expect(result._tag).toBe("Failure");
    if (Result.isFailure(result)) {
      expect(result.failure.type).toBe(type);
      return result.failure;
    }
    throw new Error("expected failure");
  };

  it("lists, reads, digests, and renders without moving viewport state", async () => {
    await boot();
    const listed = (await expectOk({ operation: "canvas.list" })) as ReadonlyArray<{
      name: string;
    }>;
    expect(listed.map((row) => row.name)).toEqual(["ops", "other"]);
    const read = (await expectOk({
      operation: "canvas.read",
      args: { canvas: "ops" },
    })) as { name: string; doc: CanvasDoc };
    expect(read.name).toBe("ops");
    expect(read.doc.nodes.some((node) => node.id === "overseer")).toBe(true);
    const digest = (await expectOk({ operation: "canvas.digest" })) as { digest: string };
    expect(digest.digest).toContain("canvas :: ops");
    const rendered = (await expectOk({ operation: "canvas.render" })) as { svg: string };
    expect(rendered.svg.startsWith("<svg")).toBe(true);
  });

  it("creates and deletes a foreign canvas, refusing self-canvas delete", async () => {
    const canvases = await boot();
    await expectOk({ operation: "canvas.create", args: { canvas: "fresh" } });
    const names = await runtime!.runPromise(canvases.list);
    expect(names.some((row) => row.name === "fresh")).toBe(true);
    await expectErr(
      { operation: "canvas.delete", args: { canvas: "ops" } },
      "AuthError",
    );
    setOverseerNativeDeleteHooks({
      prepareOverseerNodeDelete: async () => ({
        ok: true,
        leaseId: "lease-1",
        pageStops: [],
      }),
      finishOverseerNodeDelete: () => ({ ok: true }),
    });
    await expectOk({ operation: "canvas.delete", args: { canvas: "fresh" } });
  });

  it("creates, moves, resizes, and deletes foreign nodes; refuses self-delete", async () => {
    const canvases = await boot();
    const created = (await expectOk({
      operation: "node.create",
      args: {
        node: {
          type: "text",
          text: "note",
          x: 12.4,
          y: 18.6,
          width: 140,
          height: 50,
        },
      },
    })) as { node: CanvasNode };
    expect(created.node.x).toBe(12.4);
    await expectOk({
      operation: "node.move",
      args: { nodeId: created.node.id, x: 80, y: 90 },
    });
    await expectOk({
      operation: "node.resize",
      args: { nodeId: "wide", width: 80, height: 200 },
    });
    const after = await runtime!.runPromise(canvases.read("ops"));
    const moved = after.doc.nodes.find((node) => node.id === created.node.id);
    const resized = after.doc.nodes.find((node) => node.id === "wide");
    expect(moved).toMatchObject({ x: 80, y: 90 });
    expect(resized).toMatchObject({ width: 80, height: 200 });
    await expectErr(
      { operation: "node.delete", args: { nodeId: "overseer" } },
      "AuthError",
    );
    setOverseerNativeDeleteHooks({
      prepareOverseerNodeDelete: async () => ({
        ok: true,
        leaseId: "lease-node",
        pageStops: [],
      }),
      finishOverseerNodeDelete: () => ({ ok: true }),
    });
    await expectOk({ operation: "node.delete", args: { nodeId: created.node.id } });
  });

  it("refuses deleting a granted alias of the caller's physical binding without native prepare", async () => {
    const canvases = await boot();
    const other = await runtime!.runPromise(canvases.read("other"));
    await runtime!.runPromise(
      canvases.canvasOverseerSet({
        canvasName: "other",
        nodeId: "alias",
        overseer: true,
        expectedRevision: other.revision,
      }),
    );
    let prepared = 0;
    setOverseerNativeDeleteHooks({
      prepareOverseerNodeDelete: async () => {
        prepared += 1;
        return { ok: true, leaseId: "lease-alias", pageStops: [] };
      },
      finishOverseerNodeDelete: () => ({ ok: true }),
    });
    const error = await expectErr(
      { operation: "node.delete", args: { canvas: "other", nodeId: "alias" } },
      "AuthError",
    );
    expect(error.message).toMatch(/physical binding/u);
    expect(prepared).toBe(0);
    const still = await runtime!.runPromise(canvases.read("other"));
    expect(still.doc.nodes.some((node) => node.id === "alias")).toBe(true);
  });

  it("refuses deleting a foreign canvas whose node shares the caller's binding", async () => {
    await boot();
    let prepared = 0;
    setOverseerNativeDeleteHooks({
      prepareOverseerNodeDelete: async () => {
        prepared += 1;
        return { ok: true, leaseId: "lease-canvas-alias", pageStops: [] };
      },
      finishOverseerNodeDelete: () => ({ ok: true }),
    });
    const error = await expectErr(
      { operation: "canvas.delete", args: { canvas: "other" } },
      "AuthError",
    );
    expect(error.message).toMatch(/physical binding/u);
    expect(prepared).toBe(0);
  });

  it("refuses grant mint, binding alias, and occupant retirement of self", async () => {
    await boot();
    await expectErr(
      {
        operation: "node.create",
        args: {
          node: {
            type: "text",
            text: "clone",
            x: 0,
            y: 0,
            width: 260,
            height: 96,
            ether: {
              entity: { kind: "agent", name: "local:clone" },
              host: "local",
              terminal: { bindingId: "bind-overseer", harness: "amp" },
            },
          },
        },
      },
      "AuthError",
    );
    await expectErr(
      {
        operation: "node.configure",
        args: {
          nodeId: "overseer",
          changes: { ether: { entity: { kind: "agent", name: "local:hijack" } } },
        },
      },
      "AuthError",
    );
    await expectOk({
      operation: "node.configure",
      args: { nodeId: "overseer", changes: { text: "still me" } },
    });
    setOverseerNativeDeleteHooks({
      prepareOverseerNodeDelete: async () => ({
        ok: true,
        leaseId: "lease-region",
        pageStops: [],
      }),
      finishOverseerNodeDelete: () => ({ ok: true }),
    });
    await expectOk({ operation: "node.delete", args: { nodeId: "region" } });
  });

  it("connects legal edges, refuses invalid pairs and cycles", async () => {
    await boot();
    await expectOk({
      operation: "edge.connect",
      args: {
        edge: { fromNode: "overseer", toNode: "peer", verb: "messages" },
      },
    });
    await expectErr(
      {
        operation: "edge.connect",
        args: { edge: { fromNode: "n1", toNode: "wide", verb: "messages" } },
      },
      "InputError",
    );
    await expectOk({
      operation: "edge.connect",
      args: { edge: { fromNode: "t1", toNode: "t2", verb: "feeds" } },
    });
    await expectErr(
      {
        operation: "edge.connect",
        args: { edge: { fromNode: "t2", toNode: "t1", verb: "feeds" } },
      },
      "InputError",
    );
    const verbs = (await expectOk({
      operation: "edge.verbs",
      args: { fromNode: "overseer", toNode: "peer" },
    })) as { verbs: ReadonlyArray<string> };
    expect(verbs.verbs).toContain("messages");
  });

  it("commits a complete structural batch with one canvas notification", async () => {
    const canvases = await boot();
    const before = await runtime!.runPromise(canvases.read("ops"));
    const foreign = await runtime!.runPromise(canvases.read("other"));
    const changes: string[] = [];
    const unsubscribe = canvases.subscribeChanges((name) => changes.push(name));
    const result = await expectOk({
      operation: "canvas.batch",
      args: {
        expectedRevision: before.revision,
        operations: [
          { operation: "node.create", node: task("t3", 600) },
          { operation: "node.configure", nodeId: "n1", changes: { text: "batched" } },
          { operation: "node.move", nodeId: "t3", x: 640, y: 220 },
          { operation: "edge.connect", edge: { id: "e3", fromNode: "overseer", toNode: "t3", verb: "contributes" } },
          { operation: "edge.configure", edgeId: "e3", changes: { verb: "manages" } },
        ],
      },
    });
    unsubscribe();
    expect(result).toMatchObject({ canvas: "ops", results: [
      { operation: "node.create", nodeId: "t3" },
      { operation: "node.configure", nodeId: "n1" },
      { operation: "node.move", nodeId: "t3" },
      { operation: "edge.connect", edgeId: "e3" },
      { operation: "edge.configure", edgeId: "e3" },
    ] });
    expect(changes).toEqual(["ops"]);
    const after = await runtime!.runPromise(canvases.read("ops"));
    expect(after.revision).not.toBe(before.revision);
    expect(after.doc.nodes.find((node) => node.id === "t3")).toMatchObject({ x: 640, y: 220 });
    expect(after.doc.nodes.find((node) => node.id === "n1")).toMatchObject({ text: "batched" });
    expect(after.doc.edges.find((edge) => edge.id === "e3")).toMatchObject({ ether: { verb: "manages" } });
    expect((await runtime!.runPromise(canvases.read("other"))).revision).toBe(foreign.revision);
  });

  it("validates the final graph so a batch can reverse a task path atomically", async () => {
    const canvases = await boot();
    await expectOk({ operation: "edge.connect", args: {
      edge: { id: "forward", fromNode: "t1", toNode: "t2", verb: "feeds" },
    } });
    await expectOk({ operation: "canvas.batch", args: { operations: [
      { operation: "edge.connect", edge: { id: "reverse", fromNode: "t2", toNode: "t1", verb: "feeds" } },
      { operation: "edge.disconnect", edgeId: "forward" },
    ] } });
    const after = await runtime!.runPromise(canvases.read("ops"));
    expect(after.doc.edges.map((edge) => edge.id)).toEqual(["reverse"]);
  });

  it("leaves every node and revision unchanged when the final batch graph is invalid", async () => {
    const canvases = await boot();
    const before = await runtime!.runPromise(canvases.read("ops"));
    for (const operations of [
      [
        { operation: "node.create", node: task("t3", 600) },
        { operation: "edge.connect", edge: { fromNode: "n1", toNode: "t3", verb: "messages" } },
      ],
      [
        { operation: "node.move", nodeId: "n1", x: 999, y: 999 },
        { operation: "edge.connect", edge: { fromNode: "t1", toNode: "t2", verb: "feeds" } },
        { operation: "edge.connect", edge: { fromNode: "t2", toNode: "t1", verb: "feeds" } },
      ],
    ]) {
      await expectErr({ operation: "canvas.batch", args: { operations } }, "InputError");
      const after = await runtime!.runPromise(canvases.read("ops"));
      expect(after.revision).toBe(before.revision);
      expect(after.doc).toEqual(before.doc);
    }
  });

  it("refuses batch native identity changes and new aliases of live overseer bindings", async () => {
    const canvases = await boot();
    const before = await runtime!.runPromise(canvases.read("ops"));
    for (const operation of [
      { operation: "node.configure", nodeId: "peer", changes: { ether: { terminal: { bindingId: "replacement", harness: "amp" } } } },
      { operation: "node.configure", nodeId: "overseer", changes: { ether: { host: "remote" } } },
      { operation: "node.create", node: agent("clone", "bind-overseer") },
    ]) {
      await expectErr({ operation: "canvas.batch", args: { operations: [
        { operation: "node.move", nodeId: "n1", x: 999, y: 999 }, operation,
      ] } }, "AuthError");
      expect((await runtime!.runPromise(canvases.read("ops"))).revision).toBe(before.revision);
    }
  });

  it("rejects stale batch revisions and revoked grants at the write transaction", async () => {
    const canvases = await boot();
    const before = await runtime!.runPromise(canvases.read("ops"));
    await expectOk({ operation: "node.move", args: { nodeId: "n1", x: 450, y: 0 } });
    const request: OverseerRequest = { operation: "canvas.batch", args: {
      expectedRevision: before.revision,
      operations: [{ operation: "node.move", nodeId: "n1", x: 999, y: 999 }],
    } };
    await expectErr(request, "ClaimConflict");
    const current = await runtime!.runPromise(canvases.read("ops"));
    await runtime!.runPromise(canvases.canvasOverseerSet({
      canvasName: "ops", nodeId: "overseer", overseer: false, expectedRevision: current.revision,
    }));
    await expectErr(request, "AuthError");
    expect((await runtime!.runPromise(canvases.read("ops"))).doc.nodes.find((node) => node.id === "n1"))
      .toMatchObject({ x: 450, y: 0 });
  });

  it("rechecks batch authority after preflight and before authoring", async () => {
    const canvases = await boot();
    const current = await runtime!.runPromise(canvases.read("ops"));
    const originalMutate = canvases.mutatePortfolio.bind(canvases);
    const wrapped = {
      ...canvases,
      mutatePortfolio: ((fn) => Effect.gen(function* () {
        yield* canvases.canvasOverseerSet({
          canvasName: "ops", nodeId: "overseer", overseer: false, expectedRevision: current.revision,
        });
        return yield* originalMutate(fn);
      })) as typeof canvases.mutatePortfolio,
    };
    const result = await runtime!.runPromise(Effect.result(executeOverseerCanvas(CALLER, {
      operation: "canvas.batch",
      args: { operations: [{ operation: "node.move", nodeId: "n1", x: 999, y: 999 }] },
    }).pipe(Effect.provideService(CanvasesService, wrapped))));
    expect(Result.isFailure(result) && result.failure.type).toBe("AuthError");
    const after = await runtime!.runPromise(canvases.read("ops"));
    expect(after.doc.nodes.find((node) => node.id === "n1")).toMatchObject({ x: 300, y: 0 });
  });

  it("refuses scheduler cycles and leaves their draft nodes uncommitted", async () => {
    const canvases = await boot();
    const before = await runtime!.runPromise(canvases.read("ops"));
    await expectErr({ operation: "canvas.batch", args: { operations: [
      { operation: "node.create", node: { ...task("relay-a", 0), ether: { entity: { kind: "relay" } } } },
      { operation: "node.create", node: { ...task("relay-b", 300), ether: { entity: { kind: "relay" } } } },
      { operation: "edge.connect", edge: { fromNode: "relay-a", toNode: "relay-b", verb: "chains" } },
      { operation: "edge.connect", edge: { fromNode: "relay-b", toNode: "relay-a", verb: "chains" } },
    ] } }, "InputError");
    expect((await runtime!.runPromise(canvases.read("ops"))).revision).toBe(before.revision);
  });

  it("reads and configures authored sheets", async () => {
    await boot();
    const read = (await expectOk({
      operation: "sheet.read",
      args: { target: "s1" },
    })) as { sheet: { rows: ReadonlyArray<unknown> } };
    expect(read.sheet.rows).toHaveLength(1);
    await expectOk({
      operation: "sheet.configure",
      args: {
        target: "s1",
        sheet: {
          columns: [{ id: "c1", name: "A" }],
          rows: [
            { id: "r1", cells: { c1: "one" } },
            { id: "r2", cells: { c1: "two" } },
          ],
        },
      },
    });
  });

  it("revalidates grant in the same transaction as a write after revoke", async () => {
    const canvases = await boot();
    const ops = await runtime!.runPromise(canvases.read("ops"));
    await runtime!.runPromise(
      canvases.canvasOverseerSet({
        canvasName: "ops",
        nodeId: "overseer",
        overseer: false,
        expectedRevision: ops.revision,
      }),
    );
    await expectErr(
      {
        operation: "node.create",
        args: {
          node: { type: "text", text: "late", x: 0, y: 0, width: 100, height: 40 },
        },
      },
      "AuthError",
    );
  });

  it("canvasOverseerSet toggles every alias of the binding", async () => {
    const canvases = await boot();
    const ops = await runtime!.runPromise(canvases.read("ops"));
    const result = await runtime!.runPromise(
      canvases.canvasOverseerSet({
        canvasName: "ops",
        nodeId: "overseer",
        overseer: false,
        expectedRevision: ops.revision,
      }),
    );
    expect(result.binding).toEqual({ hostId: "local", bindingId: "bind-overseer" });
    expect(result.affected.map((row) => row.name).sort()).toEqual(["ops", "other"]);
    const other = await runtime!.runPromise(canvases.read("other"));
    expect(other.doc.nodes[0]?.ether?.overseer).toBeUndefined();
  });

  const noteText = (node: CanvasNode | undefined): string | undefined =>
    node?.type === "text" ? node.text : undefined;

  it("create then revoke leaves no grant; a later create cannot restore it", async () => {
    const canvases = await boot();
    await expectOk({
      operation: "node.create",
      args: {
        node: { type: "text", text: "racy", x: 0, y: 0, width: 100, height: 40 },
      },
    });
    const ops = await runtime!.runPromise(canvases.read("ops"));
    await runtime!.runPromise(
      canvases.canvasOverseerSet({
        canvasName: "ops",
        nodeId: "overseer",
        overseer: false,
        expectedRevision: ops.revision,
      }),
    );
    const after = await runtime!.runPromise(canvases.read("ops"));
    expect(after.doc.nodes.find((node) => node.id === "overseer")?.ether?.overseer).toBeUndefined();
    expect(after.doc.nodes.some((node) => noteText(node) === "racy")).toBe(true);
    await expectErr(
      {
        operation: "node.create",
        args: {
          node: { type: "text", text: "late", x: 0, y: 0, width: 100, height: 40 },
        },
      },
      "AuthError",
    );
    const late = await runtime!.runPromise(canvases.read("ops"));
    expect(late.doc.nodes.some((node) => noteText(node) === "late")).toBe(false);
    expect(late.doc.nodes.find((node) => node.id === "overseer")?.ether?.overseer).toBeUndefined();
  });

  it("revoke then create is AuthError and does not restore the grant", async () => {
    const canvases = await boot();
    const ops = await runtime!.runPromise(canvases.read("ops"));
    await runtime!.runPromise(
      canvases.canvasOverseerSet({
        canvasName: "ops",
        nodeId: "overseer",
        overseer: false,
        expectedRevision: ops.revision,
      }),
    );
    await expectErr(
      {
        operation: "node.create",
        args: {
          node: { type: "text", text: "racy", x: 0, y: 0, width: 100, height: 40 },
        },
      },
      "AuthError",
    );
    const after = await runtime!.runPromise(canvases.read("ops"));
    expect(after.doc.nodes.find((node) => node.id === "overseer")?.ether?.overseer).toBeUndefined();
    expect(after.doc.nodes.some((node) => noteText(node) === "racy")).toBe(false);
  });

  const deferredNative = () => {
    let releasePrepare: (() => void) | undefined;
    let enteredPrepare: (value: void) => void = () => undefined;
    const prepared = new Promise<void>((resolve) => {
      enteredPrepare = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releasePrepare = resolve;
    });
    const finishes: Array<"committed" | "aborted"> = [];
    const hooks: OverseerNativeDeleteHooks = {
      prepareOverseerNodeDelete: async () => {
        enteredPrepare();
        await gate;
        return { ok: true, leaseId: "lease-interrupt", pageStops: [] };
      },
      finishOverseerNodeDelete: (_leaseId, outcome) => {
        finishes.push(outcome);
        return { ok: true };
      },
    };
    return {
      hooks,
      prepared,
      release: () => releasePrepare?.(),
      finishes,
    };
  };

  it("interrupting during native prepare does not leave a lease", async () => {
    const canvases = await boot();
    const native = deferredNative();
    setOverseerNativeDeleteHooks(native.hooks);
    const fiber = runtime!.runFork(
      executeOverseerCanvas(CALLER, {
        operation: "node.delete",
        args: { nodeId: "peer" },
      }),
    );
    await native.prepared;
    const interrupted = runtime!.runPromise(Fiber.interrupt(fiber));
    native.release();
    await interrupted;
    const after = await runtime!.runPromise(canvases.read("ops"));
    expect(after.doc.nodes.some((node) => node.id === "peer")).toBe(true);
    expect(native.finishes).toEqual(["aborted"]);
  });

  it("interrupting after prepare finishes the lease aborted and does not delete", async () => {
    const canvases = await boot();
    const entered = await runtime!.runPromise(Deferred.make<void>());
    const gate = await runtime!.runPromise(Deferred.make<void>());
    const finishes: Array<"committed" | "aborted"> = [];
    setOverseerNativeDeleteHooks({
      prepareOverseerNodeDelete: async () => ({
        ok: true,
        leaseId: "lease-body",
        pageStops: [],
      }),
      finishOverseerNodeDelete: (_leaseId, outcome) => {
        finishes.push(outcome);
        return { ok: true };
      },
    });
    const originalMutate = canvases.mutatePortfolio.bind(canvases);
    const wrapped = {
      ...canvases,
      mutatePortfolio: ((fn) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(gate);
          return yield* originalMutate(fn);
        })) as typeof canvases.mutatePortfolio,
    };
    const fiber = runtime!.runFork(
      executeOverseerCanvas(CALLER, {
        operation: "node.delete",
        args: { nodeId: "peer" },
      }).pipe(Effect.provideService(CanvasesService, wrapped)),
    );
    await runtime!.runPromise(Deferred.await(entered));
    await runtime!.runPromise(Fiber.interrupt(fiber));
    await runtime!.runPromise(Deferred.succeed(gate, undefined));
    const after = await runtime!.runPromise(canvases.read("ops"));
    expect(after.doc.nodes.some((node) => node.id === "peer")).toBe(true);
    expect(finishes).toEqual(["aborted"]);
  });

  it("reports finish failure after a successful commit", async () => {
    await boot();
    setOverseerNativeDeleteHooks({
      prepareOverseerNodeDelete: async () => ({
        ok: true,
        leaseId: "lease-finish-fail",
        pageStops: [],
      }),
      finishOverseerNodeDelete: () => ({ ok: false, error: "fence stuck" }),
    });
    const error = await expectErr(
      { operation: "node.delete", args: { nodeId: "peer" } },
      "InternalError",
    );
    expect(error.message).toContain("finish failed after commit");
  });

  it("generic write cannot restore a revoked grant", async () => {
    const canvases = await boot();
    const before = await runtime!.runPromise(canvases.read("ops"));
    await runtime!.runPromise(
      canvases.canvasOverseerSet({
        canvasName: "ops",
        nodeId: "overseer",
        overseer: false,
        expectedRevision: before.revision,
      }),
    );
    await runtime!.runPromise(canvases.write("ops", overseerDoc()));
    const after = await runtime!.runPromise(canvases.read("ops"));
    const seat = after.doc.nodes.find((node) => node.id === "overseer");
    expect(seat?.ether?.overseer).toBeUndefined();
  });
});
