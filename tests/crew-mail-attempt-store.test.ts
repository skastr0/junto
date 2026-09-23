import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Layer, ManagedRuntime, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CanvasDoc, Message } from "../src/shared/canvas";
import { InstallationId } from "../src/shared/installation-id";
import type { ManagedPromptOutcome } from "../src/shared/managed-prompt";
import type { ActorRef } from "../src/shared/work-protocol";
import { compileActorSeatRegistry } from "../src/main/junto/station/actor-seat-compiler";
import { makeStateEngineLive, StateEngine } from "../src/main/junto/state/engine";
import { CrewRepository, CrewRepositoryLive } from "../src/main/junto/work/crew-repository";
import { makeMailAttemptStore } from "../src/main/junto/work/mail-attempt-store";
import {
  MessageDeliveryService,
  type MessageDeliveryAttemptStore,
  type MessageDeliveryStore,
} from "../src/main/junto/work/message-delivery";

const canvas = "mail-factory";
const nodeId = "recipient-node";
const bindingId = "recipient-process";
const installation = Schema.decodeUnknownSync(InstallationId)("mail-test-installation");
const iso = (n: number): string => new Date(1_760_000_000_000 + n).toISOString();
const root = join(tmpdir(), `junto-mail-store-${randomUUID()}`);

const recipientDoc = (messages: ReadonlyArray<Message> = []): CanvasDoc => ({
  nodes: [{
    id: nodeId, type: "text", text: "Recipient", x: 0, y: 0, width: 100, height: 80,
    ether: {
      entity: { kind: "agent", name: "local:recipient" },
      host: "local",
      terminal: { bindingId, harness: "claude", launch: { kind: "harness", argv: ["claude"] } },
      messages: { items: [...messages] },
    },
  }],
  edges: [],
});

// The recipient is compiled from installation + executable binding. The canvas
// node remains a routing handle and must never become a durable seat identity.
const compiled = compileActorSeatRegistry(
  new Map([[canvas, recipientDoc()]]), new Map([["local", installation]]),
)[0]!;
const recipient: ActorRef = { seatId: compiled.seatId, canvasName: canvas, nodeId };
const key = (messageId: string, generation = "generation-1") => ({
  canvas, nodeId, messageId, generation,
});

const openFixture = async (directory: string) => {
  const runtime = ManagedRuntime.make(Layer.provideMerge(
    CrewRepositoryLive, makeStateEngineLive(join(directory, "junto.db")),
  ));
  const repository = await runtime.runPromise(CrewRepository);
  const state = await runtime.runPromise(StateEngine);
  const store = makeMailAttemptStore({
    repository,
    resolveSeat: async () => recipient,
    run: (effect) => runtime.runPromise(effect),
    now: () => iso(100),
  });
  return { runtime, repository, state, store };
};

let fixture: Awaited<ReturnType<typeof openFixture>>;
beforeAll(async () => { fixture = await openFixture(root); });
afterAll(async () => {
  await fixture.runtime.dispose();
  await rm(root, { recursive: true, force: true });
});

const submitted = (): ManagedPromptOutcome => ({
  status: "submitted", bindingGeneration: 1, writesBefore: 0, writesAfter: 1,
  pasteWrites: 1, wrotePhysicalBytes: true,
});

/** Real delivery service with only the external transport and document read supplied. */
const delivery = (input: {
  attempts: MessageDeliveryAttemptStore;
  messageId: string;
  generation: string;
  write: () => Promise<ManagedPromptOutcome>;
  accept?: () => boolean | Promise<boolean>;
  onRead?: () => void;
}) => {
  const doc = recipientDoc([{
    messageId: input.messageId, role: "user", parts: [{ kind: "text", text: "mail body" }],
  }]);
  let now = 1_760_000_000_000;
  let receipts = 0;
  const store: MessageDeliveryStore = {
    listCanvasNames: async () => [canvas],
    readDoc: async () => { input.onRead?.(); return doc; },
    readNodeStructure: async () => ({ node: doc.nodes[0]!, structure: doc }),
    hasAcceptedMessageDelivery: async () => receipts > 0,
    hasAcceptedMessageRead: async () => false,
    acceptMessageDelivery: async () => {
      if (await input.accept?.() === false) return false;
      receipts += 1;
      return true;
    },
    acceptMessageRead: async () => true,
  };
  const service = new MessageDeliveryService();
  service.configure({
    attempts: input.attempts, store, now: () => now,
    timers: { set: () => ({}), clear: () => {} },
    transport: {
      seatDeliverySnapshot: () => ({ generationKey: input.generation }),
      sendManagedTerminalPrompt: async (receivedBinding) => {
        expect(receivedBinding).toBe(bindingId);
        return input.write();
      },
    },
  });
  return {
    service,
    receipts: () => receipts,
    attempt: () => service.prompt({ canvas, nodeId, messageId: input.messageId }),
  };
};

describe("mail attempt store over the product StateEngine", () => {
  it("persists the compiled recipient and preserves its identity across process generations", async () => {
    const first = await fixture.store.enqueueAttempt({ ...key("identity"), policy: "notice", at: iso(1) });
    const next = await fixture.store.enqueueAttempt({ ...key("identity", "generation-2"), policy: "immediate", at: iso(2) });
    expect(first.recipient).toEqual({ seat: recipient, generation: "generation-1" });
    expect(next.recipient).toEqual({ seat: recipient, generation: "generation-2" });
    expect(first.recipient.seat.seatId).not.toBe(nodeId);
    const rows = await fixture.runtime.runPromise(fixture.repository.attemptsForMessage(
      { canvasName: canvas, nodeId }, "identity",
    ));
    expect(rows.map((row) => row.recipient)).toEqual([first.recipient, next.recipient]);
    const stored = await fixture.runtime.runPromise(fixture.state.read("test.mail-recipient", (reader) =>
      reader.get<{ readonly recipient_seat_id: string }>(
        "SELECT recipient_seat_id FROM work_mail_attempts WHERE message_id = ? LIMIT 1", ["identity"],
      ),
    ));
    expect(stored?.recipient_seat_id).toBe(compiled.seatId);
    const requeued = await fixture.store.enqueueAttempt({ ...key("identity"), policy: "notice", at: iso(3) });
    expect(requeued.facts.queuedAt).toBe(iso(1));
  });

  it("commits every batch member with one batch ID and rolls back a partially invalid batch", async () => {
    const rows = await fixture.store.enqueueBatch({
      canvas, nodeId, batchId: "batch-complete", at: iso(10),
      members: ["batch-a", "batch-b"].map((messageId) => ({ messageId, generation: "generation-1", policy: "notice" })),
    });
    expect(rows.map((row) => [row.messageId, row.batchId, row.recipient.seat])).toEqual([
      ["batch-a", "batch-complete", recipient], ["batch-b", "batch-complete", recipient],
    ]);
    expect(rows.every((row) => row.facts.attemptedAt === undefined)).toBe(true);
    await expect(fixture.store.enqueueBatch({
      canvas, nodeId, batchId: "batch-invalid",
      members: ["rollback-first", ""].map((messageId) => ({ messageId, generation: "generation-1", policy: "notice" })),
    })).rejects.toThrow();
    expect(await fixture.store.attempt(key("rollback-first"))).toBeUndefined();
  });

  it("assigns the actual batch to rows already queued by a no-write gate refusal", async () => {
    await fixture.store.enqueueAttempt({ ...key("queued-before-batch"), policy: "notice", at: iso(20) });
    await fixture.store.recordAttempt({ ...key("queued-before-batch"), set: { refusedAt: iso(21), refusedReason: "not-settled" } });
    const rows = await fixture.store.enqueueBatch({
      canvas, nodeId, batchId: "batch-after-settle", at: iso(22),
      members: ["queued-before-batch", "new-batch-member"].map((messageId) => ({ messageId, generation: "generation-1", policy: "notice" })),
    });
    expect(rows.map((row) => row.batchId)).toEqual(["batch-after-settle", "batch-after-settle"]);
    expect(rows[0]!.facts.queuedAt).toBe(iso(20));
    expect(rows[0]!.facts.refusedAt).toBe(iso(21));
  });

  it("commits intent before transport and outcome before the receipt", async () => {
    const messageId = "ordered";
    const events: string[] = [];
    const flow = delivery({
      attempts: fixture.store, messageId, generation: "generation-1",
      write: async () => {
        const intent = await fixture.store.attempt(key(messageId));
        expect(intent?.facts.attemptedAt).toBe(iso(100));
        expect(intent?.facts.notifiedAt).toBeUndefined();
        expect(intent?.facts.unresolvedAt).toBeUndefined();
        events.push("transport");
        return submitted();
      },
      accept: async () => {
        expect((await fixture.store.attempt(key(messageId)))?.facts.notifiedAt).toBeDefined();
        events.push("receipt");
        return true;
      },
    });
    try {
      const result = await flow.attempt();
      expect(result).toMatchObject({ outcome: { status: "submitted" } });
      const row = await fixture.store.attempt(key(messageId));
      expect(row?.facts.notifiedAt).toBeDefined();
      expect(row?.write).toMatchObject({ writesBefore: 0, writesAfter: 1 });
      expect(events).toEqual(["transport", "receipt"]);
      expect(flow.receipts()).toBe(1);
    } finally { flow.service.suspend(); }
  });

  it("uses durable notification to repair a missing receipt across generations without another transport", async () => {
    const messageId = "notified-no-receipt";
    let writes = 0;
    const first = delivery({
      attempts: fixture.store, messageId, generation: "generation-old", accept: () => false,
      write: async () => { writes += 1; return submitted(); },
    });
    try { await first.attempt(); } finally { first.service.suspend(); }
    expect(first.receipts()).toBe(0);
    expect(await fixture.store.hasNotifiedAcrossGenerations({ canvas, nodeId, messageId })).toBe(true);
    const restarted = delivery({
      attempts: fixture.store, messageId, generation: "generation-new",
      write: async () => { writes += 1; return submitted(); },
    });
    try {
      expect(await restarted.attempt()).toMatchObject({ outcome: { status: "submitted", wrotePhysicalBytes: false } });
      expect(restarted.receipts()).toBe(1);
      expect(writes).toBe(1);
    } finally { restarted.service.suspend(); }
  });

  it.each(["read-failure", "wrong-canvas", "wrong-node"] as const)(
    "rejects %s before invoking the repository", async (failure) => {
      let repositoryCalls = 0;
      const store = makeMailAttemptStore({
        repository: fixture.repository,
        resolveSeat: async () => {
          if (failure === "read-failure") throw new Error("compiled identity read failed");
          return { ...recipient, ...(failure === "wrong-canvas" ? { canvasName: "different" } : { nodeId: "different" }) };
        },
        run: (effect) => { repositoryCalls += 1; return fixture.runtime.runPromise(effect); },
      });
      const input = key(`failure-${failure}`);
      const calls = [
        () => store.enqueueAttempt({ ...input, policy: "notice" }),
        () => store.enqueueBatch({ canvas, nodeId, batchId: "unwritten", members: [{ messageId: input.messageId, generation: input.generation, policy: "notice" }] }),
        () => store.markAttempted(input),
        () => store.recordAttempt({ ...input, set: { notifiedAt: iso(1) } }),
        () => store.attempt(input),
        () => store.hasNotifiedAcrossGenerations(input),
      ];
      for (const call of calls) await expect(call()).rejects.toThrow();
      expect(repositoryCalls).toBe(0);
      expect(await fixture.store.attempt(input)).toBeUndefined();
    },
  );

  it("propagates repository read failure instead of authorizing a fresh attempt", async () => {
    const readError = new Error("attempt read unavailable");
    const failed = makeMailAttemptStore({
      repository: fixture.repository, resolveSeat: async () => recipient,
      run: () => Promise.reject(readError),
    });
    await expect(failed.attempt(key("failed-read"))).rejects.toBe(readError);
    await expect(failed.hasNotifiedAcrossGenerations({ canvas, nodeId, messageId: "failed-read" })).rejects.toBe(readError);
    let writes = 0;
    const flow = delivery({
      attempts: { ...fixture.store, hasNotifiedAcrossGenerations: failed.hasNotifiedAcrossGenerations },
      messageId: "failed-read", generation: "generation-1",
      write: async () => { writes += 1; return submitted(); },
    });
    try {
      expect(await flow.attempt()).toMatchObject({ outcome: { status: "refused", wrotePhysicalBytes: false } });
      expect((await fixture.store.attempt(key("failed-read")))?.facts.attemptedAt).toBeUndefined();
      expect(writes).toBe(0);
      expect(flow.receipts()).toBe(0);
    } finally { flow.service.suspend(); }
  });

  it("never reconciles a live intent when the delayed boot backlog scan runs", async () => {
    const entered = Promise.withResolvers<void>();
    const outcome = Promise.withResolvers<ManagedPromptOutcome>();
    const scanned = Promise.withResolvers<void>();
    let observeScan = false;
    let reconciliations = 0;
    const messageId = "live-during-boot-scan";
    const attempts: MessageDeliveryAttemptStore = {
      ...fixture.store,
      reconcileUnresolvedAttempts: async (at) => {
        reconciliations += 1;
        return fixture.store.reconcileUnresolvedAttempts(at);
      },
    };
    const flow = delivery({
      attempts, messageId, generation: "generation-live",
      onRead: () => { if (observeScan) scanned.resolve(); },
      write: async () => { entered.resolve(); return outcome.promise; },
    });
    const pending = flow.attempt();
    try {
      await entered.promise;
      const beforeScan = await fixture.store.attempt(key(messageId, "generation-live"));
      expect(beforeScan?.facts.attemptedAt).toBeDefined();
      expect(beforeScan?.facts.unresolvedAt).toBeUndefined();
      observeScan = true;
      flow.service.onBooted();
      await scanned.promise;
      expect(reconciliations).toBe(0);
      expect((await fixture.store.attempt(key(messageId, "generation-live")))?.facts.unresolvedAt).toBeUndefined();
      outcome.resolve(submitted());
      expect(await pending).toMatchObject({ outcome: { status: "submitted" } });
    } finally {
      outcome.resolve(submitted());
      await pending;
      flow.service.suspend();
    }
  });

  it("reconciles a crashed retry on reopening before allowing delivery traffic", async () => {
    const directory = join(root, "restarted-process");
    let previous = await openFixture(directory);
    const crashKey = key("crash-after-refusal", "generation-survived");
    try {
      await previous.store.enqueueAttempt({ ...crashKey, policy: "notice", at: iso(40) });
      await previous.store.markAttempted({ ...crashKey, at: iso(41) });
      await previous.store.recordAttempt({ ...crashKey, set: { refusedAt: iso(42), refusedReason: "seat-busy" } });
      await previous.store.markAttempted({ ...crashKey, at: iso(43) });
      await previous.store.enqueueAttempt({ ...key("clean-after-boot", "generation-survived"), policy: "notice", at: iso(44) });
    } finally { await previous.runtime.dispose(); }
    previous = await openFixture(directory);
    try {
      expect(await previous.store.reconcileUnresolvedAttempts(iso(50))).toBe(1);
      expect(await previous.store.reconcileUnresolvedAttempts(iso(51))).toBe(0);
      const recovered = await previous.store.attempt(crashKey);
      expect(recovered?.facts).toMatchObject({ refusedAt: iso(42), unresolvedAt: iso(50) });
      let writes = 0;
      for (const messageId of [crashKey.messageId, "clean-after-boot"]) {
        const flow = delivery({
          attempts: previous.store, messageId, generation: crashKey.generation,
          write: async () => { writes += 1; return submitted(); },
        });
        try {
          const result = await flow.attempt();
          expect(result).toMatchObject({ outcome: messageId === crashKey.messageId
            ? { status: "refused", reason: "written-unresolved", wrotePhysicalBytes: false }
            : { status: "submitted" } });
          expect(flow.receipts()).toBe(messageId === crashKey.messageId ? 0 : 1);
        } finally { flow.service.suspend(); }
      }
      expect(writes).toBe(1);
    } finally { await previous.runtime.dispose(); }
  });
});
