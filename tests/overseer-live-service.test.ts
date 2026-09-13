import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { CanvasesLive, CanvasesService } from "../src/main/vellum-command/canvases";
import { makeContentServiceLive } from "../src/main/vellum-command/content/service";
import { makeInstallOpsLive } from "../src/main/vellum-command/install-ops/engine";
import { executeOverseerCanvas } from "../src/main/vellum-command/overseer/canvas";
import { buildLiveContext } from "../src/main/vellum-command/overseer/live/context";
import { OverseerLiveExecution, type OverseerHostIdentity } from "../src/main/vellum-command/overseer/live/execution";
import { makeLiveRepository } from "../src/main/vellum-command/overseer/live/repository";
import { createLiveSessionService } from "../src/main/vellum-command/overseer/live/service";
import { SettingsLive } from "../src/main/vellum-command/settings/service";
import { makeStateEngineLive, StateEngine } from "../src/main/vellum-command/state/engine";
import { StationFleetTargetRepositoryLive } from "../src/main/vellum-command/station/fleet-target-repository";
import { StationRepositoryLive } from "../src/main/vellum-command/station/repository";
import { WorkRepositoryLive } from "../src/main/vellum-command/work/repository";
import { runOverseerTurn } from "../src/overseer-host/session";
import { applyMirrorLaw, type CanvasDoc } from "../src/shared/canvas";
import { formatNodeRef } from "../src/shared/node-ref";
import type { OverseerRequest, OverseerResult } from "../src/shared/overseer-control";
import type { OverseerHostRun } from "../src/shared/overseer-host-control";
import type { LiveAttention } from "../src/shared/overseer-live";
import { defaultSettings } from "../src/shared/settings";

const identity: OverseerHostIdentity = {
  canvasName: "factory", nodeId: "controller", bindingId: "live-controller",
  peerPid: 4242, processGeneration: "4242:started",
};
const attention = (nodeId = "first"): LiveAttention => ({ canvasName: "factory", selectedNodeIds: [nodeId] });
const document = (): CanvasDoc => applyMirrorLaw({ nodes: [
  { id: "controller", type: "text", text: "Controller", x: 0, y: 0, width: 260, height: 100,
    ether: { entity: { kind: "agent", name: "local:vellum-overseer" }, host: "local",
      terminal: { bindingId: identity.bindingId, harness: "vellum-overseer" } } },
  { id: "first", type: "text", text: "First note", x: 300, y: 0, width: 200, height: 100 },
  { id: "second", type: "text", text: "Second note", x: 600, y: 0, width: 200, height: 100 },
], edges: [] });
const disposals: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose(); });

/** Real app graph and Live journal owners, with only network and occupant inputs replaced. */
const boot = async () => {
  const root = await mkdtemp(join(tmpdir(), "command-live-poc-"));
  const previous = process.env.VELLUM_COMMAND_CANVASES_DIR;
  process.env.VELLUM_COMMAND_CANVASES_DIR = join(root, "canvases");
  const repositories = Layer.provideMerge(Layer.mergeAll(
    WorkRepositoryLive, StationRepositoryLive, StationFleetTargetRepositoryLive, SettingsLive,
    makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true }),
  ), Layer.mergeAll(makeStateEngineLive(join(root, "state.db")), makeInstallOpsLive(join(root, "install-ops.db"))));
  const runtime = ManagedRuntime.make(Layer.provideMerge(CanvasesLive, repositories));
  disposals.push(async () => {
    await runtime.dispose();
    if (previous === undefined) delete process.env.VELLUM_COMMAND_CANVASES_DIR;
    else process.env.VELLUM_COMMAND_CANVASES_DIR = previous;
    await rm(root, { recursive: true, force: true });
  });
  const canvases = await runtime.runPromise(CanvasesService);
  await runtime.runPromise(canvases.write("factory", document()));
  const initial = await runtime.runPromise(canvases.read("factory"));
  await runtime.runPromise(canvases.canvasOverseerSet({ ...identity, overseer: true, expectedRevision: initial.revision }));
  const repository = makeLiveRepository(await runtime.runPromise(StateEngine));
  let currentIdentity: OverseerHostIdentity | undefined = identity;
  let authorityListener: ((value: OverseerHostIdentity | undefined) => void) | undefined;
  let providerCount = 0;
  const feedback: Array<{ content: string; spoken: boolean; delegationId: string | null }> = [];
  const revisions = new Map<string, string>();
  const service = createLiveSessionService({
    repository, run: (effect) => runtime.runPromise(effect),
    settingsService: { get: Effect.succeed(defaultSettings()), resolveProviders: Effect.succeed({ openai: { apiKey: "test-key" } }) },
    resolveOccupant: async () => currentIdentity,
    subscribeAuthorityChanges: (listener) => { authorityListener = listener; return () => { authorityListener = undefined; }; },
    contextProvider: async (currentAttention) => {
      const read = await runtime.runPromise(canvases.read(currentAttention.canvasName));
      revisions.set(read.name, read.revision);
      return buildLiveContext(read, currentAttention);
    },
    targetRevision: (name) => revisions.get(name),
    pollTimeoutMs: 1,
    connectionProvider: async () => ({
      sessionId: `provider-${++providerCount}`, answerSdp: "test-answer", sidebandReady: true,
      ready: Promise.resolve(), close: async () => ({ finalized: true, reason: "session-ended" }),
      sendQuiet: (_id, delegationId, content) => { feedback.push({ content, spoken: false, delegationId }); },
      sendCommentary: (_id, delegationId, content) => { feedback.push({ content, spoken: true, delegationId }); },
    }),
  });
  disposals.push(() => service.dispose());
  const start = async () => {
    const value = await service.liveStart({ ...identity, attention: attention(), offerSdp: "test-offer" });
    await service.liveReady(value.sessionId, value.connectionEpoch);
    return value;
  };
  let live = await start();
  let utterance = 0;
  const transcript = async (text: string, id = `speech-${++utterance}`) => {
    await service.liveProviderEvent(live.sessionId, live.connectionEpoch, {
      type: "session.input_transcript.delta", event_id: id, delta: text, start_ms: 0, end_ms: 100,
    });
  };
  const delegation = async (id: string) => {
    await service.liveProviderEvent(live.sessionId, live.connectionEpoch, {
      type: "session.delegation.created", event_id: `event-${id}`, offset_ms: 200,
      delegation: { id, type: "delegation", target: "client" },
    });
  };
  const next = () => service.onHost({ type: "next" }, identity, new AbortController().signal);
  const assigned = async (): Promise<OverseerHostRun> => {
    const value = await next();
    expect(value.type).toBe("run");
    if (value.type !== "run") throw new Error("Expected a controller request");
    return value;
  };
  const enqueue = async (text: string, id: string) => { await transcript(text); await delegation(id); return assigned(); };
  const move = (run: OverseerHostRun): OverseerRequest => ({ operation: "node.move", args: { nodeId: "first", x: 900, y: 30 },
    live: { sessionId: run.sessionId, requestId: run.requestId, intentRevision: run.intentRevision,
      operationId: run.operationIds[0]!, expectedRevision: run.expectedRevision } });
  const execute = (request: OverseerRequest, constraint: Awaited<ReturnType<typeof service.validateOperation>>) =>
    runtime.runPromise(executeOverseerCanvas(identity, request).pipe(Effect.provideService(OverseerLiveExecution, constraint)));
  return {
    runtime, canvases, repository, service, feedback, transcript, delegation, next, assigned, enqueue, move, execute,
    sessionId: live.sessionId,
    graph: () => runtime.runPromise(canvases.read("factory")),
    reconnect: async () => { live = await start(); return live; },
    authority: (value: OverseerHostIdentity | undefined) => { currentIdentity = value; authorityListener?.(value); },
  };
};

describe("Live POC with the real canvas and durable journal", () => {
  it("delegates speech through the backend host, commits a batch with its receipt, and grounds spoken feedback", async () => {
    const test = await boot();
    const run = await test.enqueue("Move the first note and create a summary note", "edit");
    const before = await test.graph();
    let responses = 0;
    await runOverseerTurn(run, {
      respond: async () => responses++ === 0 ? { status: "completed", output: [{
        type: "function_call", call_id: "batch-call", name: "canvas__batch",
        arguments: JSON.stringify({ canvas: "factory", operations: [
          { operation: "node.move", nodeId: "first", x: 900, y: 30 },
          { operation: "node.create", node: { id: "summary", type: "text", text: "Summary", x: 500, y: 200, width: 220, height: 100 } },
        ] }),
      }] } : { status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: "Moved the first note and created Summary." }] }] },
      tool: async (request) => {
        const constraint = await test.service.validateOperation(request, identity);
        const data = await test.execute(request, constraint);
        // The owner has already committed the receipt before transport settlement.
        expect(await test.runtime.runPromise(test.repository.getOperation(request.live!.operationId)))
          .toMatchObject({ status: "applied", outcome: { committed: true } });
        const receipt: OverseerResult = { ok: true, operation: request.operation, data };
        await constraint.settle?.(receipt);
        return receipt;
      },
      event: async (event) => { await test.service.onHost({ type: "event", sessionId: run.sessionId, requestId: run.requestId, intentRevision: run.intentRevision, event }, identity, new AbortController().signal); },
      control: async (request, signal) => test.service.onHost(request, identity, signal),
    }, new AbortController().signal);
    const after = await test.graph();
    expect(after.revision).not.toBe(before.revision);
    expect(after.doc.nodes.find((node) => node.id === "first")).toMatchObject({ x: 900, y: 30 });
    expect(after.doc.nodes.find((node) => node.id === "summary")).toMatchObject({ text: "Summary" });
    const operations = await test.runtime.runPromise(test.repository.listOperations(run.requestId));
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ status: "applied", targetRefs: expect.arrayContaining([formatNodeRef({ canvasName: "factory", nodeId: "first" })]) });
    expect(await test.runtime.runPromise(test.repository.getRequest(run.requestId))).toMatchObject({ status: "completed" });
    expect(test.feedback).toContainEqual(expect.objectContaining({ spoken: true, delegationId: "edit", content: expect.stringContaining("1 tool receipts confirmed") }));
    const followUp = await test.enqueue("What did you just change?", "follow-up");
    expect(JSON.stringify(followUp.conversation)).toContain("Moved the first note and created Summary.");
    expect(followUp.context).toContain("summary");
  });

  it("does not create work from transcript alone or replay duplicate delegation after reconnect", async () => {
    const test = await boot();
    await test.transcript("Explain the selected note");
    expect(await test.runtime.runPromise(test.repository.listRequests(test.sessionId))).toHaveLength(0);
    await test.delegation("once");
    await test.delegation("once");
    const run = await test.assigned();
    const reconnect = await test.reconnect();
    expect(reconnect.sessionId).toBe(run.sessionId);
    expect(reconnect.connectionEpoch).toBe(2);
    await test.transcript("A delayed duplicate", "replayed-speech");
    await test.delegation("once");
    expect(await test.runtime.runPromise(test.repository.listRequests(test.sessionId))).toHaveLength(1);
    expect(await test.next()).toEqual({ type: "idle" });
  });

  it("rejects an admitted operation after correction and before the graph transaction", async () => {
    const test = await boot();
    const run = await test.enqueue("Move the first note", "move");
    const request = test.move(run);
    const constraint = await test.service.validateOperation(request, identity);
    const before = await test.graph();
    await test.service.liveSteer(run.sessionId, run.requestId, "Move the second note instead", attention("second"));
    expect(constraint.signal?.aborted).toBe(true);
    await expect(test.execute(request, constraint)).rejects.toThrow("intent is no longer current");
    expect((await test.graph()).revision).toBe(before.revision);
    const corrected = await test.assigned();
    expect(corrected).toMatchObject({ requestId: run.requestId, intentRevision: run.intentRevision + 1 });
    expect(JSON.parse(corrected.context).capturedContext.operatorAttention.selectedNodeIds).toEqual(["second"]);
    expect(await test.runtime.runPromise(test.repository.getOperation(request.live!.operationId))).not.toMatchObject({ status: "applied" });
  });

  it("latches grant revocation even when the same occupant is immediately granted again", async () => {
    const test = await boot();
    const run = await test.enqueue("Move the first note", "revoked");
    const request = test.move(run);
    const constraint = await test.service.validateOperation(request, identity);
    const before = await test.graph();
    test.authority(undefined);
    test.authority(identity);
    expect(constraint.signal?.aborted).toBe(true);
    await expect(test.execute(request, constraint)).rejects.toThrow("authority is no longer active");
    expect((await test.graph()).revision).toBe(before.revision);
    expect(await test.service.liveSnapshot()).toMatchObject({ authority: "revoked", actionsStopped: true });
  });

  it("uses the spoken correction's captured selection, not a later renderer selection", async () => {
    const test = await boot();
    const original = await test.enqueue("Move the first note", "original");
    await test.service.liveAttention(test.sessionId, attention("second"));
    const correction = await test.enqueue("Use this note instead", "correction");
    await test.service.liveAttention(test.sessionId, attention("first"));
    await test.service.onHost({ type: "steer", sessionId: test.sessionId, requestId: correction.requestId,
      intentRevision: correction.intentRevision, targetRequestId: original.requestId, text: "Move the selected note instead" }, identity, new AbortController().signal);
    const revised = await test.assigned();
    expect(revised.requestId).toBe(original.requestId);
    expect(JSON.parse(revised.context).capturedContext.operatorAttention.selectedNodeIds).toEqual(["second"]);
  });

  it("preserves a concurrent operator edit instead of committing against an obsolete graph", async () => {
    const test = await boot();
    const run = await test.enqueue("Move the first note", "stale");
    const request = test.move(run);
    const constraint = await test.service.validateOperation(request, identity);
    await test.runtime.runPromise(executeOverseerCanvas(identity, { operation: "node.move", args: { nodeId: "first", x: 777, y: 88 } }));
    const operatorState = await test.graph();
    await expect(test.execute(request, constraint)).rejects.toThrow("Canvas changed after this request was captured");
    expect((await test.graph()).revision).toBe(operatorState.revision);
    expect((await test.graph()).doc.nodes.find((node) => node.id === "first")).toMatchObject({ x: 777, y: 88 });
  });

  it("rejects worker dispatch at main admission even if a host submits an assigned operation id", async () => {
    const test = await boot();
    const run = await test.enqueue("Inspect the factory", "read");
    const request = { ...test.move(run), operation: "agent.prompt" as const, args: { nodeId: "worker", prompt: "Do work" } };
    await expect(test.service.validateOperation(request, identity)).rejects.toThrow("supports canvas editing and inspection only");
    expect(await test.runtime.runPromise(test.repository.listOperations(run.requestId))).toHaveLength(0);
  });
});
