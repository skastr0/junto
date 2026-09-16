import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ManagedRuntime } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { makeStateEngineLive, StateEngine } from "../src/main/junto/state/engine";
import { CURRENT_STATE_SCHEMA_VERSION, migrateStateSchema, STATE_SCHEMA_MIGRATION_PLAN, STATE_SCHEMA_V22_IDENTITY } from "../src/main/junto/state/migrations";
import { STATE_SCHEMA_V22_SQL } from "../src/main/junto/state/schema";
import { verifyRecordedStateSchemaIdentity } from "../src/main/junto/state/schema-identity";
import { assertLiveRequestCurrent, makeLiveRepository, operationArgsHash, transitionLiveOperationInTransaction, type LiveRequestCorrelation } from "../src/main/junto/overseer/live/repository";

const roots: string[] = [];
const runtimes: Array<ManagedRuntime.ManagedRuntime<StateEngine, unknown>> = [];
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const clock = () => "2026-09-12T12:00:00.000Z";
const binding = { sessionId: "session-1", seatNodeRef: "junto://factory/overseer", occupantGeneration: "42:start-1", authorityEpoch: "epoch-1" };
const requestInput = { requestId: "request-1", sessionId: binding.sessionId, providerDelegationId: "delegation-1", text: "Move the selected node",
  capturedContext: { canvasName: "factory", selectedNodeIds: ["a"], revision: "revision-1" }, transcriptRefs: ["transcript-1"] };
const correlation: LiveRequestCorrelation = { ...binding, requestId: requestInput.requestId, intentRevision: 1 };
const operationInput = { operationId: "operation-1", requestId: requestInput.requestId, intentRevision: 1, operation: "node.move",
  args: { canvasName: "factory", nodeId: "a", x: 100, y: 200 }, targetRefs: ["a"], targetRevision: "revision-1" };
const tempPath = async () => {
  const root = await mkdtemp(join(tmpdir(), "junto-live-test-"));
  roots.push(root);
  return join(root, "junto.db");
};
const open = async (configuredPath?: string) => {
  const path = configuredPath ?? await tempPath();
  const runtime = ManagedRuntime.make(makeStateEngineLive(path));
  runtimes.push(runtime);
  const state = await runtime.runPromise(StateEngine);
  const repository = makeLiveRepository(state, clock);
  return { runtime, state, repository, path };
};
const setup = async () => {
  const test = await open();
  await test.runtime.runPromise(test.repository.createSession(binding));
  await test.runtime.runPromise(test.repository.createRequest(requestInput));
  return test;
};

describe("durable Live journal", () => {
  it("deduplicates provider delegation and immutable operation identity", async () => {
    const { runtime, repository } = await setup();
    expect(await runtime.runPromise(repository.createRequest({ ...requestInput, requestId: "another-id", text: "A delayed duplicate" })))
      .toMatchObject({ created: false, request: { requestId: requestInput.requestId, text: requestInput.text } });
    expect(await runtime.runPromise(repository.proposeOperation(operationInput))).toMatchObject({ created: true });
    const reordered = { y: 200, x: 100, nodeId: "a", canvasName: "factory" };
    expect(operationArgsHash(reordered)).toBe(operationArgsHash(operationInput.args));
    expect(await runtime.runPromise(repository.proposeOperation({ ...operationInput, args: reordered }))).toMatchObject({ created: false });
    await expect(runtime.runPromise(repository.proposeOperation({ ...operationInput, args: { ...operationInput.args, x: 999 } }))).rejects.toThrow("different immutable intent");
    expect(await runtime.runPromise(repository.listRequests(binding.sessionId))).toHaveLength(1);
    expect(await runtime.runPromise(repository.listOperations(requestInput.requestId))).toHaveLength(1);
  });

  it("atomically fences a correction and invalidates only its pending operations", async () => {
    const { runtime, repository } = await setup();
    await runtime.runPromise(repository.proposeOperation(operationInput));
    await runtime.runPromise(repository.transitionOperation({ operationId: operationInput.operationId, from: "proposed", to: "admitted", correlation }));
    await runtime.runPromise(repository.createRequest({ ...requestInput, requestId: "independent", providerDelegationId: "other" }));
    await runtime.runPromise(repository.proposeOperation({ ...operationInput, operationId: "independent-op", requestId: "independent" }));
    const corrected = await runtime.runPromise(repository.updateRequestIntent(requestInput.requestId, 1,
      { text: "Use the other node", capturedContext: { selectedNodeIds: ["b"] }, transcriptRefs: ["transcript-2"] }));
    expect(corrected).toMatchObject({ intentRevision: 2, capturedContext: { selectedNodeIds: ["b"] } });
    expect((await runtime.runPromise(repository.listEvents(binding.sessionId))).filter((event) =>
      event.kind === "request.created" || event.kind === "request.revised").map((event) => event.detail.text))
      .toEqual([requestInput.text, requestInput.text, "Use the other node"]);
    expect(await runtime.runPromise(repository.getOperation(operationInput.operationId))).toMatchObject({ status: "failed", outcome: { reason: "intent-superseded" } });
    expect(await runtime.runPromise(repository.getOperation("independent-op"))).toMatchObject({ status: "proposed" });
    await expect(runtime.runPromise(repository.assertRequestCurrent(correlation))).rejects.toThrow("no longer current");
    await expect(runtime.runPromise(repository.updateRequestIntent(requestInput.requestId, 1,
      { text: "Stale correction", capturedContext: {}, transcriptRefs: [] }))).rejects.toThrow("no longer current");
  });

  it("retains late dispatched outcomes without making them current intent", async () => {
    const { runtime, repository } = await setup();
    await runtime.runPromise(repository.proposeOperation(operationInput));
    await runtime.runPromise(repository.transitionOperation({ operationId: operationInput.operationId, from: "proposed", to: "admitted", correlation }));
    await runtime.runPromise(repository.transitionOperation({ operationId: operationInput.operationId, from: "admitted", to: "dispatched", correlation }));
    await runtime.runPromise(repository.updateRequestIntent(requestInput.requestId, 1, { text: "Cancel that target", capturedContext: {}, transcriptRefs: [] }));
    const late = await runtime.runPromise(repository.transitionOperation({ operationId: operationInput.operationId, from: "dispatched", to: "applied", outcome: { fact: "prompt-delivered" } }));
    expect(late).toMatchObject({ intentRevision: 1, status: "applied", outcome: { fact: "prompt-delivered" } });
    await expect(runtime.runPromise(repository.setRequestStatus(requestInput.requestId, 1, "completed"))).rejects.toThrow("no longer current");
  });

  it("requires matching authority and commits mutation receipts in the owner's transaction", async () => {
    const { runtime, repository, state } = await setup();
    await runtime.runPromise(repository.proposeOperation(operationInput));
    await expect(runtime.runPromise(repository.transitionOperation({ operationId: operationInput.operationId, from: "proposed", to: "admitted",
      correlation: { ...correlation, authorityEpoch: "revoked" } }))).rejects.toThrow("authority or occupant changed");
    await runtime.runPromise(repository.transitionOperation({ operationId: operationInput.operationId, from: "proposed", to: "admitted", correlation }));
    await expect(runtime.runPromise(state.transaction("test.live-owned-mutation", (writer) => {
      assertLiveRequestCurrent(writer, correlation);
      writer.run("UPDATE overseer_live_sessions SET backend_conversation_id = 'changed' WHERE session_id = ?", [binding.sessionId]);
      transitionLiveOperationInTransaction(writer, { operationId: operationInput.operationId, from: "admitted", to: "applied", correlation, outcome: { fact: "canvas-committed" } });
      throw new Error("owner transaction fails");
    }))).rejects.toThrow("owner transaction fails");
    expect(await runtime.runPromise(repository.getOperation(operationInput.operationId))).toMatchObject({ status: "admitted" });
    expect(await runtime.runPromise(repository.getSession(binding.sessionId))).toMatchObject({ backendConversationId: null });
    await runtime.runPromise(state.transaction("test.live-owned-mutation", (writer) => {
      assertLiveRequestCurrent(writer, correlation);
      writer.run("UPDATE overseer_live_sessions SET backend_conversation_id = 'changed' WHERE session_id = ?", [binding.sessionId]);
      transitionLiveOperationInTransaction(writer, { operationId: operationInput.operationId, from: "admitted", to: "applied", correlation, outcome: { fact: "canvas-committed" } });
    }));
    expect(await runtime.runPromise(repository.getOperation(operationInput.operationId))).toMatchObject({ status: "applied" });
  });

  it("recovers interrupted effects as unknown without replay or automatic readmission", async () => {
    const { runtime, repository, path } = await setup();
    await runtime.runPromise(repository.updateSessionBackend(binding.sessionId, { backendConversationId: "conversation-1", providerSessionId: "provider-1" }));
    await runtime.runPromise(repository.proposeOperation(operationInput));
    await runtime.runPromise(repository.transitionOperation({ operationId: operationInput.operationId, from: "proposed", to: "admitted", correlation }));
    await runtime.runPromise(repository.transitionOperation({ operationId: operationInput.operationId, from: "admitted", to: "dispatched", correlation }));
    await runtime.dispose();
    const reopened = await open(path);
    expect(await reopened.runtime.runPromise(reopened.repository.recoverInterrupted())).toEqual({ interruptedSessions: 1, uncertainOperations: 1 });
    expect(await reopened.runtime.runPromise(reopened.repository.getSession(binding.sessionId))).toMatchObject({ status: "interrupted", backendConversationId: "conversation-1", providerSessionId: "provider-1" });
    expect(await reopened.runtime.runPromise(reopened.repository.getOperation(operationInput.operationId))).toMatchObject({ status: "unknown" });
    await expect(reopened.runtime.runPromise(reopened.repository.assertRequestCurrent(correlation))).rejects.toThrow("no longer current");
    await expect(reopened.runtime.runPromise(reopened.repository.transitionOperation({ operationId: operationInput.operationId, from: "unknown", to: "admitted", correlation }))).rejects.toThrow("Invalid Live operation transition");
    expect(await reopened.runtime.runPromise(reopened.repository.recoverInterrupted())).toEqual({ interruptedSessions: 0, uncertainOperations: 0 });
  });

  it("bounds event reads and prevents mismatched attribution or immutable history writes", async () => {
    const { runtime, repository, state } = await setup();
    await runtime.runPromise(repository.proposeOperation(operationInput));
    const first = await runtime.runPromise(repository.listEvents(binding.sessionId, 0, 2));
    expect(first).toHaveLength(2);
    const rest = await runtime.runPromise(repository.listEvents(binding.sessionId, first[1]!.sequence));
    expect(rest).toHaveLength(1);
    expect(rest[0]!.kind).toBe("operation.proposed");
    await expect(runtime.runPromise(repository.listEvents(binding.sessionId, 0, 201))).rejects.toThrow("between 1 and 200");
    await expect(runtime.runPromise(repository.createSession({ ...binding, sessionId: "duplicate-seat-session" }))).rejects.toThrow("UNIQUE constraint");
    await runtime.runPromise(repository.createSession({ ...binding, sessionId: "session-2", seatNodeRef: "another-seat" }));
    await expect(runtime.runPromise(repository.appendEvent({ sessionId: "session-2", requestId: requestInput.requestId, operationId: null, kind: "result", detail: {} }))).rejects.toThrow("another session");
    await expect(runtime.runPromise(state.transaction("test.immutable-live-receipt", (writer) => writer.run("UPDATE overseer_live_operations SET args_sha256 = ?", ["f".repeat(64)])))).rejects.toThrow("intent is immutable");
    await expect(runtime.runPromise(state.transaction("test.immutable-live-event", (writer) => writer.run("DELETE FROM overseer_live_events")))).rejects.toThrow("append-only");
  });

  it("recovers an uncertain native dispatch after the call was closed", async () => {
    const { runtime, repository } = await setup();
    await runtime.runPromise(repository.proposeOperation(operationInput));
    await runtime.runPromise(repository.transitionOperation({ operationId: operationInput.operationId, from: "proposed", to: "admitted", correlation }));
    await runtime.runPromise(repository.transitionOperation({ operationId: operationInput.operationId, from: "admitted", to: "dispatched", correlation }));
    await runtime.runPromise(repository.closeSession(binding.sessionId));
    expect(await runtime.runPromise(repository.recoverInterrupted())).toEqual({ interruptedSessions: 0, uncertainOperations: 1 });
    expect(await runtime.runPromise(repository.getOperation(operationInput.operationId))).toMatchObject({ status: "unknown" });
  });

  it("upgrades a populated production v22 database and retains every old row including immutable Work logs", async () => {
    const path = await tempPath();
    await copyFile(new URL("./fixtures/state-v1/remote-v1.db", import.meta.url), path);
    const version22 = new DatabaseSync(path);
    let before: Record<string, unknown[]>;
    try {
      migrateStateSchema(version22, { ...STATE_SCHEMA_MIGRATION_PLAN, currentVersion: 22,
        currentSchemaSql: STATE_SCHEMA_V22_SQL,
        migrations: STATE_SCHEMA_MIGRATION_PLAN.migrations.filter((migration) => migration.toVersion <= 22) });
      expect(verifyRecordedStateSchemaIdentity(version22)).toMatchObject(STATE_SCHEMA_V22_IDENTITY);
      version22.prepare("INSERT INTO provider_credential_bindings(credential_id, slot, lifecycle, created_at) VALUES (?, 'openrouter/apiKey', 'active', ?)")
        .run("c3cbb7c1-8f51-41f3-8d34-1e95cbb6ff88", clock());
      const tables = version22.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'state_schema_identity' ORDER BY name").all();
      before = Object.fromEntries(tables.map((row) => [String(row.name), version22.prepare(`SELECT * FROM "${String(row.name).replaceAll('"', '""')}"`).all()]));
      for (const table of ["work_events", "work_commands", "work_facts", "work_dispositions"]) expect(before[table]!.length).toBeGreaterThan(0);
    } finally { version22.close(); }
    const { runtime, state } = await open(path);
    expect(state.info.schemaVersion).toBe(CURRENT_STATE_SCHEMA_VERSION);
    expect(CURRENT_STATE_SCHEMA_VERSION).toBe(24);
    const after = await runtime.runPromise(state.read("test.live-migration-preservation", (reader) => Object.fromEntries(
      Object.keys(before).map((table) => [table, reader.all(`SELECT * FROM "${table.replaceAll('"', '""')}"`)]))));
    expect(after).toEqual(before);
    expect(await runtime.runPromise(state.read("test.live-new-tables", (reader) => reader.all(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND (name LIKE 'overseer_live_%' OR name = 'openai_credential_bindings') ORDER BY name"))))
      .toEqual(["openai_credential_bindings", "overseer_live_events", "overseer_live_operations", "overseer_live_requests", "overseer_live_sessions"].map((name) => ({ name })));
  });
});
