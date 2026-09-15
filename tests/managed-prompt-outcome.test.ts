import { describe, expect, it } from "vitest";
import { ManagedTerminalDrive } from "../src/main/vellum-command/term/drive/managed-terminal-drive";
import {
  admitImmediatePrompt,
  deriveMailDisplayState,
  mailAttemptReasonOfRefusal,
  readManagedPromptOutcome,
  type MailDeliveryPolicy,
  type ManagedPromptOutcome,
} from "../src/shared/managed-prompt";
import type { ActorSeatId } from "../src/shared/actor-seat";
import type { CanvasDoc, Message } from "../src/shared/canvas";
import {
  MessageDeliveryService,
  type MessageDeliveryAttemptStore,
  type MessageDeliveryStore,
  type MessageDeliveryTransport,
} from "../src/main/vellum-command/work/message-delivery";

const submittedOutcome = (
  writesBefore = 0,
  writesAfter = 1,
): ManagedPromptOutcome => ({
  status: "submitted",
  bindingGeneration: 0,
  writesBefore,
  writesAfter,
  pasteWrites: writesAfter - writesBefore,
  wrotePhysicalBytes: true,
});

const refusedOutcome = (
  reason: "seat-busy" = "seat-busy",
): ManagedPromptOutcome => ({
  status: "refused",
  reason,
  bindingGeneration: 0,
  writesBefore: 0,
  writesAfter: 0,
  pasteWrites: 0,
  wrotePhysicalBytes: false,
});

describe("managed-prompt admission and reason mapping", () => {
  it("admits idle plus empty plus short, refuses busy and oversize", () => {
    expect(
      admitImmediatePrompt({ idle: true, composerEmpty: true, bodyChars: 10 }),
    ).toEqual({ admitted: true });
    expect(
      admitImmediatePrompt({ idle: false, composerEmpty: true, bodyChars: 10 }),
    ).toEqual({ admitted: false, reason: "seat-busy" });
    expect(
      admitImmediatePrompt({ idle: true, composerEmpty: false, bodyChars: 10 }),
    ).toEqual({ admitted: false, reason: "seat-busy" });
    expect(
      admitImmediatePrompt({ idle: true, composerEmpty: true, bodyChars: 161 }),
    ).toEqual({ admitted: false, reason: "over-limit" });
  });

  it("maps drive refusals to the closed durable reason; cuts record nothing", () => {
    expect(mailAttemptReasonOfRefusal("seat-busy")).toBe("seat-busy");
    expect(mailAttemptReasonOfRefusal("composer-not-empty")).toBe(
      "composer-draft",
    );
    expect(mailAttemptReasonOfRefusal("composer-unreadable")).toBe(
      "composer-unreadable",
    );
    expect(mailAttemptReasonOfRefusal("operator-active")).toBe(
      "operator-interlock",
    );
    expect(mailAttemptReasonOfRefusal("written-unresolved")).toBe(
      "written-no-evidence",
    );
    expect(mailAttemptReasonOfRefusal("over-limit")).toBe("oversize");
    expect(mailAttemptReasonOfRefusal("cancelled")).toBeUndefined();
    expect(mailAttemptReasonOfRefusal("suspended")).toBeUndefined();
  });

  it("validates wire outcomes and rejects contradictory counters", () => {
    expect(
      readManagedPromptOutcome({
        status: "submitted",
        bindingGeneration: 2,
        writesBefore: 4,
        writesAfter: 5,
        pasteWrites: 1,
        wrotePhysicalBytes: true,
      }),
    ).toMatchObject({ status: "submitted", pasteWrites: 1 });
    expect(
      readManagedPromptOutcome({
        status: "refused",
        reason: "seat-busy",
        bindingGeneration: 0,
        writesBefore: 0,
        writesAfter: 0,
        pasteWrites: 0,
        wrotePhysicalBytes: false,
      }),
    ).toMatchObject({ status: "refused", reason: "seat-busy" });
    // Backwards delta proves nothing.
    expect(
      readManagedPromptOutcome({
        status: "submitted",
        bindingGeneration: 0,
        writesBefore: 5,
        writesAfter: 4,
        pasteWrites: -1,
        wrotePhysicalBytes: true,
      }),
    ).toBeUndefined();
    // Per-attempt count must equal the envelope delta.
    expect(
      readManagedPromptOutcome({
        status: "submitted",
        bindingGeneration: 0,
        writesBefore: 4,
        writesAfter: 5,
        pasteWrites: 0,
        wrotePhysicalBytes: true,
      }),
    ).toBeUndefined();
    // Malformed shape or reason proves nothing.
    expect(readManagedPromptOutcome({ status: "submitted" })).toBeUndefined();
    expect(
      readManagedPromptOutcome({
        status: "refused",
        reason: "bogus",
        bindingGeneration: 0,
        writesBefore: 0,
        writesAfter: 0,
        pasteWrites: 0,
        wrotePhysicalBytes: false,
      }),
    ).toBeUndefined();
    expect(readManagedPromptOutcome(true)).toBeUndefined();
    expect(readManagedPromptOutcome(null)).toBeUndefined();
  });

  it("ranks unresolved above refused and acknowledgement above transport", () => {
    expect(
      deriveMailDisplayState({ queuedAt: "t", refusedAt: "t" }),
    ).toBe("refused");
    expect(
      deriveMailDisplayState({
        queuedAt: "t",
        refusedAt: "t",
        unresolvedAt: "t",
      }),
    ).toBe("unresolved");
    expect(
      deriveMailDisplayState({ queuedAt: "t", unresolvedAt: "t", readAt: "t" }),
    ).toBe("read");
    expect(deriveMailDisplayState({ queuedAt: "t" })).toBe("queued");
  });
});

describe("ManagedTerminalDrive discriminated outcomes", () => {
  const makeDrive = (
    over: Partial<
      ConstructorParameters<typeof ManagedTerminalDrive>[0]
    > = {},
  ) => {
    let idle = true;
    const writes: Array<{ bindingId: string; data: string }> = [];
    const drive = new ManagedTerminalDrive({
      write: (bindingId, data) => {
        writes.push({ bindingId, data });
        return true;
      },
      isSeatIdle: () => idle,
      now: () => 10_000,
      stallWatch: false,
      pasteToCrSettleMs: 0,
      ...over,
    });
    return {
      drive,
      writes,
      setIdle: (value: boolean) => {
        idle = value;
      },
    };
  };

  it("resolves submitted with physical-write facts on the fast path", async () => {
    const { drive } = makeDrive({ pendingText: () => false });
    const outcome = await drive.writePrompt("b", "hello", {
      awaitTurnStart: false,
    });
    expect(outcome.status).toBe("submitted");
    if (outcome.status !== "submitted") return;
    expect(outcome.wrotePhysicalBytes).toBe(true);
    expect(outcome.pasteWrites).toBe(1);
    expect(outcome.writesAfter).toBeGreaterThan(outcome.writesBefore);
    expect(outcome.bindingGeneration).toBe(0);
  });

  it("refuses seat-busy with zero writes when non-queueing and busy", async () => {
    const { drive, setIdle } = makeDrive();
    setIdle(false);
    const outcome = await drive.writePrompt("b", "hello", {
      queueIfBusy: false,
    });
    expect(outcome).toMatchObject({
      status: "refused",
      reason: "seat-busy",
      pasteWrites: 0,
      wrotePhysicalBytes: false,
    });
  });

  it("refuses not-ready before any gate when the caller is not ready", async () => {
    const { drive } = makeDrive();
    const outcome = await drive.writePrompt("b", "hello", { ready: false });
    expect(outcome).toMatchObject({
      status: "refused",
      reason: "not-ready",
      wrotePhysicalBytes: false,
    });
  });

  it("refuses composer-not-empty on a visible draft", async () => {
    const { drive } = makeDrive({ composerVerdict: () => "draft" });
    const outcome = await drive.writePrompt("b", "hello", {
      queueIfBusy: false,
    });
    expect(outcome).toMatchObject({
      status: "refused",
      reason: "composer-not-empty",
      wrotePhysicalBytes: false,
    });
  });

  it("resolves unresolved chip-pending when evidence shows our text, then guards the seat", async () => {
    const { drive } = makeDrive({ pendingText: () => true });
    const first = await drive.writePrompt("b", "hello", {
      awaitTurnStart: false,
    });
    expect(first).toMatchObject({
      status: "unresolved",
      reason: "chip-pending",
      wrotePhysicalBytes: true,
    });
    const second = await drive.writePrompt("b", "later", {
      awaitTurnStart: false,
    });
    expect(second).toMatchObject({
      status: "refused",
      reason: "written-unresolved",
      wrotePhysicalBytes: false,
    });
  });

  it("resolves suspended after shutdown without writing", async () => {
    const { drive, writes } = makeDrive();
    drive.suspend();
    const outcome = await drive.writePrompt("b", "hello");
    expect(outcome).toMatchObject({
      status: "refused",
      reason: "suspended",
    });
    expect(writes).toHaveLength(0);
  });
});

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

const makeStore = (
  initial: Record<string, CanvasDoc>,
): MessageDeliveryStore & {
  hasDelivery: (canvas: string, nodeId: string, messageId: string) => boolean;
} => {
  const docs = new Map(
    Object.entries(initial).map(([k, v]) => [k, structuredClone(v)]),
  );
  const accepted = new Set<string>();
  const keyOf = (canvas: string, nodeId: string, messageId: string) =>
    `${canvas}::${nodeId}::${messageId}`;
  return {
    hasDelivery: (canvas, nodeId, messageId) =>
      accepted.has(keyOf(canvas, nodeId, messageId)),
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
    hasAcceptedMessageRead: async () => false,
    acceptMessageDelivery: async (canvas, nodeId, messageId) => {
      accepted.add(keyOf(canvas, nodeId, messageId));
      const doc = docs.get(canvas);
      if (!doc) return true;
      const node = doc.nodes.find((n) => n.id === nodeId);
      if (!node?.ether?.messages) return true;
      const items = node.ether.messages.items.map((m) =>
        m.messageId === messageId
          ? { ...m, metadata: { ...(m.metadata ?? {}), deliveredAt: 1 } }
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
    acceptMessageRead: async () => true,
  };
};

const makeLedger = (): MessageDeliveryAttemptStore & {
  calls: Array<string>;
  records: Array<{ messageId: string; set: object }>;
} => {
  const calls: Array<string> = [];
  const records: Array<{ messageId: string; set: object }> = [];
  const rowFor = (
    canvas: string,
    nodeId: string,
    messageId: string,
    generation: string,
    policy: MailDeliveryPolicy,
  ) => ({
    messageId,
    recipient: { seat: { seatId: `seat_${"b".repeat(64)}` as ActorSeatId, canvasName: canvas, nodeId }, generation },
    policy,
    facts: { generation, queuedAt: new Date(0).toISOString() },
  });
  return {
    calls,
    records,
    enqueueAttempt: async (input) => {
      calls.push(`enqueue:${input.messageId}`);
      return rowFor(input.canvas, input.nodeId, input.messageId, input.generation, input.policy);
    },
    enqueueBatch: async (input) => {
      calls.push(`enqueueBatch:${input.batchId}`);
      return input.members.map((member) =>
        rowFor(input.canvas, input.nodeId, member.messageId, member.generation, member.policy),
      );
    },
    markAttempted: async (input) => {
      calls.push(`mark:${input.messageId}`);
      return rowFor(input.canvas, input.nodeId, input.messageId, input.generation, "notice");
    },
    recordAttempt: async (input) => {
      calls.push(`record:${input.messageId}`);
      records.push({ messageId: input.messageId, set: input.set });
      return rowFor(input.canvas, input.nodeId, input.messageId, input.generation, "notice");
    },
    attempt: async () => undefined,
    hasNotifiedAcrossGenerations: async () => false,
    reconcileUnresolvedAttempts: async () => 0,
  };
};

describe("MessageDeliveryService outcome policy", () => {
  it("never re-pastes or receipts a written-unresolved attempt in the same generation", async () => {
    const store = makeStore({ c: agentDoc([userMsg("m1")]) });
    let calls = 0;
    const transport: MessageDeliveryTransport = {
      sendManagedTerminalPrompt: async () => {
        calls += 1;
        return {
          status: "unresolved",
          reason: "no-turn-start",
          bindingGeneration: 0,
          writesBefore: 0,
          writesAfter: 1,
          pasteWrites: 1,
          wrotePhysicalBytes: true,
        };
      },
    };
    const service = new MessageDeliveryService();
    service.configure({ transport, store });
    service.notifyAppended("c", "agent", userMsg("m1"));
    await new Promise((r) => setTimeout(r, 25));
    service.onManagedTerminalIdle("bind-profile-13");
    await new Promise((r) => setTimeout(r, 25));
    service.onComposerEmpty("bind-profile-13");
    await new Promise((r) => setTimeout(r, 25));
    expect(calls).toBe(1);
    expect(await store.hasAcceptedMessageDelivery("c", "agent", "m1")).toBe(
      false,
    );
  });

  it("rolls back a clean refusal and receipts on the later submitted retry", async () => {
    const store = makeStore({ c: agentDoc([userMsg("m1")]) });
    let calls = 0;
    const transport: MessageDeliveryTransport = {
      sendManagedTerminalPrompt: async () => {
        calls += 1;
        return calls === 1
          ? refusedOutcome("seat-busy")
          : submittedOutcome();
      },
    };
    const service = new MessageDeliveryService();
    service.configure({ transport, store });
    service.notifyAppended("c", "agent", userMsg("m1"));
    await new Promise((r) => setTimeout(r, 25));
    service.onManagedTerminalIdle("bind-profile-13");
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(2);
    expect(await store.hasAcceptedMessageDelivery("c", "agent", "m1")).toBe(
      true,
    );
  });

  it("enqueues before transport and records notified on submitted", async () => {
    const store = makeStore({ c: agentDoc([userMsg("m1")]) });
    const ledger = makeLedger();
    const seen: Array<string> = [];
    const transport: MessageDeliveryTransport = {
      sendManagedTerminalPrompt: async () => {
        seen.push("transport");
        return submittedOutcome();
      },
      seatDeliverySnapshot: async () => ({
        idle: true,
        generationKey: "gen-7",
        operatorDraft: false,
      }),
    };
    let clock = 100_000;
    const service = new MessageDeliveryService();
    service.configure({
      transport,
      store,
      attempts: {
        ...ledger,
        enqueueAttempt: async (input) => {
          seen.push("enqueue");
          return ledger.enqueueAttempt(input);
        },
        markAttempted: async (input) => {
          seen.push("mark");
          return ledger.markAttempted(input);
        },
      },
      now: () => clock,
    });
    service.notifyAppended("c", "agent", userMsg("m1"));
    await new Promise((r) => setTimeout(r, 25));
    // First pass only starts the settle clock: the refusal is durable
    // (enqueued plus refused/not-settled) but nothing transports yet.
    expect(seen).toEqual(["enqueue"]);
    expect(ledger.records).toEqual([
      {
        messageId: "m1",
        set: { refusedAt: expect.any(String), refusedReason: "not-settled" },
      },
    ]);
    clock += 2_000;
    service.onManagedTerminalIdle("bind-profile-13");
    await new Promise((r) => setTimeout(r, 50));
    // Intent witness lands immediately before the physical write.
    expect(seen).toEqual(["enqueue", "enqueue", "mark", "transport"]);
    expect(ledger.records).toEqual([
      {
        messageId: "m1",
        set: { refusedAt: expect.any(String), refusedReason: "not-settled" },
      },
      { messageId: "m1", set: { notifiedAt: expect.any(String) } },
    ]);
    expect(await store.hasAcceptedMessageDelivery("c", "agent", "m1")).toBe(
      true,
    );
  });

  it("leaves prompt-kind rows to explicit prompt() with immediate policy", async () => {
    const seat = `seat_${"a".repeat(64)}`;
    const promptMsg = userMsg("p1", "act now", {
      metadata: {
        mailKind: "prompt",
        fromSeat: seat,
        senderGeneration: "g1",
        senderHarness: "claude",
      },
    });
    const store = makeStore({ c: agentDoc([promptMsg, userMsg("m2")]) });
    const seenPayloads: Array<string> = [];
    const seenOptions: Array<object | undefined> = [];
    let calls = 0;
    const transport: MessageDeliveryTransport = {
      sendManagedTerminalPrompt: async (_bindingId, text, options) => {
        calls += 1;
        seenPayloads.push(text);
        seenOptions.push(options);
        return submittedOutcome(calls - 1, calls);
      },
    };
    const service = new MessageDeliveryService();
    service.configure({ transport, store });
    // Auto paths never touch the prompt row: neither append nor boot scan
    // attempts it. Only the ordinary message goes out automatically.
    service.notifyAppended("c", "agent", promptMsg);
    service.onBooted();
    await new Promise((r) => setTimeout(r, 50));
    expect(calls).toBe(1);
    expect(await store.hasAcceptedMessageDelivery("c", "agent", "m2")).toBe(
      true,
    );
    expect(await store.hasAcceptedMessageDelivery("c", "agent", "p1")).toBe(
      false,
    );
    // The explicit call delivers the same durable row with the full-body
    // immediate payload and no drive queue.
    const result = await service.prompt({
      canvas: "c",
      nodeId: "agent",
      messageId: "p1",
    });
    expect(result).toMatchObject({
      policy: "immediate",
      outcome: { status: "submitted" },
    });
    expect(calls).toBe(2);
    expect(seenPayloads[1]?.startsWith("mail from ")).toBe(true);
    expect(seenPayloads[1]).toContain("act now");
    expect(seenOptions).toContainEqual(
      expect.objectContaining({ queueIfBusy: false }),
    );
    expect(await store.hasAcceptedMessageDelivery("c", "agent", "p1")).toBe(
      true,
    );
    // Retrying the same id after settlement reports settled, never re-pastes.
    const retry = await service.prompt({
      canvas: "c",
      nodeId: "agent",
      messageId: "p1",
    });
    expect(retry).toEqual({ unavailable: "settled" });
    expect(calls).toBe(2);
  });

  it("refuses an over-limit prompt without typing and records oversize", async () => {
    const seat = `seat_${"a".repeat(64)}`;
    const promptMsg = userMsg("p1", "x".repeat(200), {
      metadata: {
        mailKind: "prompt",
        fromSeat: seat,
        senderGeneration: "g1",
        senderHarness: "claude",
      },
    });
    const store = makeStore({ c: agentDoc([promptMsg]) });
    const ledger = makeLedger();
    let calls = 0;
    const transport: MessageDeliveryTransport = {
      sendManagedTerminalPrompt: async () => {
        calls += 1;
        return submittedOutcome();
      },
      seatDeliverySnapshot: async () => ({
        idle: true,
        generationKey: "gen-7",
        operatorDraft: false,
      }),
    };
    let clock = 100_000;
    const service = new MessageDeliveryService();
    service.configure({ transport, store, attempts: ledger, now: () => clock });
    // First call starts the settle clock and refuses retryable SeatBusy.
    const settling = await service.prompt({
      canvas: "c",
      nodeId: "agent",
      messageId: "p1",
    });
    expect(settling).toMatchObject({
      outcome: { status: "refused", reason: "seat-busy" },
    });
    clock += 2_000;
    const result = await service.prompt({
      canvas: "c",
      nodeId: "agent",
      messageId: "p1",
    });
    expect(result).toMatchObject({
      policy: "immediate",
      outcome: { status: "refused", reason: "over-limit" },
    });
    expect(calls).toBe(0);
    expect(ledger.records).toEqual([
      {
        messageId: "p1",
        set: { refusedAt: expect.any(String), refusedReason: "not-settled" },
      },
      {
        messageId: "p1",
        set: { refusedAt: expect.any(String), refusedReason: "oversize" },
      },
    ]);
    expect(await store.hasAcceptedMessageDelivery("c", "agent", "p1")).toBe(
      false,
    );
  });

  it("never wakes a stopped seat for immediate policy", async () => {
    const seat = `seat_${"a".repeat(64)}`;
    const promptMsg = userMsg("p1", "act now", {
      metadata: {
        mailKind: "prompt",
        fromSeat: seat,
        senderGeneration: "g1",
        senderHarness: "claude",
      },
    });
    const store = makeStore({ c: agentDoc([promptMsg]) });
    let wakes = 0;
    let calls = 0;
    const transport: MessageDeliveryTransport = {
      wakeManagedSeat: async () => {
        wakes += 1;
        return true;
      },
      sendManagedTerminalPrompt: async () => {
        calls += 1;
        return submittedOutcome();
      },
    };
    const service = new MessageDeliveryService();
    service.configure({ transport, store });
    const result = await service.prompt({
      canvas: "c",
      nodeId: "agent",
      messageId: "p1",
    });
    expect(result).toMatchObject({
      policy: "immediate",
      outcome: { status: "submitted" },
    });
    expect(wakes).toBe(0);
    expect(calls).toBe(1);
  });

  it("stamp-only path receipts ledger-notified rows without repasting", async () => {
    const seat = `seat_${"a".repeat(64)}`;
    const promptMsg = userMsg("p1", "act now", {
      metadata: {
        mailKind: "prompt",
        fromSeat: seat,
        senderGeneration: "g1",
        senderHarness: "claude",
      },
    });
    const store = makeStore({ c: agentDoc([promptMsg]) });
    const ledger = makeLedger();
    const notifiedFacts = {
      generation: "gen-7",
      queuedAt: new Date(0).toISOString(),
      notifiedAt: new Date(1).toISOString(),
    };
    let calls = 0;
    const transport: MessageDeliveryTransport = {
      sendManagedTerminalPrompt: async () => {
        calls += 1;
        return submittedOutcome();
      },
      seatDeliverySnapshot: async () => ({
        idle: true,
        generationKey: "gen-7",
        operatorDraft: false,
      }),
    };
    let clock = 100_000;
    const service = new MessageDeliveryService();
    service.configure({
      transport,
      store,
      attempts: {
        ...ledger,
        enqueueAttempt: async (input) => ({
          messageId: input.messageId,
          recipient: {
            seat: {
              seatId: `seat_${"b".repeat(64)}` as ActorSeatId,
              canvasName: input.canvas,
              nodeId: input.nodeId,
            },
            generation: input.generation,
          },
          policy: input.policy,
          facts: notifiedFacts,
        }),
      },
      now: () => clock,
    });
    clock += 2_000;
    // First call starts the settle clock; the second passes the gate and
    // finds the ledger-notified row, stamping without pasting.
    await service.prompt({ canvas: "c", nodeId: "agent", messageId: "p1" });
    clock += 2_000;
    const result = await service.prompt({
      canvas: "c",
      nodeId: "agent",
      messageId: "p1",
    });
    expect(result).toMatchObject({
      policy: "immediate",
      outcome: { status: "submitted", wrotePhysicalBytes: false },
    });
    expect(calls).toBe(0);
    expect(await store.hasAcceptedMessageDelivery("c", "agent", "p1")).toBe(
      true,
    );
  });
});
