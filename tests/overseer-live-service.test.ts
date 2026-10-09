import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Layer, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, describe, expect, it } from "vitest";
import {
  grantOverseer,
  ModelStoresLive,
  seedCanvas,
} from "./support/seed-canvas";
import { makeContentServiceLive } from "../src/main/junto/content/service";
import { makeInstallOpsLive } from "../src/main/junto/install-ops/engine";
import { executeOverseerCanvas } from "../src/main/junto/overseer/canvas";
import { buildLiveContext, type LiveCanvasRead } from "../src/main/junto/overseer/live/context";
import { OverseerLiveExecution, type OverseerHostIdentity } from "../src/main/junto/overseer/live/execution";
import { makeLiveRepository } from "../src/main/junto/overseer/live/repository";
import { canvasRevisionOf, readLiveCanvas } from "../src/main/junto/overseer/live/composition";
import { ModelService } from "../src/main/junto/model/service";
import { createLiveSessionService } from "../src/main/junto/overseer/live/service";
import { SettingsLive } from "../src/main/junto/settings/service";
import { makeStateEngineLive } from "../src/main/junto/state/engine";
import { MachineRepositoryLive } from "../src/main/junto/machines/repository";
import { nameThisMachine } from "./support/name-this-machine";
import { WorkRevisions, WorkRevisionsLive, WorkRepository, WorkRepositoryLive } from "../src/main/junto/work/repository";
import { runOverseerTurn } from "../src/overseer-host/session";
import { asNodeId, type Node } from "../src/shared/model";
import { note, seat } from "./support/model-nodes";
import { formatNodeRef } from "../src/shared/node-ref";
import type { OverseerRequest, OverseerResult } from "../src/shared/overseer-control";
import type { OverseerHostRun } from "../src/shared/overseer-host-control";
import type { LiveAttention } from "../src/shared/overseer-live";
import { defaultSettings } from "../src/shared/settings";

const identity: OverseerHostIdentity = {
  canvasName: "factory", nodeId: "controller", bindingId: "live-controller",
  generationId: "generation-started",
};
const attention = (nodeId = "first"): LiveAttention => ({ canvasName: "factory", selectedNodeIds: [nodeId] });
const nodes = (): ReadonlyArray<Node> => [
  seat("controller", { width: 260, height: 100, label: "Controller", agentKey: "local:junto-overseer",
    harness: "junto-overseer", bindingId: identity.bindingId as never }),
  note("first", "First note", { x: 300, y: 0, width: 200, height: 100 }),
  note("second", "Second note", { x: 600, y: 0, width: 200, height: 100 }),
];
const disposals: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of disposals.splice(0).reverse()) await dispose(); });

/** Real app graph and Live journal owners, with only network and occupant inputs replaced. */
const boot = async () => {
  const root = await mkdtemp(join(tmpdir(), "command-live-poc-"));
  const repositories = Layer.provideMerge(Layer.mergeAll(
    WorkRepositoryLive, MachineRepositoryLive, SettingsLive,
    WorkRevisionsLive,
    makeContentServiceLive({ root: join(root, "content"), skipInlineMediaMigration: true }),
  ), Layer.mergeAll(makeStateEngineLive(join(root, "state.db")), makeInstallOpsLive(join(root, "install-ops.db"))));
  const runtime = ManagedRuntime.make(Layer.provideMerge(ModelStoresLive, repositories));
  disposals.push(async () => {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  });
  await runtime.runPromise(nameThisMachine);
  await runtime.runPromise(seedCanvas("factory", nodes()));
  await runtime.runPromise(grantOverseer(identity.canvasName, identity.nodeId, true));
  const repository = makeLiveRepository(await runtime.runPromise(SqlClient.SqlClient));
  let currentIdentity: OverseerHostIdentity | undefined = identity;
  let authorityListener: ((value: OverseerHostIdentity | undefined) => void) | undefined;
  let providerCount = 0;
  const feedback: Array<{ content: string; spoken: boolean; delegationId: string | null }> = [];
  const revisions = new Map<string, string>();
  const service = createLiveSessionService({
    repository, run: (effect) => runtime.runPromise(effect),
    canvasRevision: canvasRevisionOf(await runtime.runPromise(ModelService as never) as never),
    workRevisions: await runtime.runPromise(WorkRevisions),
    settingsService: { get: Effect.succeed(defaultSettings()), resolveProviders: Effect.succeed({ openai: { apiKey: "test-key" } }) },
    resolveOccupant: async () => currentIdentity,
    subscribeAuthorityChanges: (listener) => { authorityListener = listener; return () => { authorityListener = undefined; }; },
    contextProvider: async (currentAttention) => {
      const read = await runtime.runPromise(readLiveCanvas(currentAttention.canvasName) as never) as LiveCanvasRead;
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
    // The overseer names more stores than this rig builds; a move reads only the model.
    runtime.runPromise(executeOverseerCanvas(identity, request).pipe(Effect.provideService(OverseerLiveExecution, constraint)) as never);
  return {
    runtime, repository, service, feedback, transcript, delegation, next, assigned, enqueue, move, execute,
    sessionId: live.sessionId,
    graph: () => runtime.runPromise(readLiveCanvas("factory") as never) as Promise<LiveCanvasRead>,
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
        arguments: JSON.stringify({ canvas: "factory", steps: [
          { operation: "node.move", nodeId: "first", x: 900, y: 30 },
          { operation: "node.create", node: { id: "summary", kind: "note", text: "Summary", x: 500, y: 200, width: 220, height: 100 } },
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
    expect(after.canvas.nodes.get(asNodeId("first"))).toMatchObject({ x: 900, y: 30 });
    expect(after.canvas.nodes.get(asNodeId("summary"))).toMatchObject({ text: "Summary" });
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
    await test.runtime.runPromise(executeOverseerCanvas(identity, { operation: "node.move", args: { nodeId: "first", x: 777, y: 88 } }) as never);
    const operatorState = await test.graph();
    await expect(test.execute(request, constraint)).rejects.toThrow("Canvas changed after this request was captured");
    expect((await test.graph()).revision).toBe(operatorState.revision);
    expect((await test.graph()).canvas.nodes.get(asNodeId("first"))).toMatchObject({ x: 777, y: 88 });
  });

  it("checks durable cancellation even when the in-memory dispatch fence still passes", async () => {
    const test = await boot();
    const run = await test.enqueue("Move the first note", "durable-cancel");
    const request = test.move(run);
    const constraint = await test.service.validateOperation(request, identity);
    const before = await test.graph();
    await test.runtime.runPromise(test.repository.setRequestStatus(run.requestId, run.intentRevision, "cancelled"));
    expect(() => constraint.assertCurrent()).not.toThrow();
    await expect(test.execute(request, constraint)).rejects.toThrow("Live request intent is no longer current");
    expect((await test.graph()).revision).toBe(before.revision);
    expect(await test.runtime.runPromise(test.repository.getOperation(request.live!.operationId))).toMatchObject({ status: "dispatched" });
  });

  it("rolls back when authority is revoked after the owner writes but before its receipt", async () => {
    const test = await boot();
    const run = await test.enqueue("Move the first note", "revoke-during-owner");
    const request = test.move(run);
    const constraint = await test.service.validateOperation(request, identity);
    const before = await test.graph();
    await expect(test.execute(request, {
      ...constraint,
      afterMutation: (name) => Effect.gen(function* () {
        test.authority(undefined);
        yield* Effect.yieldNow;
        yield* constraint.afterMutation!(name);
      }),
    })).rejects.toThrow("authority is no longer active");
    expect((await test.graph()).revision).toBe(before.revision);
    expect(await test.runtime.runPromise(test.repository.getOperation(request.live!.operationId))).not.toMatchObject({ status: "applied" });
  });

  it("rejects a changed Work revision while the authorial canvas revision stays current", async () => {
    const test = await boot();
    const run = await test.enqueue("Move the first note", "work-changed");
    const request = test.move(run);
    const constraint = await test.service.validateOperation(request, identity);
    const before = await test.graph();
    const work = await test.runtime.runPromise(WorkRepository);
    await test.runtime.runPromise(work.markBoardRead({ sink: { canvasName: "factory", nodeId: "first" },
      topicId: "inspected", principalKey: "operator", lastReadPosition: 0 }));
    const after = await test.graph();
    expect(after.revision).toBe(before.revision);
    expect(after.workRevision).not.toBe(before.workRevision);
    expect(() => constraint.assertCurrent()).not.toThrow();
    await expect(test.execute(request, constraint)).rejects.toThrow("Work changed after this request was captured");
    expect((await test.graph()).revision).toBe(before.revision);
    expect(await test.runtime.runPromise(test.repository.getOperation(request.live!.operationId))).toMatchObject({ status: "dispatched" });
  });

  it("rolls back the graph, applied receipt and journal event when a later participant fails", async () => {
    const test = await boot();
    const run = await test.enqueue("Move the first note", "receipt-rollback");
    const request = test.move(run);
    const constraint = await test.service.validateOperation(request, identity);
    const before = await test.graph();
    const events = await test.runtime.runPromise(test.repository.listEvents(test.sessionId));
    await expect(test.execute(request, {
      ...constraint,
      afterMutation: (name) => Effect.gen(function* () {
        yield* constraint.afterMutation!(name);
        expect(yield* test.repository.getOperation(request.live!.operationId)).toMatchObject({ status: "applied" });
        return yield* Effect.fail(new Error("later participant rejected"));
      }),
    })).rejects.toThrow("later participant rejected");
    expect((await test.graph()).revision).toBe(before.revision);
    expect(await test.runtime.runPromise(test.repository.getOperation(request.live!.operationId))).toMatchObject({ status: "dispatched" });
    expect(await test.runtime.runPromise(test.repository.listEvents(test.sessionId))).toEqual(events);
  });

  it("rejects worker dispatch at main admission even if a host submits an assigned operation id", async () => {
    const test = await boot();
    const run = await test.enqueue("Inspect the factory", "read");
    const request = { ...test.move(run), operation: "agent.prompt" as const, args: { nodeId: "worker", prompt: "Do work" } };
    await expect(test.service.validateOperation(request, identity)).rejects.toThrow("supports canvas editing and inspection only");
    expect(await test.runtime.runPromise(test.repository.listOperations(run.requestId))).toHaveLength(0);
  });
});
