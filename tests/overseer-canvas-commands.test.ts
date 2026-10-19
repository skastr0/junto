import { CrewRepositoryLive } from "../src/main/junto/work/crew-repository";
import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Fiber, Layer, ManagedRuntime, Result } from "effect";
import {
  grantOverseer,
  ModelStoresLive,
  readSeeded,
  seedCanvas,
} from "./support/seed-canvas";
import { note, region, seat } from "./support/model-nodes";
import {
  executeOverseerCanvas,
  setOverseerNativeDeleteHooks,
  type OverseerNativeDeleteHooks,
} from "../src/main/junto/overseer/canvas";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { WorkRepositoryLive } from "../src/main/junto/work/repository";
import { MachineRepositoryLive } from "../src/main/junto/machines/repository";
import { OTHER_MACHINE, THIS_MACHINE } from "./support/machines";
import { nameThisMachine } from "./support/name-this-machine";
import { clearMachines, seedThisMachine } from "./support/seed-this-machine";
import { WorkLive } from "../src/main/junto/work/service";
import { ModelService } from "../src/main/junto/model/service";
import { SettingsLive } from "../src/main/junto/settings/service";
import { makeContentServiceLive } from "../src/main/junto/content/service";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { asNodeId, type Node, type NodeOf, type Wire } from "../src/shared/model";
import type { OverseerCaller, OverseerRequest } from "../src/shared/overseer-control";
import type { WorkErrorBody } from "../src/shared/work-control";

// The overseer's canvas commands over the real model: what an agent sends and
// reads is the model's own nodes and wires.

/** A seat running amp on a session the test names. */
const amp = (id: string, bindingId: string): NodeOf<"agent"> =>
  seat(id, {
    width: 260,
    height: 96,
    agentKey: "local:amp",
    harness: "amp",
    bindingId: bindingId as NodeOf<"agent">["bindingId"],
  });

const opsNodes = (): ReadonlyArray<Node> => [
  amp("overseer", "bind-overseer"),
  amp("peer", "bind-peer"),
  note("n1", "n1", { x: 300, y: 0, width: 120, height: 40 }),
  note("wide", "wide", { x: 10, y: 400, width: 400, height: 40 }),
  region("region", { x: -10, y: -10, width: 80, height: 80 }, { label: "box" }),
];

/** A note as an agent drafts it: no id it must name, no place in the stack. */
const draft = (id: string | undefined, text: string, at: { x: number; y: number; width: number; height: number }) => ({
  kind: "note" as const,
  ...(id === undefined ? {} : { id }),
  text,
  ...at,
});

const CALLER: OverseerCaller = { canvasName: "ops", nodeId: "overseer" };

describe("executeOverseerCanvas", () => {
  let stateDir = "";
  const makeRuntime = (path: string) => {
    const contentRoot = join(stateDir || path, "..", "content");
    const installOpsPath = join(stateDir || path, "install-ops.db");
    const repositories = Layer.provideMerge(
      Layer.mergeAll(
        WorkRepositoryLive,
        CrewRepositoryLive,
        MachineRepositoryLive,
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
    const canvases = Layer.provideMerge(ModelStoresLive, repositories);
    return ManagedRuntime.make(
      Layer.provideMerge(
        WorkLive,
        Layer.mergeAll(canvases) as never,
      ),
    );
  };
  let runtime: ReturnType<typeof makeRuntime> | undefined;

  const installEnv = async (): Promise<void> => {
    stateDir = await mkdtemp(join(tmpdir(), "junto-overseer-state-"));
  };

  const restoreEnv = async (): Promise<void> => {
    setOverseerNativeDeleteHooks(undefined);
    clearMachines();
    if (runtime) {
      await runtime.dispose();
      runtime = undefined;
    }
    if (stateDir) await rm(stateDir, { recursive: true, force: true });
    stateDir = "";
  };

  afterEach(async () => {
    await restoreEnv();
  });

  const boot = async () => {
    await installEnv();
    runtime = makeRuntime(join(stateDir, "junto.db"));
    await runtime.runPromise(nameThisMachine);
    // The overseer places a seat with no machine named on this one.
    seedThisMachine();
    await runtime.runPromise(seedCanvas("ops", opsNodes()));
    await runtime.runPromise(seedCanvas("other", [amp("alias", "bind-overseer")]));
    await runtime.runPromise(grantOverseer("ops", "overseer", true));
  };

  const run = (
    request: OverseerRequest,
    caller: OverseerCaller = CALLER,
  ): Promise<Result.Result<unknown, WorkErrorBody>> =>
    runtime!.runPromise(Effect.result(executeOverseerCanvas(caller, request)));

  /** The sequence an overseer is told, which is what it sends back. */
  const seqOf = async (canvas: string): Promise<number> =>
    ((await expectOk({ operation: "canvas.read", args: { canvas } })) as { seq: number }).seq;

  const held = (canvas: string) => runtime!.runPromise(readSeeded(canvas));
  const nodeAt = async (canvas: string, id: string): Promise<Node | undefined> =>
    (await held(canvas)).nodes.get(asNodeId(id));

  const NATIVE_OK: OverseerNativeDeleteHooks = {
    prepareOverseerNodeDelete: async () => ({ ok: true, leaseId: "lease", pageStops: [] }),
    finishOverseerNodeDelete: () => ({ ok: true }),
  };

  /**
   * The model, with something made to happen just before the write
   * transaction lists the canvases: the `nth` time they are listed.
   */
  const beforeTheWrite = async (
    happen: Effect.Effect<unknown, unknown, ModelService>,
    nth = 2,
  ) => {
    const model = await runtime!.runPromise(ModelService);
    let listed = 0;
    return {
      ...model,
      listCanvases: () =>
        Effect.gen(function* () {
          listed += 1;
          if (listed === nth) {
            yield* Effect.orDie(Effect.provideService(happen, ModelService, model));
          }
          return yield* model.listCanvases();
        }),
    } as typeof model;
  };

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

  it("lists, reads, digests, and renders", async () => {
    await boot();
    expect(await expectOk({ operation: "canvas.list" })).toEqual([{ name: "ops" }, { name: "other" }]);
    const read = (await expectOk({ operation: "canvas.read", args: { canvas: "ops" } })) as {
      name: string; seq: number; nodes: ReadonlyArray<Node>; wires: ReadonlyArray<Wire>;
    };
    expect(read.name).toBe("ops");
    expect(typeof read.seq).toBe("number");
    expect(read.wires).toEqual([]);
    // Structure only, in the model's own kinds: nothing named type, text or ether.
    expect(read.nodes.map((node) => [node.id, node.kind])).toEqual([
      ["overseer", "agent"], ["peer", "agent"], ["n1", "note"], ["wide", "note"], ["region", "region"],
    ]);
    expect(read.nodes[0]).toMatchObject({ kind: "agent", overseer: true, bindingId: "bind-overseer" });
    expect(JSON.stringify(read)).not.toMatch(/"ether"|"type"|"fromNode"/u);
    expect(await expectOk({ operation: "node.list" })).toEqual({ nodes: read.nodes });
    expect(await expectOk({ operation: "node.get", args: { nodeId: "n1" } })).toEqual({ node: read.nodes[2] });
    await expectErr({ operation: "node.get", args: { nodeId: "ghost" } }, "UnknownTarget");
    const digest = (await expectOk({ operation: "canvas.digest" })) as { digest: string };
    expect(digest.digest).toContain("canvas :: ops");
    const rendered = (await expectOk({ operation: "canvas.render" })) as { svg: string };
    expect(rendered.svg.startsWith("<svg")).toBe(true);
  });

  it("creates and deletes a foreign canvas, refusing self-canvas delete", async () => {
    await boot();
    expect(await expectOk({ operation: "canvas.create", args: { canvas: "fresh" } }))
      .toEqual({ name: "fresh", seq: 0, nodes: [], wires: [] });
    await expectErr({ operation: "canvas.create", args: { canvas: "fresh" } }, "InputError");
    expect(await runtime!.runPromise(Effect.flatMap(ModelService, (model) => model.listCanvases())))
      .toContain("fresh");
    await expectErr({ operation: "canvas.delete", args: { canvas: "ops" } }, "AuthError");
    setOverseerNativeDeleteHooks(NATIVE_OK);
    await expectOk({ operation: "canvas.delete", args: { canvas: "fresh" } });
    await expectErr({ operation: "canvas.read", args: { canvas: "fresh" } }, "UnknownTarget");
  });

  it("creates, moves, resizes, recolors and deletes foreign nodes; refuses self-delete", async () => {
    await boot();
    const created = (await expectOk({
      operation: "node.create",
      args: { node: draft(undefined, "note", { x: 12.4, y: 18.6, width: 140, height: 50 }) },
    })) as { node: NodeOf<"note"> };
    // The answer carries the id main minted and where the node stacks.
    expect(created.node).toMatchObject({ kind: "note", text: "note", x: 12.4, y: 18.6 });
    expect(created.node.id).toMatch(/^note-/u);
    expect(created.node.z).toBeGreaterThan(0);
    expect(await expectOk({ operation: "node.move", args: { nodeId: created.node.id, x: 80, y: 90 } }))
      .toMatchObject({ node: { id: created.node.id, x: 80, y: 90 } });
    await expectOk({ operation: "node.resize", args: { nodeId: "wide", width: 80, height: 200 } });
    expect(await nodeAt("ops", "wide")).toMatchObject({ width: 80, height: 200, x: 10, y: 400 });
    expect(await expectOk({ operation: "node.recolor", args: { nodeIds: ["n1", "wide"], color: "#aabbcc" } }))
      .toEqual({ nodeIds: ["n1", "wide"], color: "#aabbcc" });
    expect(await nodeAt("ops", "n1")).toMatchObject({ color: "#aabbcc" });
    await expectOk({ operation: "node.recolor", args: { nodeIds: ["n1"], color: null } });
    expect((await nodeAt("ops", "n1"))?.color).toBeUndefined();
    await expectErr({ operation: "node.recolor", args: { nodeIds: ["ghost"], color: null } }, "UnknownTarget");
    await expectErr({ operation: "node.delete", args: { nodeIds: ["overseer"] } }, "AuthError");
    await expectErr({ operation: "node.delete", args: { nodeIds: ["n1", "ghost"] } }, "UnknownTarget");
    setOverseerNativeDeleteHooks(NATIVE_OK);
    expect(await expectOk({ operation: "node.delete", args: { nodeIds: [created.node.id, "n1"] } }))
      .toEqual({ nodeIds: [created.node.id, "n1"] });
    expect(await nodeAt("ops", "n1")).toBeUndefined();
    expect(await nodeAt("ops", created.node.id)).toBeUndefined();
  });

  it("refuses deleting a granted alias of the caller's physical binding without native prepare", async () => {
    await boot();
    let prepared = 0;
    setOverseerNativeDeleteHooks({
      prepareOverseerNodeDelete: async () => {
        prepared += 1;
        return { ok: true, leaseId: "lease-alias", pageStops: [] };
      },
      finishOverseerNodeDelete: () => ({ ok: true }),
    });
    const error = await expectErr(
      { operation: "node.delete", args: { canvas: "other", nodeIds: ["alias"] } },
      "AuthError",
    );
    expect(error.message).toMatch(/physical binding/u);
    expect(prepared).toBe(0);
    expect(await nodeAt("other", "alias")).toBeDefined();
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
    const error = await expectErr({ operation: "canvas.delete", args: { canvas: "other" } }, "AuthError");
    expect(error.message).toMatch(/physical binding/u);
    expect(prepared).toBe(0);
  });

  it("creates a seat from named choices and never from a command line or an authority", async () => {
    await boot();
    const made = (await expectOk({
      operation: "node.create",
      args: { node: { kind: "agent", x: 600, y: 0, width: 260, height: 96, harness: "claude", model: "opus", label: "Builder" } },
    })) as { node: NodeOf<"agent"> };
    // Main worked out everything the agent did not name.
    expect(made.node).toMatchObject({
      kind: "agent", label: "Builder", harness: "claude", host: THIS_MACHINE, agentKey: `${THIS_MACHINE}:claude`,
      overseer: false, onRemove: "detach",
    });
    expect(made.node.bindingId).toMatch(/\S/u);
    const argv = made.node.launch?.argv ?? [];
    expect(argv.length).toBeGreaterThan(0);
    expect(argv.join(" ")).toContain("opus");

    const seatDraft = { kind: "agent", x: 0, y: 0, width: 260, height: 96, harness: "claude" };
    for (const [field, value] of [
      ["launch", { kind: "harness", argv: ["sh", "-c", "anything"] }],
      ["bindingId", "bind-overseer"],
      ["agentKey", "local:other"],
      ["overseer", true],
      ["sessionId", "s-1"],
    ] as const) {
      const refused = await expectErr(
        { operation: "node.create", args: { node: { ...seatDraft, [field]: value } } } as never,
        "InputError",
      );
      // Says what to send instead, and names the field it will not take.
      expect(refused.message).toMatch(/naming what it runs/u);
      expect(refused.message).toContain(field);
    }
    expect((await expectErr(
      { operation: "node.create", args: { node: { ...seatDraft, overseer: true } } } as never,
      "InputError",
    )).message).toMatch(/Only the operator/u);
    // An old document draft is not a node.
    await expectErr(
      { operation: "node.create", args: { node: { type: "text", text: "x", x: 0, y: 0, width: 10, height: 10 } } } as never,
      "InputError",
    );
  });

  it("refuses a terminal that would share a live overseer's session", async () => {
    await boot();
    const refused = await expectErr({
      operation: "node.create",
      args: { node: { kind: "terminal", x: 0, y: 200, width: 200, height: 100, host: THIS_MACHINE, onRemove: "detach", bindingId: "bind-overseer" } },
    } as never, "AuthError");
    expect(refused.message).toMatch(/share a session/u);
    const shell = (await expectOk({
      operation: "node.create",
      args: { node: { kind: "terminal", x: 0, y: 200, width: 200, height: 100, host: THIS_MACHINE, onRemove: "detach" } },
    } as never)) as { node: NodeOf<"terminal"> };
    expect(shell.node.bindingId).toMatch(/\S/u);
  });

  it("configures a node by its kind's edit, and says which command does what it will not", async () => {
    await boot();
    expect(await expectOk({ operation: "node.configure", args: { nodeId: "n1", change: { kind: "note", text: "renamed" } } }))
      .toMatchObject({ node: { id: "n1", kind: "note", text: "renamed" } });
    // A change of another kind names the kind the node is.
    const mismatch = await expectErr(
      { operation: "node.configure", args: { nodeId: "n1", change: { kind: "region", label: "x" } } },
      "InputError",
    );
    expect(mismatch.message).toContain('"n1" is a note');
    // A null clears a field its kind may leave empty.
    await expectOk({ operation: "node.configure", args: { nodeId: "region", change: { kind: "region", instruction: "Ship it." } } });
    expect(await nodeAt("ops", "region")).toMatchObject({ instruction: "Ship it.", label: "box" });
    await expectOk({ operation: "node.configure", args: { nodeId: "region", change: { kind: "region", instruction: null } } });
    expect((await nodeAt("ops", "region") as NodeOf<"region">).instruction).toBeUndefined();
    // What a seat runs is not an edit.
    for (const change of [
      { kind: "agent", harness: "claude" },
      { kind: "agent", host: OTHER_MACHINE },
      { kind: "agent", launch: { kind: "harness", argv: ["sh"] } },
    ] as const) {
      const refused = await expectErr(
        { operation: "node.configure", args: { nodeId: "peer", change } },
        "AuthError",
      );
      expect(refused.message).toMatch(/agent reseat/u);
    }
    expect(await nodeAt("ops", "peer")).toMatchObject({ harness: "amp", host: THIS_MACHINE });
    await expectOk({ operation: "node.configure", args: { nodeId: "peer", change: { kind: "agent", label: "Peer" } } });
    expect(await nodeAt("ops", "peer")).toMatchObject({ label: "Peer", bindingId: "bind-peer" });
  });

  it("lets an overseer rename and move its own seat, and nothing more of it", async () => {
    await boot();
    await expectOk({ operation: "node.configure", args: { nodeId: "overseer", change: { kind: "agent", label: "still me" } } });
    await expectOk({ operation: "node.move", args: { nodeId: "overseer", x: 40, y: 60 } });
    expect(await nodeAt("ops", "overseer")).toMatchObject({ label: "still me", x: 40, y: 60, overseer: true });
    const refused = await expectErr(
      { operation: "node.configure", args: { nodeId: "overseer", change: { kind: "agent", onRemove: "kill-session" } } },
      "AuthError",
    );
    expect(refused.message).toMatch(/Only the operator/u);
    setOverseerNativeDeleteHooks(NATIVE_OK);
    await expectErr({ operation: "node.delete", args: { nodeIds: ["region"], canvas: "nowhere" } }, "UnknownTarget");
    await expectOk({ operation: "node.delete", args: { nodeIds: ["region"] } });
  });

  it("connects legal wires, answers the wire with its id, and refuses pairs no verb joins", async () => {
    await boot();
    const made = (await expectOk({
      operation: "wire.connect",
      args: { wire: { from: "overseer", to: "peer" } },
    })) as { wire: Wire };
    // The verb was main's choice for two seats; the id is main's.
    expect(made.wire).toMatchObject({ from: "overseer", to: "peer", verb: "messages" });
    expect(made.wire.id).toMatch(/^wire-/u);
    expect(await expectOk({ operation: "wire.get", args: { wireId: made.wire.id } })).toEqual({ wire: made.wire });
    expect(await expectOk({ operation: "wire.list" })).toEqual({ wires: [made.wire] });
    const none = await expectErr(
      { operation: "wire.connect", args: { wire: { from: "n1", to: "wide" } } },
      "InputError",
    );
    expect(none.message).toMatch(/no verb joins a note to a note/u);
    const wrong = await expectErr(
      { operation: "wire.connect", args: { wire: { from: "overseer", to: "peer", verb: "navigates" } } },
      "InputError",
    );
    expect(wrong.message).toMatch(/wire verbs/u);
    await expectErr({ operation: "wire.connect", args: { wire: { from: "overseer", to: "ghost" } } }, "UnknownTarget");
    await expectErr({ operation: "wire.connect", args: { wire: { id: made.wire.id, from: "peer", to: "overseer" } } }, "InputError");
    expect(await expectOk({ operation: "wire.verbs", args: { from: "overseer", to: "peer" } }))
      .toMatchObject({ verbs: expect.arrayContaining(["messages"]), default: "messages" });
    expect(await expectOk({ operation: "wire.verbs", args: { from: "n1", to: "wide" } })).toEqual({ verbs: [] });

    expect(await expectOk({
      operation: "wire.configure",
      args: { wireId: made.wire.id, change: { verb: "reviews", fromSide: "left" } },
    })).toMatchObject({ wire: { id: made.wire.id, verb: "reviews", fromSide: "left" } });
    await expectOk({ operation: "wire.configure", args: { wireId: made.wire.id, change: { fromSide: null } } });
    expect(((await expectOk({ operation: "wire.get", args: { wireId: made.wire.id } })) as { wire: Wire }).wire.fromSide)
      .toBeUndefined();
    await expectErr(
      { operation: "wire.configure", args: { wireId: made.wire.id, change: { verb: "navigates" } } },
      "InputError",
    );
    expect(await expectOk({ operation: "wire.disconnect", args: { wireId: made.wire.id } }))
      .toEqual({ wireId: made.wire.id });
    await expectErr({ operation: "wire.get", args: { wireId: made.wire.id } }, "UnknownTarget");
  });

  it("no retired name or shape is answered", async () => {
    await boot();
    for (const operation of ["edge.connect", "edge.configure", "edge.disconnect", "edge.list", "edge.get", "edge.verbs"]) {
      await expectErr({ operation, args: {} } as never, "ProtocolError");
    }
    await expectErr({ operation: "canvas.batch", args: { operations: [] } } as never, "InputError");
    await expectErr(
      { operation: "canvas.batch", args: { expectedRevision: "1", steps: [{ operation: "node.move", nodeId: "n1", x: 1, y: 1 }] } } as never,
      "InputError",
    );
    await expectErr({ operation: "node.delete", args: { nodeId: "n1" } } as never, "InputError");
    await expectErr({ operation: "node.configure", args: { nodeId: "n1", changes: { text: "x" } } } as never, "InputError");
  });

  it("commits a complete structural batch as one change to the canvas", async () => {
    await boot();
    const before = await seqOf("ops");
    const foreign = await seqOf("other");
    const changes: string[] = [];
    const unsubscribe = (await runtime!.runPromise(ModelService)).subscribeChanges((event) => changes.push(event.canvas));
    const result = await expectOk({
      operation: "canvas.batch",
      args: {
        expectedSeq: before,
        steps: [
          { operation: "node.create", node: draft("n3", "n3", { x: 600, y: 200, width: 240, height: 120 }) },
          { operation: "node.configure", nodeId: "n1", change: { kind: "note", text: "batched" } },
          { operation: "node.move", nodeId: "n3", x: 640, y: 220 },
          { operation: "node.recolor", nodeIds: ["n1", "n3"], color: "#112233" },
          { operation: "wire.connect", wire: { id: "w3", from: "overseer", to: "peer", verb: "messages" } },
        ],
      },
    });
    unsubscribe();
    expect(result).toMatchObject({ canvas: "ops", results: [
      { operation: "node.create", nodeId: "n3", node: { id: "n3", kind: "note" } },
      { operation: "node.configure", nodeId: "n1" },
      { operation: "node.move", nodeId: "n3" },
      { operation: "node.recolor", nodeIds: ["n1", "n3"] },
      { operation: "wire.connect", wireId: "w3", wire: { id: "w3", verb: "messages" } },
    ] });
    // One change: the canvas moved once, by one.
    expect(changes).toEqual(["ops"]);
    expect(await seqOf("ops")).toBe(before + 1);
    expect(await nodeAt("ops", "n3")).toMatchObject({ x: 640, y: 220, color: "#112233" });
    expect(await nodeAt("ops", "n1")).toMatchObject({ text: "batched", color: "#112233" });
    expect([...(await held("ops")).wires.values()]).toMatchObject([{ id: "w3", verb: "messages" }]);
    expect(await seqOf("other")).toBe(foreign);
  });

  it("authors a region's environment through the canvas commit path", async () => {
    await boot();
    const changes: string[] = [];
    const unsubscribe = (await runtime!.runPromise(ModelService)).subscribeChanges((event) => changes.push(event.canvas));
    const env = (operation: string, args: Record<string, unknown>) =>
      expectOk({ operation, args: { nodeId: "region", ...args } } as OverseerRequest) as Promise<{
        nodeId: string;
        sourceId?: string;
        environment: { sealed?: boolean; folders?: string[]; sources?: Array<{ id: string }> };
      }>;

    expect(await env("env.show", {})).toEqual({ nodeId: "region", environment: {} });
    const before = await seqOf("ops");
    const added = await env("env.source-add", {
      source: { kind: "keychain", name: "EXAMPLE_AUTH_TOKEN", service: "op" },
    });
    expect(added.sourceId).toMatch(/^source-/u);
    expect(added.environment.sources).toEqual([
      { id: added.sourceId, kind: "keychain", name: "EXAMPLE_AUTH_TOKEN", service: "op" },
    ]);
    expect(await seqOf("ops")).toBe(before + 1);
    expect(changes).toEqual(["ops"]);

    await env("env.source-add", {
      source: { id: "first", kind: "value", name: "NODE_ENV", value: "production" },
      index: 0,
    });
    await env("env.source-edit", {
      sourceId: "first",
      source: { kind: "envFile", path: "~/.env", required: true },
    });
    await env("env.source-reorder", { sourceIds: [added.sourceId, "first"] });
    await env("env.seal", { sealed: true });
    await env("env.folders", { folders: ["~/.config/gh"] });
    unsubscribe();

    const stored = (await nodeAt("ops", "region")) as NodeOf<"region">;
    expect(stored).toMatchObject({
      kind: "region",
      label: "box",
      environment: {
        sealed: true,
        folders: ["~/.config/gh"],
        sources: [
          { id: added.sourceId, kind: "keychain" },
          { id: "first", kind: "envFile", path: "~/.env", required: true },
        ],
      },
    });
    expect(await env("env.show", {})).toEqual({ nodeId: "region", environment: stored.environment });

    await env("env.source-remove", { sourceId: "first" });
    expect((await env("env.show", {})).environment.sources).toHaveLength(1);
    // Emptied, the region carries no environment at all.
    await env("env.source-remove", { sourceId: added.sourceId });
    await env("env.seal", { sealed: false });
    await env("env.folders", { folders: [] });
    expect(((await nodeAt("ops", "region")) as NodeOf<"region">).environment).toBeUndefined();
  });

  it("refuses environment edits it cannot honor and leaves the canvas as it was", async () => {
    await boot();
    const before = await held("ops");
    const refused: ReadonlyArray<readonly [OverseerRequest, WorkErrorBody["type"]]> = [
      [{ operation: "env.seal", args: { nodeId: "n1", sealed: true } }, "InputError"],
      [{ operation: "env.show", args: { nodeId: "n1" } }, "InputError"],
      [{ operation: "env.show", args: { nodeId: "ghost" } }, "UnknownTarget"],
      [{ operation: "env.seal", args: { nodeId: "ghost", sealed: true } }, "UnknownTarget"],
      [{ operation: "env.source-remove", args: { nodeId: "region", sourceId: "ghost" } }, "UnknownTarget"],
      [{ operation: "env.source-reorder", args: { nodeId: "region", sourceIds: ["ghost"] } }, "InputError"],
      [{ operation: "env.folders", args: { nodeId: "region", folders: ["relative"] } }, "InputError"],
      [{ operation: "env.source-add", args: { nodeId: "region", source: { kind: "value", name: "bad name", value: "x" } } }, "InputError"],
    ];
    for (const [request, type] of refused) await expectErr(request, type);
    expect(await held("ops")).toBe(before);

    await runtime!.runPromise(grantOverseer("ops", "overseer", false));
    await expectErr({ operation: "env.seal", args: { nodeId: "region", sealed: true } }, "AuthError");
    await expectErr({ operation: "env.show", args: { nodeId: "region" } }, "AuthError");
  });

  it("leaves every node and the sequence unchanged when a later step is refused", async () => {
    await boot();
    const before = await held("ops");
    for (const [steps, type] of [
      // A wire no verb joins, after a node that would have been made.
      [[
        { operation: "node.create", node: draft("n3", "n3", { x: 600, y: 200, width: 240, height: 120 }) },
        { operation: "wire.connect", wire: { from: "overseer", to: "n3", verb: "messages" } },
      ], "InputError"],
      [[
        { operation: "node.move", nodeId: "n1", x: 999, y: 999 },
        { operation: "wire.connect", wire: { from: "n1", to: "wide" } },
      ], "InputError"],
      // What a seat runs, after a move.
      [[
        { operation: "node.move", nodeId: "n1", x: 999, y: 999 },
        { operation: "node.configure", nodeId: "peer", change: { kind: "agent", host: "remote" } },
      ], "AuthError"],
      // What only the operator changes on an overseer seat: the model refuses the batch whole.
      [[
        { operation: "node.move", nodeId: "n1", x: 999, y: 999 },
        { operation: "node.configure", nodeId: "overseer", change: { kind: "agent", onRemove: "kill-session" } },
      ], "AuthError"],
    ] as const) {
      await expectErr({ operation: "canvas.batch", args: { steps } } as never, type);
      expect(await held("ops")).toBe(before);
    }
  });

  it("rejects a stale expected sequence and a revoked grant at the write transaction", async () => {
    await boot();
    const before = await seqOf("ops");
    await expectOk({ operation: "node.move", args: { nodeId: "n1", x: 450, y: 0 } });
    const request: OverseerRequest = { operation: "canvas.batch", args: {
      expectedSeq: before,
      steps: [{ operation: "node.move", nodeId: "n1", x: 999, y: 999 }],
    } };
    const stale = await expectErr(request, "ClaimConflict");
    expect(stale.message).toContain(`seq ${before + 1}, not ${before}`);
    await runtime!.runPromise(grantOverseer("ops", "overseer", false));
    await expectErr(request, "AuthError");
    expect(await nodeAt("ops", "n1")).toMatchObject({ x: 450, y: 0 });
  });

  it("rechecks batch authority after preflight and before authoring", async () => {
    await boot();
    // The first read is the preflight grant check; the second opens the write.
    const wrapped = await beforeTheWrite(grantOverseer("ops", "overseer", false));
    const result = await runtime!.runPromise(Effect.result(executeOverseerCanvas(CALLER, {
      operation: "canvas.batch",
      args: { steps: [{ operation: "node.move", nodeId: "n1", x: 999, y: 999 }] },
    }).pipe(Effect.provideService(ModelService, wrapped))));
    expect(Result.isFailure(result) && result.failure.type).toBe("AuthError");
    expect(await nodeAt("ops", "n1")).toMatchObject({ x: 300, y: 0 });
  });

  it("a non-overseer caller is refused, as is one whose seat is gone", async () => {
    await boot();
    await expectErr(
      { operation: "node.move", args: { nodeId: "n1", x: 1, y: 1 } },
      "AuthError",
      { canvasName: "ops", nodeId: "peer" },
    );
    await expectErr({ operation: "canvas.list" }, "AuthError", { canvasName: "ops", nodeId: "ghost" });
    await expectErr({ operation: "canvas.list" }, "AuthError", { canvasName: "nowhere", nodeId: "overseer" });
  });

  it("a grant, and taking it away, reaches every seat on the same session", async () => {
    await boot();
    const aliasGrant = async () => ((await nodeAt("other", "alias")) as NodeOf<"agent">).overseer;
    // boot granted the seat on ops; the same session on another canvas follows.
    expect(await aliasGrant()).toBe(true);
    await runtime!.runPromise(grantOverseer("ops", "overseer", false));
    expect(await aliasGrant()).toBe(false);
  });

  const noteNamed = async (text: string): Promise<boolean> =>
    [...(await held("ops")).nodes.values()].some((node) => node.kind === "note" && node.text === text);

  it("create then revoke leaves no grant; a later create cannot restore it", async () => {
    await boot();
    await expectOk({ operation: "node.create", args: { node: draft(undefined, "racy", { x: 0, y: 0, width: 100, height: 40 }) } });
    await runtime!.runPromise(grantOverseer("ops", "overseer", false));
    expect(await nodeAt("ops", "overseer")).toMatchObject({ overseer: false });
    expect(await noteNamed("racy")).toBe(true);
    await expectErr(
      { operation: "node.create", args: { node: draft(undefined, "late", { x: 0, y: 0, width: 100, height: 40 }) } },
      "AuthError",
    );
    expect(await noteNamed("late")).toBe(false);
    expect(await nodeAt("ops", "overseer")).toMatchObject({ overseer: false });
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
    return { hooks, prepared, release: () => releasePrepare?.(), finishes };
  };

  it("interrupting during native prepare does not leave a lease", async () => {
    await boot();
    const native = deferredNative();
    setOverseerNativeDeleteHooks(native.hooks);
    const fiber = runtime!.runFork(
      executeOverseerCanvas(CALLER, { operation: "node.delete", args: { nodeIds: ["peer"] } }),
    );
    await native.prepared;
    const interrupted = runtime!.runPromise(Fiber.interrupt(fiber));
    native.release();
    await interrupted;
    expect(await nodeAt("ops", "peer")).toBeDefined();
    expect(native.finishes).toEqual(["aborted"]);
  });

  it("interrupting after prepare finishes the lease aborted and does not delete", async () => {
    await boot();
    const entered = await runtime!.runPromise(Deferred.make<void>());
    const gate = await runtime!.runPromise(Deferred.make<void>());
    const finishes: Array<"committed" | "aborted"> = [];
    setOverseerNativeDeleteHooks({
      prepareOverseerNodeDelete: async () => ({ ok: true, leaseId: "lease-body", pageStops: [] }),
      finishOverseerNodeDelete: (_leaseId, outcome) => {
        finishes.push(outcome);
        return { ok: true };
      },
    });
    const wrapped = await beforeTheWrite(
      Effect.gen(function* () {
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(gate);
      }),
      // node.delete lists the canvases for the grant and for its own early
      // check before the write lists them again.
      3,
    );
    const fiber = runtime!.runFork(
      executeOverseerCanvas(CALLER, { operation: "node.delete", args: { nodeIds: ["peer"] } })
        .pipe(Effect.provideService(ModelService, wrapped)),
    );
    await runtime!.runPromise(Deferred.await(entered));
    await runtime!.runPromise(Fiber.interrupt(fiber));
    await runtime!.runPromise(Deferred.succeed(gate, undefined));
    expect(await nodeAt("ops", "peer")).toBeDefined();
    expect(finishes).toEqual(["aborted"]);
  });

  it("reports finish failure after a successful commit", async () => {
    await boot();
    setOverseerNativeDeleteHooks({
      prepareOverseerNodeDelete: async () => ({ ok: true, leaseId: "lease-finish", pageStops: [] }),
      finishOverseerNodeDelete: (_leaseId, outcome) =>
        outcome === "committed" ? { ok: false, error: "terminal still attached" } : { ok: true },
    });
    const error = await expectErr({ operation: "node.delete", args: { nodeIds: ["peer"] } }, "InternalError");
    expect(error.message).toContain("finish failed after commit");
    expect(await nodeAt("ops", "peer")).toBeUndefined();
  });

  it("deleting a seat plans its session and its agent for teardown, and a page by its node", async () => {
    await boot();
    const planned: Array<ReadonlyArray<unknown>> = [];
    setOverseerNativeDeleteHooks({
      prepareOverseerNodeDelete: async (resources) => {
        planned.push(resources);
        return { ok: true, leaseId: "lease-plan", pageStops: [] };
      },
      finishOverseerNodeDelete: () => ({ ok: true }),
    });
    await expectOk({ operation: "node.delete", args: { nodeIds: ["peer"] } });
    expect(planned).toEqual([[
      { kind: "agent", agentKey: "local:amp" },
      { kind: "terminal", bindingId: "bind-peer", hostId: THIS_MACHINE },
    ]]);
  });
});
