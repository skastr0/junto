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

/**
 * Drain every pending async delivery chain. A wrongful transport hit
 * surfaces within microtasks, so negative assertions need no wall-clock
 * sleep; real-timer retries never fire inside a flush.
 */
const flushDelivery = async (rounds = 5): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
  }
};

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
      stallTimeoutMs: 10,
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
    const { drive } = makeDrive({
      pendingText: () => false,
      write: (bindingId, data) => {
        if (data === "\r") drive.onTurnStart(bindingId);
        return true;
      },
    });
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
  setNotified: (messageId: string) => void;
} => {
  const calls: Array<string> = [];
  const records: Array<{ messageId: string; set: object }> = [];
  const notified = new Set<string>();
  const unresolved = new Set<string>();
  // Open/close intent versioning per message: enqueue leaves (0, 0),
  // markAttempted opens (attempt += 1), recordAttempt closes
  // (resolved = attempt) — mirroring work_mail_attempts.
  const seqs = new Map<string, { attempt: number; resolved: number }>();
  const seqFor = (messageId: string) => {
    const existing = seqs.get(messageId);
    if (existing) return existing;
    const fresh = { attempt: 0, resolved: 0 };
    seqs.set(messageId, fresh);
    return fresh;
  };
  const seen = new Map<
    string,
    { canvas: string; nodeId: string; generation: string; policy: MailDeliveryPolicy }
  >();
  const markers = new Set<string>();
  const rowFor = (
    canvas: string,
    nodeId: string,
    messageId: string,
    generation: string,
    policy: MailDeliveryPolicy,
  ) => {
    const seq = seqFor(messageId);
    return {
      messageId,
      recipient: { seat: { seatId: `seat_${"b".repeat(64)}` as ActorSeatId, canvasName: canvas, nodeId }, generation },
      policy,
      facts: {
        generation,
        queuedAt: new Date(0).toISOString(),
        ...(notified.has(messageId)
          ? { notifiedAt: new Date(1).toISOString() }
          : {}),
        ...(unresolved.has(messageId) && !notified.has(messageId)
          ? { unresolvedAt: new Date(2).toISOString() }
          : {}),
      },
      attemptSeq: seq.attempt,
      resolvedSeq: seq.resolved,
    };
  };
  return {
    calls,
    records,
    setNotified: (messageId: string) => {
      notified.add(messageId);
    },
    enqueueAttempt: async (input) => {
      calls.push(`enqueue:${input.messageId}`);
      if (!seen.has(input.messageId)) {
        seen.set(input.messageId, {
          canvas: input.canvas,
          nodeId: input.nodeId,
          generation: input.generation,
          policy: input.policy,
        });
      }
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
      seqFor(input.messageId).attempt += 1;
      return rowFor(input.canvas, input.nodeId, input.messageId, input.generation, "notice");
    },
    recordAttempt: async (input) => {
      calls.push(`record:${input.messageId}`);
      records.push({ messageId: input.messageId, set: input.set });
      // Faithful double: a recorded unresolved fact persists, so a later
      // enqueueAttempt in the same generation re-reads the hold; recording
      // closes the opened intent.
      if (
        "unresolvedAt" in (input.set as Record<string, unknown>) &&
        (input.set as Record<string, unknown>).unresolvedAt !== undefined
      ) {
        unresolved.add(input.messageId);
      }
      seqFor(input.messageId).resolved = seqFor(input.messageId).attempt;
      return rowFor(input.canvas, input.nodeId, input.messageId, input.generation, "notice");
    },
    attempt: async (input) => {
      calls.push(`attempt:${input.messageId}`);
      const at = seen.get(input.messageId);
      if (!at) return undefined;
      return rowFor(at.canvas, at.nodeId, input.messageId, input.generation, at.policy);
    },
    hasNotifiedAcrossGenerations: async () => false,
    reconcileUnresolvedAttempts: async () => 0,
    listHeldAttempts: async (canvas: string) => {
      calls.push(`listHeld:${canvas}`);
      const out = [];
      for (const [messageId, at] of seen) {
        if (at.canvas !== canvas) continue;
        if (!unresolved.has(messageId) || notified.has(messageId)) continue;
        out.push(rowFor(at.canvas, at.nodeId, messageId, at.generation, at.policy));
      }
      return out;
    },
    grantHeldAttempt: async (input) => {
      calls.push(`grant:${input.messageId}`);
      // Strict WHERE mirroring the repository: only a closed held row
      // opens (unresolved, un-notified, attempt == resolved).
      if (!unresolved.has(input.messageId) || notified.has(input.messageId)) {
        return false;
      }
      const seq = seqFor(input.messageId);
      if (seq.attempt !== seq.resolved) return false;
      seq.attempt += 1;
      return true;
    },
    grantNoticeFallback: async (input) => {
      calls.push(`fallback:${input.messageId}`);
      const key = `${input.canvas}::${input.nodeId}::${input.messageId}`;
      if (markers.has(key)) return false;
      markers.add(key);
      return true;
    },
    hasNoticeFallback: async (input) => {
      calls.push(`hasFallback:${input.messageId}`);
      return markers.has(`${input.canvas}::${input.nodeId}::${input.messageId}`);
    },
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

  it("scoped resume grants exactly one retry per held row, then silence", async () => {
    const store = makeStore({ c: agentDoc([userMsg("m1")]) });
    const ledger = makeLedger();
    let calls = 0;
    const released: string[] = [];
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
      attempts: ledger,
      now: () => clock,
      timers: { set: () => ({}), clear: () => {} },
      releaseSeatHold: (bindingId) => {
        released.push(bindingId);
      },
    });
    // One wrote-physical attempt with no acknowledgement: the ledger holds
    // the uncertainty durably. The flush lets the first consult start the
    // settle clock before it is advanced.
    service.notifyAppended("c", "agent", userMsg("m1"));
    await flushDelivery();
    clock += 2_000;
    service.onManagedTerminalIdle("bind-profile-13");
    await flushDelivery();
    expect(calls).toBe(1);
    expect(
      ledger.records.some(
        (record) =>
          record.messageId === "m1" &&
          "unresolvedAt" in (record.set as Record<string, unknown>),
      ),
    ).toBe(true);
    // Idle scans never grant: the hold stands with no new transport.
    service.onManagedTerminalIdle("bind-profile-13");
    await flushDelivery();
    expect(calls).toBe(1);
    expect(ledger.calls.some((call) => call.startsWith("grant:"))).toBe(
      false,
    );
    // An explicit resume opens exactly one fresh intent and releases the
    // seat hold. Resume re-settles the seats (no paste mid-resume paint),
    // so the immediate sweep cannot spend the grant yet; the next settled
    // re-drive spends it on exactly one retry — then silence again.
    service.onResumedCanvas("c");
    await flushDelivery();
    expect(ledger.calls).toContain("grant:m1");
    expect(released).toEqual(["bind-profile-13"]);
    expect(calls).toBe(1);
    clock += 2_000;
    service.onManagedTerminalIdle("bind-profile-13");
    await flushDelivery();
    expect(calls).toBe(2);
    expect(await store.hasAcceptedMessageDelivery("c", "agent", "m1")).toBe(
      false,
    );
    service.onManagedTerminalIdle("bind-profile-13");
    await flushDelivery();
    expect(calls).toBe(2);
    // A second explicit resume authorizes exactly one more retry.
    service.onResumedCanvas("c");
    await flushDelivery();
    expect(calls).toBe(2);
    clock += 2_000;
    service.onManagedTerminalIdle("bind-profile-13");
    await flushDelivery();
    expect(calls).toBe(3);
  });

  it("plain immediate busy stays immediate with no notice marker", async () => {
    const seat = `seat_${"a".repeat(64)}`;
    const promptMsg = userMsg("p1", " please review", {
      metadata: {
        mailKind: "prompt",
        fromSeat: seat,
        senderGeneration: "g1",
        senderHarness: "claude",
      },
    });
    const store = makeStore({ c: agentDoc([promptMsg]) });
    const ledger = makeLedger();
    let busy = true;
    let calls = 0;
    const transport: MessageDeliveryTransport = {
      wakeManagedSeat: async () => true,
      seatDeliverySnapshot: async () => ({
        idle: !busy,
        generationKey: "gen-7",
        operatorDraft: false,
      }),
      sendManagedTerminalPrompt: async () => {
        calls += 1;
        return submittedOutcome();
      },
    };
    let clock = 100_000;
    const service = new MessageDeliveryService();
    service.configure({
      transport,
      store,
      attempts: ledger,
      now: () => clock,
      timers: { set: () => ({}), clear: () => {} },
    });
    // The seat is working: the plain immediate prompt refuses seat-busy and
    // persists no fallback marker — a busy refusal never auto-degrades to
    // notice. The row stays durable immediate, retryable under the same id.
    const deferred = await service.prompt({
      canvas: "c",
      nodeId: "agent",
      messageId: "p1",
    });
    expect(deferred).toMatchObject({
      policy: "immediate",
      outcome: { status: "refused", reason: "seat-busy" },
    });
    expect(
      ledger.calls.some((call) => call.startsWith("fallback:")),
    ).toBe(false);
    expect(calls).toBe(0);
    // The seat idles and settles: with no marker the row stays
    // explicit-only and the automatic scans never touch the transport.
    busy = false;
    clock += 2_000;
    service.onManagedTerminalIdle("bind-profile-13");
    await flushDelivery();
    clock += 2_000;
    service.onManagedTerminalIdle("bind-profile-13");
    await flushDelivery();
    expect(calls).toBe(0);
    expect(await store.hasAcceptedMessageDelivery("c", "agent", "p1")).toBe(
      false,
    );
    // Explicit-only rows do not consult the automatic seat gate. The first
    // same-id retry observes idle and starts settle, then the next submits.
    expect(await service.prompt({
      canvas: "c",
      nodeId: "agent",
      messageId: "p1",
    })).toMatchObject({ outcome: { status: "refused", reason: "seat-busy", wrotePhysicalBytes: false } });
    clock += 2_000;
    const retry = await service.prompt({
      canvas: "c",
      nodeId: "agent",
      messageId: "p1",
    });
    expect(retry).toMatchObject({
      outcome: { status: "submitted" },
    });
    expect(calls).toBe(1);
  });

  it("explicit fallback persists its marker write-ahead and the notice path delivers it", async () => {
    const seat = `seat_${"a".repeat(64)}`;
    const promptMsg = userMsg("p1", " please review", {
      metadata: {
        mailKind: "prompt",
        fromSeat: seat,
        senderGeneration: "g1",
        senderHarness: "claude",
      },
    });
    const store = makeStore({ c: agentDoc([promptMsg]) });
    const ledger = makeLedger();
    let busy = true;
    let calls = 0;
    const transport: MessageDeliveryTransport = {
      wakeManagedSeat: async () => true,
      seatDeliverySnapshot: async () => ({
        idle: !busy,
        generationKey: "gen-7",
        operatorDraft: false,
      }),
      sendManagedTerminalPrompt: async () => {
        calls += 1;
        return submittedOutcome();
      },
    };
    let clock = 100_000;
    const service = new MessageDeliveryService();
    service.configure({
      transport,
      store,
      attempts: ledger,
      now: () => clock,
      timers: { set: () => ({}), clear: () => {} },
    });
    // The seat is working: the explicit notice fallback refuses seat-busy
    // but persists its marker write-ahead — before any gate or transport —
    // so a crash cannot lose the operator's request.
    const deferred = await service.prompt({
      canvas: "c",
      nodeId: "agent",
      messageId: "p1",
      fallback: "notice",
    });
    expect(deferred).toMatchObject({
      policy: "notice",
      outcome: { status: "refused", reason: "seat-busy" },
    });
    expect(ledger.calls[0]).toBe("fallback:p1");
    expect(calls).toBe(0);
    // The seat idles: the first idle observation starts the settle clock,
    // so the notice path re-admits the marked row but cannot paste yet.
    busy = false;
    clock += 2_000;
    service.onManagedTerminalIdle("bind-profile-13");
    await flushDelivery();
    expect(calls).toBe(0);
    // Settled: the notice path delivers the marked row exactly once.
    clock += 2_000;
    service.onManagedTerminalIdle("bind-profile-13");
    await flushDelivery();
    expect(calls).toBe(1);
    expect(await store.hasAcceptedMessageDelivery("c", "agent", "p1")).toBe(
      true,
    );
    service.onManagedTerminalIdle("bind-profile-13");
    await flushDelivery();
    expect(calls).toBe(1);
  });

  it("over-limit prompt verdicts never persist a fallback marker", async () => {
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
      wakeManagedSeat: async () => true,
      seatDeliverySnapshot: async () => ({
        idle: true,
        generationKey: "gen-7",
        operatorDraft: false,
      }),
      sendManagedTerminalPrompt: async () => {
        calls += 1;
        return submittedOutcome();
      },
    };
    let clock = 100_000;
    const service = new MessageDeliveryService();
    service.configure({
      transport,
      store,
      attempts: ledger,
      now: () => clock,
      timers: { set: () => ({}), clear: () => {} },
    });
    await service.prompt({ canvas: "c", nodeId: "agent", messageId: "p1" });
    clock += 2_000;
    const refused = await service.prompt({
      canvas: "c",
      nodeId: "agent",
      messageId: "p1",
    });
    expect(refused).toMatchObject({
      outcome: { status: "refused", reason: "over-limit" },
    });
    expect(ledger.calls.some((call) => call.startsWith("fallback:"))).toBe(
      false,
    );
    // No marker, no notice: the verdict stands and the scan stays silent.
    service.onManagedTerminalIdle("bind-profile-13");
    await flushDelivery();
    expect(calls).toBe(0);
    expect(await store.hasAcceptedMessageDelivery("c", "agent", "p1")).toBe(
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

  it.each([
    { bodyLen: 160, admitted: true },
    { bodyLen: 161, admitted: false },
  ])(
    "counts the 160 cap on body characters only (body $bodyLen)",
    async ({ bodyLen, admitted }) => {
      const seat = `seat_${"a".repeat(64)}`;
      const promptMsg = userMsg("p1", "x".repeat(bodyLen), {
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
      let seenPayload = "";
      const transport: MessageDeliveryTransport = {
        sendManagedTerminalPrompt: async (_bindingId, payload) => {
          calls += 1;
          seenPayload = payload;
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
      await service.prompt({ canvas: "c", nodeId: "agent", messageId: "p1" });
      clock += 2_000;
      const result = await service.prompt({
        canvas: "c",
        nodeId: "agent",
        messageId: "p1",
      });
      if (admitted) {
        // The composed payload carries the sender envelope on top of the
        // body, so payload.length is well over 160 — the cap must ignore it.
        expect(seenPayload.length).toBeGreaterThan(160);
        expect(result).toMatchObject({
          policy: "immediate",
          outcome: { status: "submitted" },
        });
        expect(calls).toBe(1);
      } else {
        expect(result).toMatchObject({
          policy: "immediate",
          outcome: { status: "refused", reason: "over-limit" },
        });
        expect(calls).toBe(0);
      }
    },
  );

  it("stamp-only replays bypass the immediate cap with no new write", async () => {
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
    await service.prompt({ canvas: "c", nodeId: "agent", messageId: "p1" });
    clock += 2_000;
    // A durable acceptance from an earlier process turns this call into a
    // stamp-only replay: the over-limit body must not refuse it.
    ledger.setNotified("p1");
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

const operatorPromptMsg = (id: string, text = "act now"): Message =>
  userMsg(id, text, {
    metadata: {
      mailKind: "prompt",
      operatorPrompt: true,
      fromSeat: `seat_${"c".repeat(64)}`,
      senderGeneration: "operator",
      senderHarness: "unknown",
      senderName: "operator",
      senderNodeId: "operator",
    },
  });

describe("operatorPrompt boundary re-drive", () => {
  it("admits a flagged prompt row through attemptOne with immediate policy", async () => {
    const prompt = operatorPromptMsg("op1", "deliver now");
    const store = makeStore({ c: agentDoc([prompt]) });
    const seenPayloads: string[] = [];
    const seenOptions: Array<object | undefined> = [];
    const transport: MessageDeliveryTransport = {
      sendManagedTerminalPrompt: async (_bindingId, text, options) => {
        seenPayloads.push(text);
        seenOptions.push(options);
        return submittedOutcome();
      },
    };
    const service = new MessageDeliveryService();
    service.configure({ transport, store });
    service.notifyAppended("c", "agent", prompt);
    await flushDelivery();
    expect(seenPayloads).toHaveLength(1);
    expect(seenPayloads[0]?.startsWith("mail from operator")).toBe(true);
    expect(seenPayloads[0]).toContain("deliver now");
    expect(seenOptions).toContainEqual(
      expect.objectContaining({ queueIfBusy: false }),
    );
    expect(await store.hasAcceptedMessageDelivery("c", "agent", "op1")).toBe(
      true,
    );
  });

  it("gate refusal leaves the row pending without burning transport attempts", async () => {
    const prompt = operatorPromptMsg("op1");
    const store = makeStore({ c: agentDoc([prompt]) });
    const ledger = makeLedger();
    let idle = false;
    let calls = 0;
    const transport: MessageDeliveryTransport = {
      seatDeliverySnapshot: async () => ({
        idle,
        generationKey: "gen-7",
        operatorDraft: false,
      }),
      sendManagedTerminalPrompt: async () => {
        calls += 1;
        return submittedOutcome();
      },
    };
    let clock = 100_000;
    const service = new MessageDeliveryService();
    service.configure({
      transport,
      store,
      attempts: ledger,
      now: () => clock,
      timers: { set: () => ({}), clear: () => {} },
    });
    service.notifyAppended("c", "agent", prompt);
    await flushDelivery();
    expect(calls).toBe(0);
    expect(await store.hasAcceptedMessageDelivery("c", "agent", "op1")).toBe(
      false,
    );
    expect(
      ledger.calls.some((call) => call.startsWith("mark:")),
    ).toBe(false);
    idle = true;
    clock += 2_000;
    service.onManagedTerminalIdle("bind-profile-13");
    await flushDelivery();
    clock += 2_000;
    service.onManagedTerminalIdle("bind-profile-13");
    await flushDelivery();
    expect(calls).toBe(1);
    expect(await store.hasAcceptedMessageDelivery("c", "agent", "op1")).toBe(
      true,
    );
  });

  it("unresolved hold still blocks same-generation retry", async () => {
    const prompt = operatorPromptMsg("op1");
    const store = makeStore({ c: agentDoc([prompt]) });
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
    service.notifyAppended("c", "agent", prompt);
    await flushDelivery();
    expect(calls).toBe(1);
    service.onManagedTerminalIdle("bind-profile-13");
    await flushDelivery();
    service.onComposerEmpty("bind-profile-13");
    await flushDelivery();
    expect(calls).toBe(1);
    expect(await store.hasAcceptedMessageDelivery("c", "agent", "op1")).toBe(
      false,
    );
  });

  it("attemptBatch never swallows flagged prompt rows into a notice dump", async () => {
    const notices = [userMsg("n1", "first"), userMsg("n2", "second")];
    const prompt = operatorPromptMsg("op1", "operator body");
    const store = makeStore({ c: agentDoc([...notices, prompt]) });
    const seenPayloads: string[] = [];
    const transport: MessageDeliveryTransport = {
      sendManagedTerminalPrompt: async (_bindingId, text) => {
        seenPayloads.push(text);
        return submittedOutcome(seenPayloads.length - 1, seenPayloads.length);
      },
    };
    const service = new MessageDeliveryService();
    service.configure({ transport, store });
    service.onBooted();
    await flushDelivery(10);
    const promptPayload = seenPayloads.find((text) =>
      text.includes("operator body"),
    );
    expect(promptPayload).toBeDefined();
    expect(promptPayload?.startsWith("mail from operator")).toBe(true);
    expect(seenPayloads.some((text) => text.includes("2 unread"))).toBe(true);
    expect(await store.hasAcceptedMessageDelivery("c", "agent", "op1")).toBe(
      true,
    );
    expect(await store.hasAcceptedMessageDelivery("c", "agent", "n1")).toBe(
      true,
    );
    expect(await store.hasAcceptedMessageDelivery("c", "agent", "n2")).toBe(
      true,
    );
  });

  it("MAX_TRANSPORT_ATTEMPTS parks a flagged prompt after failed writes", async () => {
    const prompt = operatorPromptMsg("op1");
    const store = makeStore({ c: agentDoc([prompt]) });
    let calls = 0;
    const transport: MessageDeliveryTransport = {
      sendManagedTerminalPrompt: async () => {
        calls += 1;
        return {
          status: "refused",
          reason: "clipboard-unsafe",
          bindingGeneration: 0,
          writesBefore: calls - 1,
          writesAfter: calls,
          pasteWrites: 1,
          wrotePhysicalBytes: true,
        };
      },
    };
    const service = new MessageDeliveryService();
    service.configure({
      transport,
      store,
      timers: { set: () => ({}), clear: () => {} },
    });
    service.notifyAppended("c", "agent", prompt);
    await flushDelivery();
    for (let i = 0; i < 4; i += 1) {
      service.onManagedTerminalIdle("bind-profile-13");
      await flushDelivery();
    }
    expect(calls).toBe(3);
    expect(await store.hasAcceptedMessageDelivery("c", "agent", "op1")).toBe(
      false,
    );
  });
});
