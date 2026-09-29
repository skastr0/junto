import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Effect, ManagedRuntime } from "effect";
import { SqlClient } from "effect/unstable/sql";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeStateEngineLive, StateEngine } from "../src/main/junto/state/engine";
import { StateTransactionOperation } from "../src/main/junto/state/service";
import { withSqlRead } from "../src/main/junto/state/sql-read";
import { CURRENT_STATE_SCHEMA_VERSION, STATE_SCHEMA_MIGRATIONS } from "../src/main/junto/state/migrations";
import { LiveRepository, makeLiveRepository, operationArgsHash, type LiveRequestCorrelation } from "../src/main/junto/overseer/live/repository";

const roots: string[] = [];
const runtimes: Array<ManagedRuntime.ManagedRuntime<StateEngine | SqlClient.SqlClient, unknown>> = [];
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
  const sql = await runtime.runPromise(SqlClient.SqlClient);
  const repository = makeLiveRepository(sql, clock);
  return { runtime, state, sql, repository, path };
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

  it("retains descending id tie-breaks and limits for session, request and operation reads", async () => {
    const { runtime, repository } = await setup();
    for (const suffix of ["3", "2"]) {
      await runtime.runPromise(repository.createSession({ ...binding, sessionId: `session-${suffix}`, seatNodeRef: `seat-${suffix}` }));
      await runtime.runPromise(repository.createRequest({ ...requestInput, requestId: `request-${suffix}`, providerDelegationId: `delegation-${suffix}` }));
      await runtime.runPromise(repository.proposeOperation({ ...operationInput, operationId: `operation-${suffix}` }));
    }
    await runtime.runPromise(repository.proposeOperation(operationInput));
    expect((await runtime.runPromise(repository.listSessions())).map((row) => row.sessionId)).toEqual(["session-3", "session-2", "session-1"]);
    expect((await runtime.runPromise(repository.listSessions(1))).map((row) => row.sessionId)).toEqual(["session-3"]);
    expect((await runtime.runPromise(repository.listRequests(binding.sessionId, 2))).map((row) => row.requestId)).toEqual(["request-3", "request-2"]);
    expect((await runtime.runPromise(repository.listOperations(requestInput.requestId, 2))).map((row) => row.operationId)).toEqual(["operation-3", "operation-2"]);
    expect(await runtime.runPromise(Effect.result(repository.listSessions(0)))).toMatchObject({
      _tag: "Failure", failure: { code: "invalid", message: "Live journal query limit must be between 1 and 200" },
    });
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

  it("keeps validation, hashing, clock and SQL failures typed and rolls back invalid revisions", async () => {
    const { runtime, repository, sql } = await setup();
    await runtime.runPromise(repository.proposeOperation(operationInput));
    const before = await runtime.runPromise(repository.listEvents(binding.sessionId));
    expect(await runtime.runPromise(Effect.result(repository.updateRequestIntent(requestInput.requestId, 1,
      { text: "Invalid correction", capturedContext: { bad: Number.NaN }, transcriptRefs: [] })))).toMatchObject({
      _tag: "Failure", failure: { _tag: "LiveJournalError", code: "invalid", message: "Live journal values must be finite JSON" },
    });
    expect(await runtime.runPromise(repository.getOperation(operationInput.operationId))).toMatchObject({ status: "proposed", outcome: null });
    expect(await runtime.runPromise(repository.getRequest(requestInput.requestId))).toMatchObject({ intentRevision: 1, text: requestInput.text });
    expect(await runtime.runPromise(repository.listEvents(binding.sessionId))).toEqual(before);
    expect(await runtime.runPromise(Effect.result(repository.proposeOperation({ ...operationInput, args: { bad: undefined } })))).toMatchObject({
      _tag: "Failure", failure: { code: "invalid", message: "Live journal values must be finite JSON" },
    });
    expect(await runtime.runPromise(Effect.result(repository.createSession(binding)))).toMatchObject({
      _tag: "Failure", failure: { code: "persistence", message: expect.stringContaining("UNIQUE constraint") },
    });
    expect(await runtime.runPromise(Effect.result(repository.assertRequestCurrentWithin({ ...correlation, intentRevision: 2 })))).toMatchObject({
      _tag: "Failure", failure: { code: "stale", message: "Live request intent is no longer current" },
    });
    const brokenClock = makeLiveRepository(sql, () => { throw new Error("clock unavailable"); });
    expect(await runtime.runPromise(Effect.result(brokenClock.closeSession(binding.sessionId)))).toMatchObject({
      _tag: "Failure", failure: { code: "persistence", message: "clock unavailable" },
    });
    expect(await runtime.runPromise(repository.getSession(binding.sessionId))).toMatchObject({ status: "active" });
  });

  it("decodes retained JSON through the SQL schema as a typed persistence failure", async () => {
    const { runtime, repository, sql } = await setup();
    await runtime.runPromise(sql.withTransaction(sql`UPDATE overseer_live_requests SET transcript_refs_json = '[17]' WHERE request_id = ${requestInput.requestId}`));
    expect(await runtime.runPromise(Effect.result(repository.getRequest(requestInput.requestId)))).toMatchObject({
      _tag: "Failure", failure: { _tag: "LiveJournalError", code: "persistence", message: expect.stringContaining("string") },
    });
  });

  it("reads captured objects and the clock when an effect runs, retaining insertion receipts", async () => {
    const { runtime, repository, sql } = await setup();
    const readClock = vi.fn(() => "2026-09-12T13:00:00.000Z");
    const delayed = makeLiveRepository(sql, readClock);
    const input = { ...requestInput, requestId: "request-late", providerDelegationId: "delegation-late", capturedContext: { node: "before" }, transcriptRefs: ["before"] };
    const create = delayed.createRequest(input);
    input.text = "Captured at execution";
    input.capturedContext.node = "after";
    input.transcriptRefs.push("after");
    expect(readClock).not.toHaveBeenCalled();
    expect(await runtime.runPromise(create)).toMatchObject({ created: true, request: {
      text: "Captured at execution", capturedContext: { node: "after" }, transcriptRefs: ["before", "after"], createdAt: "2026-09-12T13:00:00.000Z",
    } });
    expect(readClock).toHaveBeenCalledTimes(1);
    const detail = { node: "first" };
    const append = delayed.appendEvent({ sessionId: binding.sessionId, requestId: null, operationId: null, kind: "custom", detail });
    detail.node = "second";
    const receipt = await runtime.runPromise(append);
    detail.node = "third";
    // Append returns the caller's detail, while the immutable journal retains serialized bytes.
    expect(receipt.detail).toBe(detail);
    expect(await runtime.runPromise(repository.listEvents(binding.sessionId, 2))).toMatchObject([
      { sequence: 3, kind: "request.created", detail: { text: "Captured at execution" } },
      { sequence: 4, kind: "custom", detail: { node: "second" } },
    ]);
    expect(receipt.sequence).toBe(4);
  });

  it("keeps owning transaction names and lets participants join without another owner", async () => {
    const { runtime, sql } = await open();
    const names: string[] = [];
    const withTransaction = sql.withTransaction;
    const owner = vi.spyOn(sql, "withTransaction").mockImplementation(<A, E, R>(body: Effect.Effect<A, E, R>) =>
      withTransaction(Effect.gen(function* () {
        names.push(yield* StateTransactionOperation);
        return yield* body;
      })));
    try {
      const repository = makeLiveRepository(sql, clock);
      await runtime.runPromise(repository.createSession(binding));
      await runtime.runPromise(repository.createRequest(requestInput));
      expect(await runtime.runPromise(repository.assertRequestCurrent(correlation))).toMatchObject({ requestId: requestInput.requestId });
      await runtime.runPromise(repository.proposeOperation(operationInput));
      await runtime.runPromise(repository.transitionOperation({ operationId: operationInput.operationId, from: "proposed", to: "admitted", correlation }));
      await runtime.runPromise(sql.withTransaction(Effect.gen(function* () {
        yield* repository.assertRequestCurrentWithin(correlation);
        return yield* repository.transitionOperationWithin({ operationId: operationInput.operationId, from: "admitted", to: "applied", correlation }, "owner-time");
      })).pipe(Effect.provideService(StateTransactionOperation, "test.owner")));
      expect(names).toEqual(["live.session.create", "live.request.create", "live.operation.propose", "live.operation.transition", "test.owner"]);
      expect(owner).toHaveBeenCalledTimes(5);
      expect(await runtime.runPromise(repository.getOperation(operationInput.operationId))).toMatchObject({ status: "applied", updatedAt: "owner-time" });
      const fromLayer = await runtime.runPromise(LiveRepository.pipe(Effect.provide(LiveRepository.layer)));
      expect(await runtime.runPromise(fromLayer.getSession(binding.sessionId))).toMatchObject(binding);
    } finally { owner.mockRestore(); }
  });

  it("requires matching authority and commits mutation receipts in the owner's transaction", async () => {
    const { runtime, repository, sql } = await setup();
    await runtime.runPromise(repository.proposeOperation(operationInput));
    await expect(runtime.runPromise(repository.transitionOperation({ operationId: operationInput.operationId, from: "proposed", to: "admitted",
      correlation: { ...correlation, authorityEpoch: "revoked" } }))).rejects.toThrow("authority or occupant changed");
    await runtime.runPromise(repository.transitionOperation({ operationId: operationInput.operationId, from: "proposed", to: "admitted", correlation }));
    const eventsBefore = await runtime.runPromise(repository.listEvents(binding.sessionId));
    await expect(runtime.runPromise(sql.withTransaction(Effect.gen(function* () {
      yield* repository.assertRequestCurrentWithin(correlation);
      yield* sql`UPDATE overseer_live_sessions SET backend_conversation_id = 'changed' WHERE session_id = ${binding.sessionId}`;
      yield* repository.transitionOperationWithin({ operationId: operationInput.operationId, from: "admitted", to: "applied", correlation, outcome: { fact: "canvas-committed" } });
      return yield* Effect.fail(new Error("owner transaction fails"));
    })).pipe(Effect.provideService(StateTransactionOperation, "test.live-owned-mutation")))).rejects.toThrow("owner transaction fails");
    expect(await runtime.runPromise(repository.getOperation(operationInput.operationId))).toMatchObject({ status: "admitted" });
    expect(await runtime.runPromise(repository.getSession(binding.sessionId))).toMatchObject({ backendConversationId: null });
    expect(await runtime.runPromise(repository.listEvents(binding.sessionId))).toEqual(eventsBefore);
    await runtime.runPromise(sql.withTransaction(Effect.gen(function* () {
      yield* repository.assertRequestCurrentWithin(correlation);
      yield* sql`UPDATE overseer_live_sessions SET backend_conversation_id = 'changed' WHERE session_id = ${binding.sessionId}`;
      yield* repository.transitionOperationWithin({ operationId: operationInput.operationId, from: "admitted", to: "applied", correlation, outcome: { fact: "canvas-committed" } });
    })).pipe(Effect.provideService(StateTransactionOperation, "test.live-owned-mutation")));
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
    const { runtime, repository, sql } = await setup();
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
    await expect(runtime.runPromise(sql.withTransaction(sql`UPDATE overseer_live_operations SET args_sha256 = ${"f".repeat(64)}`)
      .pipe(Effect.provideService(StateTransactionOperation, "test.immutable-live-receipt")))).rejects.toThrow("intent is immutable");
    await expect(runtime.runPromise(sql.withTransaction(sql`DELETE FROM overseer_live_events`)
      .pipe(Effect.provideService(StateTransactionOperation, "test.immutable-live-event")))).rejects.toThrow("append-only");
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

  it("opens the populated v1 fixture and retains every kept table's rows including immutable Work logs", async () => {
    const path = await tempPath();
    await copyFile(new URL("./fixtures/state-v1/remote-v1.db", import.meta.url), path);
    const baseline = new DatabaseSync(path);
    let before: Record<string, unknown[]>;
    try {
      const tables = baseline.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'state_schema_identity' ORDER BY name").all();
      const retired = new Set(STATE_SCHEMA_MIGRATIONS.flatMap((step) => step.removesTables ?? []));
      before = Object.fromEntries(tables
        .filter((row) => !retired.has(String(row.name)))
        .map((row) => [String(row.name), baseline.prepare(`SELECT * FROM "${String(row.name).replaceAll('"', '""')}"`).all()]));
      for (const table of ["work_events", "work_commands", "work_facts", "work_dispositions"]) expect(before[table]!.length).toBeGreaterThan(0);
    } finally { baseline.close(); }
    const { runtime, state, sql } = await open(path);
    expect(state.info.schemaVersion).toBe(CURRENT_STATE_SCHEMA_VERSION);
    const after = await runtime.runPromise(withSqlRead(sql, Effect.gen(function* () {
      return Object.fromEntries(yield* Effect.forEach(Object.keys(before), (table) =>
        sql`SELECT * FROM ${sql(table)}`.pipe(Effect.map((rows) => [table, rows]))));
    })));
    expect(after).toEqual(before);
    expect(await runtime.runPromise(sql`SELECT name FROM sqlite_schema WHERE type = 'table' AND (name LIKE 'overseer_live_%' OR name = 'openai_credential_bindings') ORDER BY name`))
      .toEqual(["openai_credential_bindings", "overseer_live_events", "overseer_live_operations", "overseer_live_requests", "overseer_live_sessions"].map((name) => ({ name })));
  });
});
