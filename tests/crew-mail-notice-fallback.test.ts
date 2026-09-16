import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Layer, ManagedRuntime, Schema } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { CanvasDoc, Message } from "../src/shared/canvas";
import { InstallationId } from "../src/shared/installation-id";
import type { ActorRef } from "../src/shared/work-protocol";
import { compileActorSeatRegistry } from "../src/main/junto/station/actor-seat-compiler";
import { makeStateEngineLive, StateEngine } from "../src/main/junto/state/engine";
import { CrewRepository, CrewRepositoryLive } from "../src/main/junto/work/crew-repository";
import { makeMailAttemptStore } from "../src/main/junto/work/mail-attempt-store";
import {
  MESSAGE_DELIVERY_SETTLE_MS,
  MessageDeliveryService,
  type MessageDeliveryAttemptStore,
  type MessageDeliveryStore,
} from "../src/main/junto/work/message-delivery";
import { ManagedTerminalDrive } from "../src/main/junto/term/drive/managed-terminal-drive";

const canvas = "mail-fallback";
const nodeId = "fallback-node";
const bindingId = "fallback-process";
const installation = Schema.decodeUnknownSync(InstallationId)("mail-fallback-installation");
const iso = (n: number): string => new Date(1_760_000_000_000 + n).toISOString();
const root = join(tmpdir(), `junto-mail-fallback-${randomUUID()}`);

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

const promptMessage = (messageId: string): Message => ({
  messageId,
  role: "user",
  parts: [{ kind: "text", text: "please review" }],
  metadata: {
    factoryMail: true,
    mailKind: "prompt",
    fromSeat: recipient.seatId,
    senderGeneration: "sender-g",
    senderHarness: "claude",
  },
});

const storeFor = (doc: CanvasDoc): MessageDeliveryStore => {
  const accepted = new Set<string>();
  return {
    listCanvasNames: async () => [canvas],
    readDoc: async () => doc,
    readNodeStructure: async () => ({ node: doc.nodes[0]!, structure: doc }),
    hasAcceptedMessageDelivery: async (_canvas, _node, id) => accepted.has(id),
    hasAcceptedMessageRead: async () => false,
    acceptMessageDelivery: async (_canvas, _node, id) => { accepted.add(id); return true; },
    acceptMessageRead: async () => true,
  };
};

const flush = async (): Promise<void> => {
  for (let i = 0; i < 12; i += 1) await new Promise((r) => setTimeout(r, 0));
};

describe("durable notice fallback and generation-fenced resume", () => {
  it("explicit fallback remains marked after busy refusal and database reopen", async () => {
    const directory = join(root, "explicit-fallback-restart");
    let live = await openFixture(directory);
    const messageId = "explicit-fallback";
    const service = new MessageDeliveryService();
    service.configure({
      attempts: live.store,
      store: storeFor(recipientDoc([promptMessage(messageId)])),
      timers: { set: () => ({}), clear: () => {} },
      transport: {
        wakeManagedSeat: async () => true,
        seatDeliverySnapshot: async () => ({
          idle: false, operatorDraft: false, generationKey: "generation-1",
        }),
        sendManagedTerminalPrompt: async () => {
          throw new Error("must not send while busy");
        },
      },
    });
    const refused = await service.prompt({ canvas, nodeId, messageId, fallback: "notice" });
    expect(refused).toMatchObject({
      policy: "notice",
      outcome: { status: "refused", reason: "seat-busy", wrotePhysicalBytes: false },
    });
    service.suspend();
    await live.runtime.dispose();
    live = await openFixture(directory);
    const pastes: string[] = [];
    const drive = new ManagedTerminalDrive({
      write: (id, data) => {
        if (data.startsWith("\u001b[200~")) pastes.push(data);
        if (data === "\r") drive.onTurnStart(id);
        return true;
      },
      isSeatIdle: () => true, pendingText: () => false, stallWatch: false, stallTimeoutMs: 10, pasteToCrSettleMs: 0,
    });
    try {
      expect(await live.store.hasNoticeFallback!({ canvas, nodeId, messageId })).toBe(true);
      // Reopen again after notification, with no document-side receipt, to
      // prove the durable notified fact suppresses a new-generation paste.
      for (const generation of ["generation-1", "generation-2"]) {
        let clock = 100_000;
        const restarted = new MessageDeliveryService();
        restarted.configure({
          attempts: live.store, store: storeFor(recipientDoc([promptMessage(messageId)])),
          now: () => clock, timers: { set: () => ({}), clear: () => {} },
          transport: {
            seatDeliverySnapshot: () => ({ idle: true, operatorDraft: false, generationKey: generation }),
            sendManagedTerminalPrompt: (id, text) => drive.writePrompt(id, text, { awaitTurnStart: false }),
          },
        });
        try {
          restarted.onManagedTerminalIdle(bindingId);
          await flush();
          clock += MESSAGE_DELIVERY_SETTLE_MS;
          restarted.onManagedTerminalIdle(bindingId);
          await flush();
          expect(pastes).toHaveLength(1);
          expect(pastes[0]).toContain(`msg read ${messageId}`);
          expect(await live.store.hasNotifiedAcrossGenerations({ canvas, nodeId, messageId })).toBe(true);
          restarted.onManagedTerminalIdle(bindingId);
          restarted.onResumedCanvas(canvas);
          await flush();
          expect(pastes).toHaveLength(1);
        } finally { restarted.suspend(); }
        await live.runtime.dispose();
        live = await openFixture(directory);
        await live.store.reconcileUnresolvedAttempts(iso(300));
      }
    } finally {
      await live.runtime.dispose();
      drive.suspend();
    }
  });

  it("plain immediate refusal does not create an unrequested durable fallback", async () => {
    const messageId = "no-fallback-requested";
    const service = new MessageDeliveryService();
    service.configure({
      attempts: fixture.store,
      store: storeFor(recipientDoc([promptMessage(messageId)])),
      timers: { set: () => ({}), clear: () => {} },
      transport: {
        seatDeliverySnapshot: async () => ({
          idle: false, operatorDraft: false, generationKey: "generation-1",
        }),
        sendManagedTerminalPrompt: async () => {
          throw new Error("must not send while busy");
        },
      },
    });
    try {
      expect(await service.prompt({ canvas, nodeId, messageId })).toMatchObject({
        policy: "immediate",
        outcome: { status: "refused", reason: "seat-busy" },
      });
      expect(await fixture.store.hasNoticeFallback!({ canvas, nodeId, messageId })).toBe(false);
    } finally {
      service.suspend();
    }
  });

  it("old-generation grant cannot release the current drive when its own grant fails", async () => {
    const messageId = "two-generations-held";
    for (const generation of ["old-generation", "current-generation"]) {
      await fixture.store.enqueueAttempt({ ...key(messageId, generation), policy: "notice" });
      await fixture.store.markAttempted(key(messageId, generation));
      await fixture.store.recordAttempt({
        ...key(messageId, generation),
        set: { unresolvedAt: iso(200) },
      });
    }
    let physicalPastes = 0;
    const drive = new ManagedTerminalDrive({
      write: (_id, data) => {
        if (data.includes("\x1b[200~")) physicalPastes += 1;
        return true;
      },
      isSeatIdle: () => true,
      pendingText: () => true,
      now: () => 10_000,
      stallWatch: false, stallTimeoutMs: 10,
      pasteToCrSettleMs: 0,
    });
    expect(await drive.writePrompt(bindingId, "currently pending", {
      awaitTurnStart: false,
    })).toMatchObject({ status: "unresolved", wrotePhysicalBytes: true });
    const grants: Array<string> = [];
    const released: Array<string> = [];
    const attempts: MessageDeliveryAttemptStore = {
      ...fixture.store,
      grantHeldAttempt: async (input) => {
        grants.push(input.generation);
        if (input.generation === "current-generation") {
          throw new Error("current grant transaction failed");
        }
        return fixture.store.grantHeldAttempt!(input);
      },
    };
    const doc = recipientDoc([{
      messageId, role: "user", parts: [{ kind: "text", text: "held mail" }],
    }]);
    const service = new MessageDeliveryService();
    service.configure({
      attempts,
      store: storeFor(doc),
      timers: { set: () => ({}), clear: () => {} },
      releaseSeatHold: (id) => {
        released.push(id);
        drive.releaseWrittenUnresolved(id);
      },
      transport: {
        seatDeliverySnapshot: async () => ({
          idle: true, operatorDraft: false, generationKey: "current-generation",
        }),
        sendManagedTerminalPrompt: async () => {
          throw new Error("unsettled resume must not send");
        },
      },
    });
    try {
      service.onResumedCanvas(canvas);
      await flush();
      // The old generation never grants against a current-generation seat,
      // so its intent stays closed; the current grant threw, so its intent
      // stays closed too. Nothing released the drive.
      const old = await fixture.store.attempt(key(messageId, "old-generation"));
      const current = await fixture.store.attempt(key(messageId, "current-generation"));
      expect(old?.attemptSeq).toBe(1);
      expect(old?.resolvedSeq).toBe(1);
      expect(current?.attemptSeq).toBe(1);
      expect(current?.resolvedSeq).toBe(1);
      expect(grants).toEqual(["current-generation"]);
      expect(released).toEqual([]);
      const later = await drive.writePrompt(bindingId, "later delivery", {
        awaitTurnStart: false,
      });
      expect(later).toMatchObject({
        status: "refused", reason: "written-unresolved", wrotePhysicalBytes: false,
      });
      expect(physicalPastes).toBe(1);
    } finally {
      service.suspend();
      drive.suspend();
    }
  });

  it("does not change notice policy for an already-cancelled request", async () => {
    const messageId = "cancelled-fallback";
    const service = new MessageDeliveryService();
    const abort = new AbortController();
    abort.abort();
    service.configure({
      attempts: fixture.store, store: storeFor(recipientDoc([promptMessage(messageId)])),
      transport: { sendManagedTerminalPrompt: async () => { throw new Error("cancelled input wrote"); } },
    });
    try {
      expect(await service.prompt({ canvas, nodeId, messageId, fallback: "notice", signal: abort.signal }))
        .toMatchObject({ outcome: { status: "refused", reason: "cancelled", wrotePhysicalBytes: false } });
      expect(await fixture.store.hasNoticeFallback!({ canvas, nodeId, messageId })).toBe(false);
      expect(await fixture.store.attempt(key(messageId))).toBeUndefined();
    } finally { service.suspend(); }
  });

  it("persists requested notice policy while the recipient is paused without writing", async () => {
    const messageId = "paused-fallback";
    const service = new MessageDeliveryService();
    service.configure({
      attempts: fixture.store, store: storeFor(recipientDoc([promptMessage(messageId)])),
      seatPaused: () => true,
      transport: { sendManagedTerminalPrompt: async () => { throw new Error("paused seat wrote"); } },
    });
    try {
      expect(await service.prompt({ canvas, nodeId, messageId, fallback: "notice" })).toEqual({ unavailable: "paused" });
      expect(await fixture.store.hasNoticeFallback!({ canvas, nodeId, messageId })).toBe(true);
      expect(await fixture.store.attempt(key(messageId))).toBeUndefined();
    } finally { service.suspend(); }
  });

  it("reserves the row before publishing fallback and stops transport when suspended during the grant", async () => {
    const messageId = "reserved-fallback";
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let transports = 0;
    const attempts: MessageDeliveryAttemptStore = {
      ...fixture.store,
      grantNoticeFallback: async (input) => {
        const granted = await fixture.store.grantNoticeFallback!(input);
        entered.resolve();
        await finish.promise;
        return granted;
      },
    };
    const service = new MessageDeliveryService();
    service.configure({
      attempts, store: storeFor(recipientDoc([promptMessage(messageId)])),
      timers: { set: () => ({}), clear: () => {} },
      transport: { sendManagedTerminalPrompt: async () => {
        transports += 1;
        throw new Error("reserved row wrote");
      } },
    });
    const pending = service.prompt({ canvas, nodeId, messageId, fallback: "notice" });
    try {
      await entered.promise;
      service.onManagedTerminalIdle(bindingId);
      await flush();
      expect(transports).toBe(0);
      expect(await fixture.store.attempt(key(messageId))).toBeUndefined();
      service.suspend();
      finish.resolve();
      expect(await pending).toEqual({ unavailable: "unconfigured" });
      expect(transports).toBe(0);
      expect(await fixture.store.hasNoticeFallback!({ canvas, nodeId, messageId })).toBe(true);
    } finally { finish.resolve(); await pending; service.suspend(); }
  });

  it("propagates a failed policy write before any notice transport", async () => {
    const messageId = "failed-fallback";
    const failure = new Error("fallback transaction failed");
    let writes = 0;
    const service = new MessageDeliveryService();
    service.configure({
      attempts: { ...fixture.store, grantNoticeFallback: async () => { throw failure; } },
      store: storeFor(recipientDoc([promptMessage(messageId)])),
      transport: { sendManagedTerminalPrompt: async () => { writes += 1; throw new Error("unexpected write"); } },
    });
    try {
      await expect(service.prompt({ canvas, nodeId, messageId, fallback: "notice" })).rejects.toBe(failure);
      expect(writes).toBe(0);
      expect(await fixture.store.hasNoticeFallback!({ canvas, nodeId, messageId })).toBe(false);
    } finally { service.suspend(); }
  });

  it("does not release a replacement generation when the grant commits after replacement", async () => {
    const messageId = "replaced-during-grant";
    const before = key(messageId, "before-replacement");
    await fixture.store.enqueueAttempt({ ...before, policy: "notice" });
    await fixture.store.markAttempted(before);
    await fixture.store.recordAttempt({ ...before, set: { unresolvedAt: iso(400) } });
    const entered = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    const committed = Promise.withResolvers<void>();
    let generation = before.generation;
    const releases: string[] = [];
    const service = new MessageDeliveryService();
    service.configure({
      attempts: {
        ...fixture.store,
        grantHeldAttempt: async (input) => {
          entered.resolve();
          await finish.promise;
          const granted = await fixture.store.grantHeldAttempt!(input);
          committed.resolve();
          return granted;
        },
      },
      store: storeFor(recipientDoc([{ messageId, role: "user", parts: [{ kind: "text", text: "held mail" }] }])),
      timers: { set: () => ({}), clear: () => {} },
      releaseSeatHold: (_id, grantedGeneration) => { releases.push(grantedGeneration); },
      transport: {
        seatDeliverySnapshot: () => ({ idle: false, operatorDraft: false, generationKey: generation }),
        sendManagedTerminalPrompt: async () => { throw new Error("busy replacement wrote"); },
      },
    });
    try {
      service.onResumedCanvas(canvas);
      await entered.promise;
      generation = "after-replacement";
      finish.resolve();
      await committed.promise;
      await flush();
      expect(releases).toEqual([]);
      expect(await fixture.store.attempt(before)).toMatchObject({ attemptSeq: 2, resolvedSeq: 1 });
      // A crash after that obsolete grant closes its uncertain intent at boot.
      await fixture.store.reconcileUnresolvedAttempts(iso(401));
      expect(await fixture.store.attempt(before)).toMatchObject({ attemptSeq: 2, resolvedSeq: 2 });
    } finally { finish.resolve(); service.suspend(); }
  });

  it("releases a current held attempt only after its durable grant and not again after notification", async () => {
    const messageId = "authorized-current-retry";
    const current = key(messageId);
    let pending = true;
    let pastes = 0;
    const drive = new ManagedTerminalDrive({
      write: (id, data) => {
        if (data.startsWith("\u001b[200~")) pastes += 1;
        if (data === "\r" && !pending) drive.onTurnStart(id);
        return true;
      },
      isSeatIdle: () => true, pendingText: () => pending, stallWatch: false, stallTimeoutMs: 10, pasteToCrSettleMs: 0,
    });
    await fixture.store.enqueueAttempt({ ...current, policy: "notice" });
    await fixture.store.markAttempted(current);
    expect(await drive.writePrompt(bindingId, "held mail", { awaitTurnStart: false }))
      .toMatchObject({ status: "unresolved", wrotePhysicalBytes: true });
    await fixture.store.recordAttempt({ ...current, set: { unresolvedAt: iso(600) } });
    let committedGrant = false;
    const releases: string[] = [];
    let clock = 100_000;
    const service = new MessageDeliveryService();
    service.configure({
      attempts: {
        ...fixture.store,
        grantHeldAttempt: async (input) => {
          const granted = await fixture.store.grantHeldAttempt!(input);
          const row = await fixture.store.attempt(input);
          committedGrant = granted && (row?.attemptSeq ?? 0) > (row?.resolvedSeq ?? 0);
          return granted;
        },
      },
      store: storeFor(recipientDoc([{ messageId, role: "user", parts: [{ kind: "text", text: "held mail" }] }])),
      now: () => clock, timers: { set: () => ({}), clear: () => {} },
      releaseSeatHold: (id, generation) => {
        expect(committedGrant).toBe(true);
        expect(generation).toBe(current.generation);
        releases.push(generation);
        drive.releaseWrittenUnresolved(id);
      },
      transport: {
        seatDeliverySnapshot: () => ({ idle: true, operatorDraft: false, generationKey: current.generation }),
        sendManagedTerminalPrompt: (id, text) => drive.writePrompt(id, text, { awaitTurnStart: false }),
      },
    });
    try {
      service.onManagedTerminalIdle(bindingId);
      await flush();
      clock += MESSAGE_DELIVERY_SETTLE_MS;
      service.onManagedTerminalIdle(bindingId);
      await flush();
      expect(pastes).toBe(1);
      expect(releases).toEqual([]);
      service.onResumedCanvas(canvas);
      await flush();
      expect(releases).toEqual([current.generation]);
      expect(pastes).toBe(1);
      pending = false;
      clock += MESSAGE_DELIVERY_SETTLE_MS;
      service.onManagedTerminalIdle(bindingId);
      await flush();
      expect(pastes).toBe(2);
      expect((await fixture.store.attempt(current))?.facts.notifiedAt).toBeDefined();
      service.onResumedCanvas(canvas);
      await flush();
      clock += MESSAGE_DELIVERY_SETTLE_MS;
      service.onManagedTerminalIdle(bindingId);
      await flush();
      expect(pastes).toBe(2);
      expect(releases).toEqual([current.generation]);
    } finally { service.suspend(); drive.suspend(); }
  });

  it.each(["missing", "failed"] as const)("a %s live snapshot cannot grant against a cached generation", async (mode) => {
    const messageId = `cached-generation-${mode}`;
    await fixture.store.enqueueAttempt({ ...key(messageId), policy: "notice" });
    await fixture.store.markAttempted(key(messageId));
    await fixture.store.recordAttempt({ ...key(messageId), set: { unresolvedAt: iso(500) } });
    let available = true;
    let releases = 0;
    const service = new MessageDeliveryService();
    service.configure({
      attempts: fixture.store,
      store: storeFor(recipientDoc([{ messageId, role: "user", parts: [{ kind: "text", text: "held mail" }] }])),
      timers: { set: () => ({}), clear: () => {} },
      releaseSeatHold: () => { releases += 1; },
      transport: {
        seatDeliverySnapshot: () => {
          if (!available) {
            if (mode === "failed") throw new Error("snapshot unavailable");
            return undefined;
          }
          return { idle: false, operatorDraft: false, generationKey: "generation-1" };
        },
        sendManagedTerminalPrompt: async () => { throw new Error("unknown generation wrote"); },
      },
    });
    try {
      // Warm the normal gate's generation cache without opening an intent.
      expect(await service.prompt({ canvas, nodeId, messageId }))
        .toMatchObject({ outcome: { status: "refused", wrotePhysicalBytes: false } });
      available = false;
      service.onResumedCanvas(canvas);
      await flush();
      expect(releases).toBe(0);
      expect(await fixture.store.attempt(key(messageId))).toMatchObject({ attemptSeq: 1, resolvedSeq: 1 });
    } finally { service.suspend(); }
  });
});
