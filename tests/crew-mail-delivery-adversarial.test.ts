import { describe, expect, it } from "vitest";
import type { CanvasDoc, CanvasNode, Message } from "../src/shared/canvas";
import { composeMessageDeliverySummary } from "../src/shared/message-delivery";
import { deriveMailDisplayState } from "../src/shared/crew";
import type { ManagedPromptOutcome } from "../src/shared/managed-prompt";
import {
  MessageDeliveryService,
  type MessageDeliveryAttemptStore,
  type MessageDeliveryStore,
  type MessageDeliveryTimers,
} from "../src/main/junto/work/message-delivery";
import type { DeliveryAttempt } from "../src/shared/crew";

// Independent adversarial seam tests for the crew mail/prompt contract
// (historical crew contract, deleted by operator ruling 2026-09-16). Delivery attempt identity is (messageId, recipient
// seat, recipient generation); the durable attempt ledger must be written
// before any transport action and consulted before any replay.

const userMsg = (id: string, text = "ping", extra: Partial<Message> = {}): Message => ({
  messageId: id,
  role: "user",
  parts: [{ kind: "text", text }],
  ...extra,
});

const agentDoc = (messages: ReadonlyArray<Message>): CanvasDoc => ({
  nodes: [
    {
      id: "agent",
      type: "text",
      text: "profile-13",
      x: 0,
      y: 0,
      width: 100,
      height: 80,
      ether: {
        entity: { kind: "agent", name: "local:profile-13" },
        terminal: { bindingId: "bind-profile-13", harness: "claude" },
        messages: { items: [...messages] },
      },
    },
  ],
  edges: [],
});

const appendItems = (
  docs: Map<string, CanvasDoc>,
  canvas: string,
  nodeId: string,
  f: (items: ReadonlyArray<Message>) => ReadonlyArray<Message>,
): void => {
  const doc = docs.get(canvas);
  if (!doc) throw new Error(`no canvas ${canvas}`);
  docs.set(canvas, {
    ...doc,
    nodes: doc.nodes.map((node): CanvasNode => {
      if (node.id !== nodeId) return node;
      const items = node.ether?.messages?.items ?? [];
      return {
        ...node,
        ether: {
          ...(node.ether ?? {}),
          messages: { items: [...f(items)] },
        },
      } as CanvasNode;
    }),
  });
};

const submittedOutcome = (writesAfter = 1): ManagedPromptOutcome => ({
  status: "submitted",
  bindingGeneration: 1,
  writesBefore: writesAfter - 1,
  writesAfter,
  pasteWrites: 1,
  wrotePhysicalBytes: true,
});

const unresolvedOutcome = (writesBefore: number): ManagedPromptOutcome => ({
  status: "unresolved",
  reason: "no-turn-start",
  bindingGeneration: 1,
  writesBefore,
  writesAfter: writesBefore + 1,
  pasteWrites: 1,
  wrotePhysicalBytes: true,
});

/**
 * Durable attempt ledger double — survives "process restarts" (new service
 * instances) the way the SQLite repository does. Idempotent enqueue on
 * (canvas, nodeId, messageId, generation): an existing row is returned with
 * its facts, per the ledger contract.
 */
const makeAttemptLedger = () => {
  const rows = new Map<string, DeliveryAttempt>();
  const keyOf = (input: {
    canvas: string;
    nodeId: string;
    messageId: string;
    generation: string;
  }) => `${input.canvas}::${input.nodeId}::${input.messageId}::${input.generation}`;
  const mint = (input: {
    canvas: string;
    nodeId: string;
    messageId: string;
    generation: string;
    policy: "notice" | "immediate";
    batchId?: string;
  }): DeliveryAttempt => ({
    messageId: input.messageId,
    recipient: {
      seat: {
        seatId: `seat_${"a".repeat(64)}` as DeliveryAttempt["recipient"]["seat"]["seatId"],
        canvasName: input.canvas,
        nodeId: input.nodeId,
      },
      generation: input.generation,
    },
    policy: input.policy,
    ...(input.batchId !== undefined ? { batchId: input.batchId } : {}),
    facts: { generation: input.generation, queuedAt: new Date().toISOString() },
  });
  const store: MessageDeliveryAttemptStore = {
    enqueueAttempt: async (input) => {
      const key = keyOf(input);
      const existing = rows.get(key);
      if (existing) return existing;
      const row = mint(input);
      rows.set(key, row);
      return row;
    },
    enqueueBatch: async (input) => {
      // Atomic membership: stage all new rows before committing any.
      const staged: Array<[string, DeliveryAttempt]> = [];
      const out: DeliveryAttempt[] = [];
      for (const member of input.members) {
        const key = keyOf({
          canvas: input.canvas,
          nodeId: input.nodeId,
          messageId: member.messageId,
          generation: member.generation,
        });
        const existing = rows.get(key);
        if (existing) {
          out.push(existing);
          continue;
        }
        const row = mint({ ...member, canvas: input.canvas, nodeId: input.nodeId, batchId: input.batchId });
        staged.push([key, row]);
        out.push(row);
      }
      for (const [key, row] of staged) rows.set(key, row);
      return out;
    },
    markAttempted: async (input) => {
      const key = keyOf(input);
      const row = rows.get(key);
      if (!row) throw new Error(`no attempt row for ${key}`);
      const next: DeliveryAttempt = {
        ...row,
        facts: {
          ...row.facts,
          attemptedAt: input.at ?? new Date().toISOString(),
        },
      };
      rows.set(key, next);
      return next;
    },
    recordAttempt: async (input) => {
      const key = keyOf(input);
      const row = rows.get(key);
      if (!row) throw new Error(`no attempt row for ${key}`);
      const facts = { ...row.facts };
      if ("notifiedAt" in input.set) facts.notifiedAt = input.set.notifiedAt;
      if ("unresolvedAt" in input.set) facts.unresolvedAt = input.set.unresolvedAt;
      if ("refusedAt" in input.set) {
        facts.refusedAt = input.set.refusedAt;
        facts.refusedReason = input.set.refusedReason;
      }
      const next: DeliveryAttempt = { ...row, facts, ...(input.write ? { write: input.write } : {}) };
      rows.set(key, next);
      return next;
    },
    attempt: async (input) => rows.get(keyOf(input)),
    hasNotifiedAcrossGenerations: async (input) => {
      const prefix = `${input.canvas}::${input.nodeId}::${input.messageId}::`;
      for (const [key, row] of rows) {
        if (key.startsWith(prefix) && row.facts.notifiedAt !== undefined) {
          return true;
        }
      }
      return false;
    },
    reconcileUnresolvedAttempts: async (at) => {
      // Boot reconciliation: attempted with no outcome fact → unresolved.
      let count = 0;
      for (const [key, row] of rows) {
        const f = row.facts;
        if (
          f.attemptedAt !== undefined &&
          f.notifiedAt === undefined &&
          f.unresolvedAt === undefined &&
          f.refusedAt === undefined
        ) {
          rows.set(key, { ...row, facts: { ...f, unresolvedAt: at } });
          count += 1;
        }
      }
      return count;
    },
  };
  return { store, rows };
};

const makeStore = (
  initial: Record<string, CanvasDoc>,
  options: {
    readonly acceptOk?: () => boolean;
    readonly acceptMessage?: (messageId: string) => boolean;
    readonly now?: () => number;
    readonly onDocs?: (docs: Map<string, CanvasDoc>) => void;
  } = {},
): MessageDeliveryStore => {
  const docs = new Map(Object.entries(initial).map(([k, v]) => [k, structuredClone(v)]));
  options.onDocs?.(docs);
  const accepted = new Set<string>();
  const acceptedRead = new Set<string>();
  const keyOf = (canvas: string, nodeId: string, messageId: string) =>
    `${canvas}::${nodeId}::${messageId}`;
  return {
    listCanvasNames: async () => [...docs.keys()],
    readDoc: async (name) => docs.get(name),
    readNodeStructure: async (name, nodeId) => {
      const doc = docs.get(name);
      if (doc === undefined) throw new Error(`no canvas ${name}`);
      const node = doc.nodes.find((candidate) => candidate.id === nodeId);
      return node === undefined ? undefined : { node, structure: doc };
    },
    hasAcceptedMessageDelivery: async (canvas, nodeId, messageId) =>
      accepted.has(keyOf(canvas, nodeId, messageId)),
    hasAcceptedMessageRead: async (canvas, nodeId, messageId) =>
      acceptedRead.has(keyOf(canvas, nodeId, messageId)),
    acceptMessageDelivery: async (canvas, nodeId, messageId) => {
      if (options.acceptOk && !options.acceptOk()) return false;
      if (options.acceptMessage && !options.acceptMessage(messageId)) return false;
      accepted.add(keyOf(canvas, nodeId, messageId));
      const doc = docs.get(canvas);
      if (!doc) return true;
      const deliveredAt = options.now?.() ?? Date.now();
      const node = doc.nodes.find((n) => n.id === nodeId);
      if (!node?.ether?.messages) return true;
      const items = node.ether.messages.items.map((m) =>
        m.messageId === messageId
          ? { ...m, metadata: { ...(m.metadata ?? {}), deliveredAt } }
          : m,
      );
      docs.set(canvas, {
        ...doc,
        nodes: doc.nodes.map((n) =>
          n.id === nodeId
            ? { ...n, ether: { ...(n.ether ?? {}), messages: { items } } }
            : n,
        ),
      });
      return true;
    },
    acceptMessageRead: async (canvas, nodeId, messageId) => {
      acceptedRead.add(keyOf(canvas, nodeId, messageId));
      const doc = docs.get(canvas);
      if (!doc) return true;
      const readAt = options.now?.() ?? Date.now();
      const node = doc.nodes.find((n) => n.id === nodeId);
      if (!node?.ether?.messages) return true;
      const items = node.ether.messages.items.map((m) =>
        m.messageId === messageId
          ? { ...m, metadata: { ...(m.metadata ?? {}), readAt } }
          : m,
      );
      docs.set(canvas, {
        ...doc,
        nodes: doc.nodes.map((n) =>
          n.id === nodeId
            ? { ...n, ether: { ...(n.ether ?? {}), messages: { items } } }
            : n,
        ),
      });
      return true;
    },
  };
};

/** Gate/wake retry timers that never fire — every re-drive is explicit. */
const parkedTimers = (): MessageDeliveryTimers => ({
  set: () => ({}),
  clear: () => {},
});

const waitUntil = async (
  pred: () => boolean | Promise<boolean>,
  timeoutMs = 1_000,
): Promise<void> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("waitUntil timed out");
};

const settle = async (ms = 30): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

describe("crew mail delivery — process-boundary adversarial", () => {
  // Contract: "the app durably enqueues the delivery row before any transport
  // action"; a notified prior attempt on the same generation must never
  // paste again — only stamp the receipt it still owes. Fixed by
  // prepareAttempt → stampOnly (was the notifiedAt fall-through).
  it(
    "a notified attempt does not re-paste across a process restart",
    async () => {
      const msg = userMsg("crash-1", "once only");
      const store = makeStore(
        { c: agentDoc([msg]) },
        { acceptOk: () => false },
      );
      const ledger = makeAttemptLedger();
      let sends = 0;
      let now = 1_000_000;
      const first = new MessageDeliveryService();
      try {
        first.configure({
          transport: {
            seatDeliverySnapshot: () => ({
              generationKey: "g1",
            }),
            sendManagedTerminalPrompt: async () => {
              sends += 1;
              return submittedOutcome(sends);
            },
          },
          store,
          attempts: ledger.store,
          now: () => now,
          timers: parkedTimers(),
        });
        first.notifyAppended("c", "agent", msg);
        await settle(30);
        now += 60_000;
        first.onManagedTerminalIdle("bind-profile-13");
        await waitUntil(() => sends === 1);
        expect(
          await store.hasAcceptedMessageDelivery("c", "agent", "crash-1"),
        ).toBe(false);
        expect(ledger.rows.size).toBe(1);
        expect(
          [...ledger.rows.values()][0]!.facts.notifiedAt,
        ).not.toBeUndefined();
      } finally {
        first.suspend();
      }

      // New process, same durable store and ledger: the notifiedAt fact
      // suppresses the second paste; only the receipt stamp remains owed.
      const second = new MessageDeliveryService();
      try {
        second.configure({
          transport: {
            seatDeliverySnapshot: () => ({
              generationKey: "g1",
            }),
            sendManagedTerminalPrompt: async () => {
              sends += 1;
              return submittedOutcome(sends);
            },
          },
          store,
          attempts: ledger.store,
          now: () => now,
          timers: parkedTimers(),
        });
        second.onBooted();
        await settle(30);
        now += 60_000;
        second.onManagedTerminalIdle("bind-profile-13");
        await settle(60);
        expect(sends).toBe(1);
      } finally {
        second.suspend();
      }
    },
  );

  // Contract: "batches retain their exact membership through receipt
  // recovery." A member whose attempt already notified must not join a new
  // payload on the next process. Fixed by enqueueBatch + prior-facts
  // partition (was batch sending all members blind).
  it(
    "notified members do not join a new batch across a process restart",
    async () => {
      const msgs = [userMsg("rb-1", "first"), userMsg("rb-2", "second")];
      let docs!: Map<string, CanvasDoc>;
      const store = makeStore(
        { c: agentDoc(msgs) },
        {
          acceptMessage: () => false,
          onDocs: (current) => {
            docs = current;
          },
        },
      );
      const ledger = makeAttemptLedger();
      const sends: string[] = [];
      let now = 1_000_000;
      const first = new MessageDeliveryService();
      try {
        first.configure({
          transport: {
            seatDeliverySnapshot: () => ({
              generationKey: "g1",
            }),
            sendManagedTerminalPrompt: async (_b, text) => {
              sends.push(text);
              return submittedOutcome(sends.length);
            },
          },
          store,
          attempts: ledger.store,
          now: () => now,
          timers: parkedTimers(),
        });
        first.onBooted();
        await settle(30);
        now += 60_000;
        first.onManagedTerminalIdle("bind-profile-13");
        await waitUntil(() => sends.length === 1);
        expect(sends[0]).toContain("2 unread");
        expect(
          [...ledger.rows.values()].filter(
            (row) => row.facts.notifiedAt !== undefined,
          ),
        ).toHaveLength(2);
      } finally {
        first.suspend();
      }

      appendItems(docs, "c", "agent", (items) => [
        ...items,
        userMsg("rb-3", "third"),
      ]);
      const second = new MessageDeliveryService();
      try {
        second.configure({
          transport: {
            seatDeliverySnapshot: () => ({
              generationKey: "g1",
            }),
            sendManagedTerminalPrompt: async (_b, text) => {
              sends.push(text);
              return submittedOutcome(sends.length);
            },
          },
          store,
          attempts: ledger.store,
          now: () => now,
          timers: parkedTimers(),
        });
        second.onBooted();
        await settle(30);
        now += 60_000;
        second.onManagedTerminalIdle("bind-profile-13");
        await waitUntil(() => sends.length === 2);
        expect(sends[1]).toBe("[message - user] third");
      } finally {
        second.suspend();
      }
    },
  );

  // Contract: an unresolved write holds its generation — never replayed on
  // the same seat generation, released for exactly one attempt on a new one.
  it("an unresolved write holds its generation and releases on the next", async () => {
    const msg = userMsg("gen-1", "still owed");
    const store = makeStore({ c: agentDoc([msg]) });
    const ledger = makeAttemptLedger();
    let writes = 0;
    let requests = 0;
    let generation = "gen-a";
    let now = 1_000_000;
    const service = new MessageDeliveryService();
    try {
      service.configure({
        transport: {
          pasteWriteCount: () => writes,
          seatDeliverySnapshot: () => ({
            generationKey: generation,
          }),
          sendManagedTerminalPrompt: async () => {
            requests += 1;
            writes += 1;
            return unresolvedOutcome(writes - 1);
          },
        },
        store,
        attempts: ledger.store,
        now: () => now,
        timers: parkedTimers(),
      });

      // Warm the settle stamp, then the unresolved write lands and holds.
      service.onManagedTerminalIdle("bind-profile-13");
      await settle(30);
      now += 60_000;
      service.onManagedTerminalIdle("bind-profile-13");
      await waitUntil(() => requests === 1);

      // Same generation: no amount of re-drive may replay the write.
      for (let i = 0; i < 3; i += 1) {
        now += 60_000;
        service.onManagedTerminalIdle("bind-profile-13");
        await settle(30);
      }
      expect(requests).toBe(1);

      // New generation: exactly one new attempt is authorized.
      generation = "gen-b";
      service.onManagedTerminalIdle("bind-profile-13");
      await settle(30);
      now += 60_000;
      service.onManagedTerminalIdle("bind-profile-13");
      await waitUntil(() => requests === 2);
      for (let i = 0; i < 2; i += 1) {
        now += 60_000;
        service.onManagedTerminalIdle("bind-profile-13");
        await settle(30);
      }
      expect(requests).toBe(2);
    } finally {
      service.suspend();
    }
  });

  // Ruling: mail is never gated. Every notice goes out as it arrives; the
  // harness queues or steers anything typed during a turn.
  it(
    "every notice goes out as it arrives, with no per-turn budget",
    async () => {
      const firstMsg = userMsg("win-1", "first");
      const secondMsg = userMsg("win-2", "second");
      const store = makeStore({ c: agentDoc([firstMsg, secondMsg]) });
      const sends: string[] = [];
      const service = new MessageDeliveryService();
      try {
        service.configure({
          transport: {
            sendManagedTerminalPrompt: async (_b, text) => {
              sends.push(text);
              return submittedOutcome(sends.length);
            },
          },
          store,
        });
        service.notifyAppended("c", "agent", firstMsg);
        await waitUntil(() => sends.length === 1);
        service.notifyAppended("c", "agent", secondMsg);
        await waitUntil(() => sends.length === 2);
        expect(sends).toHaveLength(2);
      } finally {
        service.suspend();
      }
    },
  );

  // Contract ruling: peer envelopes say "mail from <seat>", not
  // "[factory mail from <seat>]". The preview stripper removes both
  // stamped forms but preserves sender-like prose that is not the
  // server-stamped label.
  it(
    "notice previews strip only the stamped envelope, preserving sender-like prose",
    () => {
      const stamped = composeMessageDeliverySummary([
        userMsg("env-1", "mail from seat-a do the thing", {
          metadata: { factoryMail: true, fromSeat: "seat-a" },
        }),
      ]);
      expect(stamped).not.toContain("mail from seat-a do the thing");
      expect(stamped).toContain("do the thing");

      const prose = composeMessageDeliverySummary([
        userMsg("env-2", "mail from seat-b is just prose, keep it", {
          metadata: { factoryMail: true, fromSeat: "seat-a" },
        }),
      ]);
      expect(prose).toContain("mail from seat-b is just prose");
    },
  );

  // Contract: delivery identity is (messageId, recipient seat, generation)
  // — never text. Two identical bodies must carry independent attempt rows
  // and independent receipts; one member's durable acceptance must not
  // settle the other, and an un-receipted member must not re-paste.
  it(
    "identical bodies keep independent attempt identity across a restart",
    async () => {
      const msgs = [userMsg("dup-a", "same words"), userMsg("dup-b", "same words")];
      // dup-b's receipt stamp is refused on the first process only — after
      // the restart it must stamp cleanly without any re-paste.
      let dupBReceiptBlocked = true;
      let docs!: Map<string, CanvasDoc>;
      const store = makeStore(
        { c: agentDoc(msgs) },
        {
          acceptMessage: (id) =>
            id === "dup-a" || (id === "dup-b" && !dupBReceiptBlocked),
          onDocs: (current) => {
            docs = current;
          },
        },
      );
      const ledger = makeAttemptLedger();
      const sends: string[] = [];
      let now = 1_000_000;
      const first = new MessageDeliveryService();
      try {
        first.configure({
          transport: {
            seatDeliverySnapshot: () => ({
              generationKey: "g1",
            }),
            sendManagedTerminalPrompt: async (_b, text) => {
              sends.push(text);
              return submittedOutcome(sends.length);
            },
          },
          store,
          attempts: ledger.store,
          now: () => now,
          timers: parkedTimers(),
        });
        first.onBooted();
        await settle(30);
        now += 60_000;
        first.onManagedTerminalIdle("bind-profile-13");
        await waitUntil(() => sends.length === 1);
        // dup-a receipted; dup-b notified but un-receipted: still pending.
        expect(
          await store.hasAcceptedMessageDelivery("c", "agent", "dup-a"),
        ).toBe(true);
        expect(
          await store.hasAcceptedMessageDelivery("c", "agent", "dup-b"),
        ).toBe(false);
      } finally {
        first.suspend();
      }

      // Restart: dup-b owes only a receipt stamp. Its notifiedAt fact
      // suppresses any second paste — the transport must stay silent.
      const second = new MessageDeliveryService();
      try {
        second.configure({
          transport: {
            seatDeliverySnapshot: () => ({
              generationKey: "g1",
            }),
            sendManagedTerminalPrompt: async (_b, text) => {
              sends.push(text);
              return submittedOutcome(sends.length);
            },
          },
          store,
          attempts: ledger.store,
          now: () => now,
          timers: parkedTimers(),
        });
        second.onBooted();
        dupBReceiptBlocked = false;
        await settle(30);
        now += 60_000;
        second.onManagedTerminalIdle("bind-profile-13");
        await settle(80);
        expect(sends).toHaveLength(1);
        expect(
          await store.hasAcceptedMessageDelivery("c", "agent", "dup-b"),
        ).toBe(true);
      } finally {
        second.suspend();
      }
    },
  );

  it("a batch line carries both ids when two messages share identical text", () => {
    const summary = composeMessageDeliverySummary([
      userMsg("dup-1", "same words"),
      userMsg("dup-2", "same words"),
    ]);
    expect(summary).toContain("2 unread");
    expect(summary).toContain("dup-1");
    expect(summary).toContain("dup-2");
  });
});

describe("crew mail display-state ranking", () => {
  // Contract: "queued, notified, unresolved, refused, read, replied, and
  // reacted are exposed with reasons; transport state and read/reply/
  // reaction facts retain independent timestamps and never erase each
  // other." deriveMailDisplayState is the ranking the ledger projects.
  it("unresolved outranks a later clean refusal", () => {
    expect(
      deriveMailDisplayState({
        queuedAt: "a",
        unresolvedAt: "b",
        refusedAt: "c",
      }),
    ).toBe("unresolved");
  });

  it("recipient acknowledgement outranks every transport fact", () => {
    expect(
      deriveMailDisplayState({
        notifiedAt: "a",
        unresolvedAt: "b",
        readAt: "c",
      }),
    ).toBe("read");
    expect(
      deriveMailDisplayState({
        notifiedAt: "a",
        readAt: "b",
        repliedAt: "c",
      }),
    ).toBe("replied");
    expect(
      deriveMailDisplayState({
        notifiedAt: "a",
        repliedAt: "b",
        reactedAt: "c",
      }),
    ).toBe("reacted");
  });

  it("a refusal cannot demote a proven notification", () => {
    expect(
      deriveMailDisplayState({ notifiedAt: "a", refusedAt: "b" }),
    ).toBe("notified");
    expect(deriveMailDisplayState({ notifiedAt: "a" })).toBe("notified");
    expect(deriveMailDisplayState({ queuedAt: "a" })).toBe("queued");
  });
});
