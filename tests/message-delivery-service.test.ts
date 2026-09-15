import { describe, expect, it } from "vitest";
import { ulid } from "ulid";
import type { CanvasDoc, CanvasNode, Message } from "../src/shared/canvas";
import { isMessageDelivered } from "../src/shared/message-delivery";
import {
  MESSAGE_DELIVERY_INDEX_RECONCILE_MS,
  MessageDeliveryService,
  type MessageDeliveryStore,
  type MessageDeliveryTransport,
} from "../src/main/vellum-command/work/message-delivery";
import type { ManagedPromptOutcome } from "../src/shared/managed-prompt";

/** Submitted acceptance with one paste envelope of write evidence. */
const submittedOutcome = (): ManagedPromptOutcome => ({
  status: "submitted",
  bindingGeneration: 0,
  writesBefore: 0,
  writesAfter: 1,
  pasteWrites: 1,
  wrotePhysicalBytes: true,
});

/** Clean pre-write refusal: nothing reached the PTY, retryable. */
const refusedOutcome = (): ManagedPromptOutcome => ({
  status: "refused",
  reason: "seat-busy",
  bindingGeneration: 0,
  writesBefore: 0,
  writesAfter: 0,
  pasteWrites: 0,
  wrotePhysicalBytes: false,
});

/** Bytes reached the PTY without acknowledgement: same generation holds. */
const unresolvedOutcome = (): ManagedPromptOutcome => ({
  status: "unresolved",
  reason: "no-turn-start",
  bindingGeneration: 0,
  writesBefore: 0,
  writesAfter: 1,
  pasteWrites: 1,
  wrotePhysicalBytes: true,
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

const terminalDoc = (messages: ReadonlyArray<Message>): CanvasDoc => ({
  nodes: [
    {
      id: "terminal",
      type: "text",
      text: "cp",
      x: 0,
      y: 0,
      width: 100,
      height: 80,
      ether: {
        entity: { kind: "agent", name: "local:claude" },
        terminal: { bindingId: "bind-term", harness: "claude" },
        messages: { items: [...messages] },
      },
    },
  ],
  edges: [],
});

const makeStore = (
  initial: Record<string, CanvasDoc>,
  options: {
    readonly acceptOk?: () => boolean;
    readonly acceptMessage?: (messageId: string) => boolean;
    readonly acceptReadOk?: () => boolean;
    readonly now?: () => number;
    /**
     * Hand back the live document map so a test can write to the durable store
     * the way station fact ingress does — behind the service's back.
     */
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
    // Faithful double: the node-scoped read answers from the same documents
    // the full read does, minus the work projection this fake never had.
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
      const k = keyOf(canvas, nodeId, messageId);
      accepted.add(k);
      // Mirror projection enrichment so isPendingDelivery/tests see stop.
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
      if (options.acceptReadOk && !options.acceptReadOk()) return false;
      const k = keyOf(canvas, nodeId, messageId);
      acceptedRead.add(k);
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

/**
 * Drain every pending async delivery chain. A wrongful transport hit
 * surfaces within microtasks, so negative assertions (nothing sent) need no
 * wall-clock sleep — one macrotask yield drains the full microtask queue
 * including chained continuations; several rounds cover chains that hop
 * through resolved promises. Real-timer retries (settle/gate backoff) never
 * fire inside a flush.
 */
const flushDelivery = async (rounds = 5): Promise<void> => {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((r) => setTimeout(r, 0));
  }
};

describe("MessageDeliveryService", () => {
  it("pushes an operator response to the exact requesting actor", async () => {
    const store = makeStore({ c: agentDoc([]) });
    const writes: Array<{ bindingId: string; text: string }> = [];
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        sendManagedTerminalPrompt: async (bindingId, text) => {
          writes.push({ bindingId, text });
          return submittedOutcome();
        },
      },
      store,
    });

    service.notifyRequestResolved({
      canvas: "c",
      actorNodeId: "agent",
      requestId: "request-7",
      response: "Use the staging key.",
    });

    await waitUntil(() => writes.length === 1);
    expect(writes).toEqual([
      {
        bindingId: "bind-profile-13",
        text: "[request resolved - request-7] Use the staging key.",
      },
    ]);
  });

  it("nudges EVERY matching actor ref when one request resolves", async () => {
    // The work service resolves a request whose claiming seat maps to several
    // actor node refs: each ref gets its own nudge (pendingRequestResponses
    // is keyed by canvas::actorNodeId::request::requestId), never a
    // length-1 drop.
    const store = makeStore({ c: twoAgentDoc() });
    const writes: Array<{ bindingId: string; text: string }> = [];
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        sendManagedTerminalPrompt: async (bindingId, text) => {
          writes.push({ bindingId, text });
          return submittedOutcome();
        },
      },
      store,
    });

    service.notifyRequestResolved({
      canvas: "c",
      actorNodeId: "agent",
      requestId: "request-multi",
      response: "ok",
    });
    service.notifyRequestResolved({
      canvas: "c",
      actorNodeId: "agent-2",
      requestId: "request-multi",
      response: "ok",
    });

    await waitUntil(() => writes.length === 2);
    expect([...writes].sort((a, b) => a.bindingId.localeCompare(b.bindingId))).toEqual([
      { bindingId: "bind-nova", text: "[request resolved - request-multi] ok" },
      {
        bindingId: "bind-profile-13",
        text: "[request resolved - request-multi] ok",
      },
    ]);
  });

  it("retries a refused request response when the seat becomes idle", async () => {
    const store = makeStore({ c: agentDoc([]) });
    let accepts = false;
    const writes: string[] = [];
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        sendManagedTerminalPrompt: async (_bindingId, text) => {
          writes.push(text);
          return accepts ? submittedOutcome() : refusedOutcome();
        },
      },
      store,
    });

    service.notifyRequestResolved({
      canvas: "c",
      actorNodeId: "agent",
      requestId: "request-8",
      response: "Proceed.",
    });
    await waitUntil(() => writes.length === 1);
    accepts = true;
    service.onManagedTerminalIdle("bind-profile-13");
    await waitUntil(() => writes.length === 2);
    service.onManagedTerminalIdle("bind-profile-13");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(writes).toHaveLength(2);
  });

  it("accepts durable delivery when managed terminal drive accepts", async () => {
    const msg = userMsg("m1");
    const store = makeStore(
      { c: agentDoc([msg]) },
      { now: () => 1_111 },
    );
    const payloads: string[] = [];
    const sendManagedTerminalPrompt = async (_bindingId: string, text: string) => {
      payloads.push(text);
      return submittedOutcome();
    };
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        sendManagedTerminalPrompt,
      },
      store,
      now: () => 1_111,
    });

    service.notifyAppended("c", "agent", msg);
    await waitUntil(async () =>
      store.hasAcceptedMessageDelivery("c", "agent", "m1"),
    );
    expect(payloads).toEqual(["[message - user] ping"]);
    const live = (await store.readDoc("c", "scan"))?.nodes[0]?.ether?.messages?.items[0];
    expect(live?.metadata?.deliveredAt).toBe(1_111);
  });

  it("wakes a lazy seat before queuing mailbox delivery", async () => {
    const msg = userMsg("cold-mail", "hello cold seat");
    const store = makeStore({ c: agentDoc([msg]) });
    const wakes: Array<{ readonly canvas: string; readonly nodeId: string }> = [];
    const calls: Array<{
      readonly bindingId: string;
      readonly text: string;
      readonly ready: boolean | undefined;
    }> = [];
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        wakeManagedSeat: async (canvas, nodeId) => {
          wakes.push({ canvas, nodeId });
          return true;
        },
        sendManagedTerminalPrompt: async (bindingId, text, options) => {
          calls.push({ bindingId, text, ready: options?.ready });
          return submittedOutcome();
        },
      },
      store,
    });

    service.notifyAppended("c", "agent", msg);
    await waitUntil(() => calls.length === 1);
    expect(wakes).toEqual([{ canvas: "c", nodeId: "agent" }]);
    expect(calls).toEqual([
      {
        bindingId: "bind-profile-13",
        text: "[message - user] hello cold seat",
        ready: true,
      },
    ]);
  });

  it("keeps mailbox delivery pending when the lazy seat cannot wake", async () => {
    const msg = userMsg("cold-mail-refused", "try later");
    const store = makeStore({ c: agentDoc([msg]) });
    let sends = 0;
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        wakeManagedSeat: async () => false,
        sendManagedTerminalPrompt: async () => {
          sends += 1;
          return submittedOutcome();
        },
      },
      store,
    });

    service.notifyAppended("c", "agent", msg);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sends).toBe(0);
    expect(await store.hasAcceptedMessageDelivery("c", "agent", msg.messageId)).toBe(
      false,
    );
  });

  it("at-most-once under rapid append burst", async () => {
    const msg = userMsg("burst");
    const store = makeStore({ c: agentDoc([msg]) });
    let resolveSend!: (v: ManagedPromptOutcome) => void;
    let sendCount = 0;
    const sendManagedTerminalPrompt = (_bindingId: string, _text: string) => {
      sendCount += 1;
      return new Promise<ManagedPromptOutcome>((resolve) => {
        resolveSend = resolve;
      });
    };
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        sendManagedTerminalPrompt,
      },
      store,
      now: () => 2,
    });

    service.notifyAppended("c", "agent", msg);
    service.notifyAppended("c", "agent", msg);
    service.notifyAppended("c", "agent", msg);
    await waitUntil(() => sendCount === 1);
    expect(sendCount).toBe(1);
    resolveSend(submittedOutcome());
    await waitUntil(async () => {
      const doc = await store.readDoc("c", "scan");
      return isMessageDelivered(doc!.nodes[0]!.ether!.messages!.items[0]!);
    });
    expect(sendCount).toBe(1);
  });

  it("does not batch a message while its individual delivery is in flight", async () => {
    const msgs = [userMsg("m-one", "first"), userMsg("m-two", "second")];
    const store = makeStore({ c: agentDoc(msgs) });
    const payloads: string[] = [];
    let releaseFirst!: (outcome: ManagedPromptOutcome) => void;
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        wakeManagedSeat: async () => true,
        sendManagedTerminalPrompt: async (_bindingId, text) => {
          payloads.push(text);
          if (payloads.length === 1) {
            return new Promise<ManagedPromptOutcome>((resolve) => {
              releaseFirst = resolve;
            });
          }
          return submittedOutcome();
        },
      },
      store,
    });

    service.notifyAppended("c", "agent", msgs[0]!);
    await waitUntil(() => payloads.length === 1);

    // Boot scans the full durable backlog while m-one is still awaiting its
    // individual transport result. It must leave that message out of the
    // batch so the same payload cannot be requested twice.
    service.onBooted();
    await waitUntil(() => payloads.length === 2);
    expect(payloads[0]).toBe("[message - user] first");
    expect(payloads[1]).toBe("[message - user] second");

    releaseFirst(submittedOutcome());
    await waitUntil(async () =>
      (await store.hasAcceptedMessageDelivery("c", "agent", "m-one")) &&
      (await store.hasAcceptedMessageDelivery("c", "agent", "m-two")),
    );
    expect(payloads).toHaveLength(2);
  });

  it("spends one notice per observed turn and re-opens on turn-start", async () => {
    let docs!: Map<string, CanvasDoc>;
    const store = makeStore({ c: agentDoc([userMsg("m1", "one")]) }, {
      onDocs: (current) => {
        docs = current;
      },
    });
    const payloads: string[] = [];
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        wakeManagedSeat: async () => true,
        sendManagedTerminalPrompt: async (_bindingId, text) => {
          payloads.push(text);
          return submittedOutcome();
        },
      },
      store,
    });
    const append = (id: string): void => {
      const msg = userMsg(id, id);
      const doc = docs.get("c")!;
      const node = doc.nodes.find((n) => n.id === "agent")!;
      docs.set("c", {
        ...doc,
        nodes: doc.nodes.map((n) =>
          n.id === "agent"
            ? {
              ...node,
              ether: {
                ...(node.ether ?? {}),
                messages: {
                  items: [...(node.ether?.messages?.items ?? []), msg],
                },
              },
            }
            : n,
        ),
      });
      service.notifyAppended("c", "agent", msg);
    };

    // Boot backlog goes out with no observed turn (no window, no budget).
    service.onBooted();
    await waitUntil(() => payloads.length === 1);

    // First observed turn opens window 1; the next notice spends it.
    service.onManagedTerminalTurnStart("bind-profile-13");
    append("m2");
    await waitUntil(() => payloads.length === 2);

    // Same window: a further notice stays pending with no transport hit.
    append("m3");
    await flushDelivery();
    expect(payloads).toHaveLength(2);
    expect(await store.hasAcceptedMessageDelivery("c", "agent", "m3")).toBe(
      false,
    );

    // Next observed turn re-opens: the held notice goes out on idle.
    service.onManagedTerminalTurnStart("bind-profile-13");
    service.onManagedTerminalIdle("bind-profile-13");
    await waitUntil(() => payloads.length === 3);
    expect(payloads[2]).toContain("m3");
    expect(await store.hasAcceptedMessageDelivery("c", "agent", "m3")).toBe(
      true,
    );
  });

  it("budgets the initial window: one pre-turn notice, the next waits for turn-start", async () => {
    let docs!: Map<string, CanvasDoc>;
    const store = makeStore({ c: agentDoc([userMsg("m1", "one")]) }, {
      onDocs: (current) => {
        docs = current;
      },
    });
    const payloads: string[] = [];
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        wakeManagedSeat: async () => true,
        sendManagedTerminalPrompt: async (_bindingId, text) => {
          payloads.push(text);
          return submittedOutcome();
        },
      },
      store,
    });
    const append = (id: string, text: string): void => {
      const msg = userMsg(id, text);
      const doc = docs.get("c")!;
      const node = doc.nodes.find((n) => n.id === "agent")!;
      docs.set("c", {
        ...doc,
        nodes: doc.nodes.map((n) =>
          n.id === "agent"
            ? {
              ...node,
              ether: {
                ...(node.ether ?? {}),
                messages: {
                  items: [...(node.ether?.messages?.items ?? []), msg],
                },
              },
            }
            : n,
        ),
      });
      service.notifyAppended("c", "agent", msg);
    };
    service.onBooted();
    await waitUntil(() => payloads.length === 1);

    // Epoch 0 is a real budget: the second pre-turn notice stays pending.
    append("m2", "two");
    await flushDelivery();
    expect(payloads).toHaveLength(1);
    expect(await store.hasAcceptedMessageDelivery("c", "agent", "m2")).toBe(
      false,
    );

    // The first observed turn-start opens the next window: it goes out.
    service.onManagedTerminalTurnStart("bind-profile-13");
    service.onManagedTerminalIdle("bind-profile-13");
    await waitUntil(() => payloads.length === 2);
    expect(payloads[1]).toContain("two");
  });

  it("a working event during initialization opens the first window intact", async () => {
    // The seat is already working when the service first sees it: the
    // turn-start opens epoch 1 before any gate consult, and the first
    // sighting of the initial generation must not reset it.
    let docs!: Map<string, CanvasDoc>;
    const store = makeStore({ c: agentDoc([userMsg("m1", "one")]) }, {
      onDocs: (current) => {
        docs = current;
      },
    });
    let clock = 100_000;
    const payloads: string[] = [];
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        wakeManagedSeat: async () => true,
        seatDeliverySnapshot: async () => ({
          idle: true,
          generationKey: "g1",
          operatorDraft: false,
        }),
        sendManagedTerminalPrompt: async (_bindingId, text) => {
          payloads.push(text);
          return submittedOutcome();
        },
      },
      store,
      now: () => clock,
    });
    const append = (id: string): void => {
      const msg = userMsg(id, id);
      const doc = docs.get("c")!;
      const node = doc.nodes.find((n) => n.id === "agent")!;
      docs.set("c", {
        ...doc,
        nodes: doc.nodes.map((n) =>
          n.id === "agent"
            ? {
              ...node,
              ether: {
                ...(node.ether ?? {}),
                messages: {
                  items: [...(node.ether?.messages?.items ?? []), msg],
                },
              },
            }
            : n,
        ),
      });
      service.notifyAppended("c", "agent", msg);
    };
    service.onManagedTerminalTurnStart("bind-profile-13");
    service.notifyAppended("c", "agent", userMsg("m1", "one"));
    await flushDelivery();
    clock += 2_000;
    service.onManagedTerminalIdle("bind-profile-13");
    await waitUntil(() => payloads.length === 1);
    // Epoch 1 spent by m1: m2 waits for the next turn-start.
    append("m2");
    service.onManagedTerminalIdle("bind-profile-13");
    await flushDelivery();
    expect(payloads).toHaveLength(1);
    service.onManagedTerminalTurnStart("bind-profile-13");
    service.onManagedTerminalIdle("bind-profile-13");
    await waitUntil(() => payloads.length === 2);
    expect(payloads[1]).toContain("m2");
  });

  it("charges the admission window when turn-start fires mid-flight", async () => {
    let docs!: Map<string, CanvasDoc>;
    const store = makeStore({ c: agentDoc([userMsg("m1", "one")]) }, {
      onDocs: (current) => {
        docs = current;
      },
    });
    const payloads: string[] = [];
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        wakeManagedSeat: async () => true,
        sendManagedTerminalPrompt: async (bindingId, text) => {
          payloads.push(text);
          // The real drive emits working/turn-start BEFORE resolving
          // submitted. The spend must hit the admission window (epoch 0),
          // never the window this opens (epoch 1). Only the first send
          // opens a window, so the test also pins the normal spend below.
          if (payloads.length === 1) {
            service.onManagedTerminalTurnStart(bindingId);
          }
          return submittedOutcome();
        },
      },
      store,
    });
    const append = (id: string): void => {
      const msg = userMsg(id, id);
      const doc = docs.get("c")!;
      const node = doc.nodes.find((n) => n.id === "agent")!;
      docs.set("c", {
        ...doc,
        nodes: doc.nodes.map((n) =>
          n.id === "agent"
            ? {
              ...node,
              ether: {
                ...(node.ether ?? {}),
                messages: {
                  items: [...(node.ether?.messages?.items ?? []), msg],
                },
              },
            }
            : n,
        ),
      });
      service.notifyAppended("c", "agent", msg);
    };
    service.onBooted();
    await waitUntil(() => payloads.length === 1);

    // Fresh mail in the window the mid-flight turn-start opened goes out
    // exactly once on the next idle — the spend stayed on epoch 0.
    append("m2");
    service.onManagedTerminalIdle("bind-profile-13");
    await waitUntil(() => payloads.length === 2);
    expect(payloads[1]).toContain("m2");

    // And window 1 is now spent by m2: a third notice waits for turn 2.
    append("m3");
    service.onManagedTerminalIdle("bind-profile-13");
    await flushDelivery();
    expect(payloads).toHaveLength(2);
    service.onManagedTerminalTurnStart("bind-profile-13");
    service.onManagedTerminalIdle("bind-profile-13");
    await waitUntil(() => payloads.length === 3);
  });

  it("resets the turn window on a terminal generation cut", async () => {
    let docs!: Map<string, CanvasDoc>;
    const store = makeStore({ c: agentDoc([userMsg("m1", "one")]) }, {
      onDocs: (current) => {
        docs = current;
      },
    });
    let generationKey = "g1";
    let clock = 100_000;
    const payloads: string[] = [];
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        wakeManagedSeat: async () => true,
        seatDeliverySnapshot: async () => ({
          idle: true,
          generationKey,
          operatorDraft: false,
        }),
        sendManagedTerminalPrompt: async (_bindingId, text) => {
          payloads.push(text);
          return submittedOutcome();
        },
      },
      store,
      now: () => clock,
    });
    const append = (id: string): void => {
      const msg = userMsg(id, id);
      const doc = docs.get("c")!;
      const node = doc.nodes.find((n) => n.id === "agent")!;
      docs.set("c", {
        ...doc,
        nodes: doc.nodes.map((n) =>
          n.id === "agent"
            ? {
              ...node,
              ether: {
                ...(node.ether ?? {}),
                messages: {
                  items: [...(node.ether?.messages?.items ?? []), msg],
                },
              },
            }
            : n,
        ),
      });
      service.notifyAppended("c", "agent", msg);
    };

    // Settle, then deliver m1 and spend window 1 on m2. The flush lets the
    // fire-and-forget first consult start the settle clock BEFORE it is
    // advanced — without the drain both consults see the same fake time and
    // settle never elapses.
    service.notifyAppended("c", "agent", userMsg("m1", "one"));
    await flushDelivery();
    clock += 2_000;
    service.onManagedTerminalIdle("bind-profile-13");
    await waitUntil(() => payloads.length === 1);
    service.onManagedTerminalTurnStart("bind-profile-13");
    append("m2");
    await waitUntil(() => payloads.length === 2);
    append("m3");
    await flushDelivery();
    expect(payloads).toHaveLength(2);

    // The seat restarts (generation cut): the window resets, so the held
    // notice goes out once the new generation settles — no turn-start needed.
    generationKey = "g2";
    clock += 2_000;
    service.onManagedTerminalIdle("bind-profile-13");
    await flushDelivery();
    expect(payloads).toHaveLength(2);
    clock += 2_000;
    service.onManagedTerminalIdle("bind-profile-13");
    await waitUntil(() => payloads.length === 3);
    expect(payloads[2]).toContain("m3");
  });

  it("onResumedCanvas re-drives only the named canvas", async () => {
    const docFor = (bindingId: string, msg: Message): CanvasDoc => ({
      nodes: [
        {
          id: "agent",
          type: "text",
          text: "profile",
          x: 0,
          y: 0,
          width: 100,
          height: 80,
          ether: {
            entity: { kind: "agent", name: "local:profile" },
            terminal: { bindingId, harness: "claude" },
            messages: { items: [msg] },
          },
        },
      ],
      edges: [],
    });
    const store = makeStore({
      c: docFor("bind-one", userMsg("m-c1", "mail-c1")),
      c2: docFor("bind-two", userMsg("m-c2", "mail-c2")),
    });
    let wake = false;
    const payloads: string[] = [];
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        wakeManagedSeat: async () => wake,
        sendManagedTerminalPrompt: async (_bindingId, text) => {
          payloads.push(text);
          return submittedOutcome();
        },
      },
      store,
    });

    // Both canvases hold pending mail while the seats refuse wake.
    service.onBooted();
    await flushDelivery();
    expect(payloads).toHaveLength(0);

    // Resuming one canvas delivers its mail and leaves the other pending.
    wake = true;
    service.onResumedCanvas("c");
    await waitUntil(() =>
      store.hasAcceptedMessageDelivery("c", "agent", "m-c1"),
    );
    await flushDelivery();
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toContain("mail-c1");
    expect(await store.hasAcceptedMessageDelivery("c2", "agent", "m-c2")).toBe(
      false,
    );

    service.onResumedCanvas("c2");
    await waitUntil(() =>
      store.hasAcceptedMessageDelivery("c2", "agent", "m-c2"),
    );
    expect(payloads).toHaveLength(2);
    expect(payloads[1]).toContain("mail-c2");
  });

  it("does not re-paste a partial batch when only its failed member remains", async () => {
    const msgs = [userMsg("b-one", "first"), userMsg("b-two", "second")];
    let acceptSecond = false;
    let docs!: Map<string, CanvasDoc>;
    const store = makeStore(
      { c: agentDoc(msgs) },
      {
        acceptMessage: (messageId) => messageId !== "b-two" || acceptSecond,
        onDocs: (current) => {
          docs = current;
        },
      },
    );
    const payloads: string[] = [];
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        wakeManagedSeat: async () => true,
        sendManagedTerminalPrompt: async (_bindingId, text) => {
          payloads.push(text);
          return submittedOutcome();
        },
      },
      store,
    });

    service.onBooted();
    await waitUntil(async () =>
      (await store.hasAcceptedMessageDelivery("c", "agent", "b-one")) &&
      !(await store.hasAcceptedMessageDelivery("c", "agent", "b-two")),
    );
    expect(payloads).toHaveLength(1);

    const current = docs.get("c")!;
    docs.set("c", {
      ...current,
      nodes: current.nodes.map((node) =>
        node.id === "agent"
          ? {
              ...node,
              ether: {
                ...(node.ether ?? {}),
                messages: {
                  items: [
                    ...(node.ether?.messages?.items ?? []),
                    userMsg("b-three", "third"),
                  ],
                },
              },
            }
          : node,
      ),
    });
    acceptSecond = true;
    service.onResumedCanvas("c");
    // Budget law: the batch spent the window; the turn the paste started
    // opens the next one for the post-batch message.
    service.onManagedTerminalTurnStart("bind-profile-13");

    await waitUntil(() =>
      store.hasAcceptedMessageDelivery("c", "agent", "b-two"),
    );
    // The accepted batch is never re-pasted. Once its receipts settle, the
    // post-batch message lands on its own line with its own transport.
    await waitUntil(() => payloads.length === 2);
    expect(payloads.filter((text) => text.includes("unread"))).toHaveLength(1);
    expect(payloads[1]).toBe("[message - user] third");
    await waitUntil(() =>
      store.hasAcceptedMessageDelivery("c", "agent", "b-three"),
    );
    expect(payloads).toHaveLength(2);
  });

  it("does not let an individual notify a message already reserved by a batch", async () => {
    const msgs = [userMsg("batch-one", "first"), userMsg("batch-two", "second")];
    const store = makeStore({ c: agentDoc(msgs) });
    const payloads: string[] = [];
    let releaseBatch!: (outcome: ManagedPromptOutcome) => void;
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        wakeManagedSeat: async () => true,
        sendManagedTerminalPrompt: async (_bindingId, text) => {
          payloads.push(text);
          return new Promise<ManagedPromptOutcome>((resolve) => {
            releaseBatch = resolve;
          });
        },
      },
      store,
    });

    service.onBooted();
    await waitUntil(() => payloads.length === 1);

    // A duplicate append arrives while the batch envelope is awaiting its
    // transport result. The batch's per-message reservation must suppress an
    // individual transport request for the same durable message.
    service.notifyAppended("c", "agent", msgs[0]!);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(payloads).toHaveLength(1);

    releaseBatch(submittedOutcome());
    await waitUntil(async () =>
      (await store.hasAcceptedMessageDelivery("c", "agent", "batch-one")) &&
      (await store.hasAcceptedMessageDelivery("c", "agent", "batch-two")),
    );
    expect(payloads).toHaveLength(1);
  });

  it("never delivers own (agent-role) messages", async () => {
    const own = userMsg("own", "status", { role: "agent" });
    const store = makeStore({ c: agentDoc([own]) });
    let sendCount = 0;
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        sendManagedTerminalPrompt: async () => {
          sendCount += 1;
          return submittedOutcome();
        },
      },
      store,
    });
    service.notifyAppended("c", "agent", own);
    await new Promise((r) => setTimeout(r, 30));
    expect(sendCount).toBe(0);
    const doc = await store.readDoc("c", "scan");
    expect(doc?.nodes[0]?.ether?.messages?.items[0]?.metadata?.deliveredAt).toBeUndefined();
  });

  it("agent without managed terminal binding is unreachable (no ACP fallback)", async () => {
    const msg = userMsg("orphan", "hello");
    const store = makeStore({
      c: {
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
              messages: { items: [msg] },
            },
          },
        ],
        edges: [],
      },
    });
    let agentSends = 0;
    let managedSends = 0;
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        sendManagedTerminalPrompt: async () => {
          managedSends += 1;
          return submittedOutcome();
        },
      },
      store,
      now: () => 3,
    });
    service.notifyAppended("c", "agent", msg);
    await new Promise((r) => setTimeout(r, 40));
    expect(agentSends).toBe(0);
    expect(managedSends).toBe(0);
  });

  it("unreachable target leaves pending; attach triggers retry", async () => {
    const msg = userMsg("later", "wake");
    const store = makeStore({ c: terminalDoc([msg]) });
    const payloads: string[] = [];
    let accepts = false;
    const service = new MessageDeliveryService();
    const transport: MessageDeliveryTransport = {
      sendTerminalPaste: (_bindingId, text) => {
        payloads.push(text);
        return accepts;
      },
    };
    service.configure({ transport, store, now: () => 9 });

    service.notifyAppended("c", "terminal", msg);
    await waitUntil(() => payloads.length >= 1);
    expect(payloads.length).toBe(1);
    let doc = await store.readDoc("c", "scan");
    expect(doc?.nodes[0]?.ether?.messages?.items[0]?.metadata?.deliveredAt).toBeUndefined();

    accepts = true;
    service.onTerminalAttached("bind-term");
    await waitUntil(() => store.hasAcceptedMessageDelivery("c", "terminal", msg.messageId));
    expect(payloads.some((p) => p.includes("[message - user] wake"))).toBe(true);
    expect(payloads.at(-1)).not.toContain("\n");
  });

  it("terminal fallback pastes metacharacters without newline or shell submission", async () => {
    const msg = userMsg("safe", "echo owned; $(touch /tmp/nope) && rm -rf ~");
    const base = terminalDoc([msg]);
    const doc: CanvasDoc = {
      ...base,
      nodes: [{
        ...base.nodes[0]!, id: "terminal",
        ether: {
          entity: { kind: "agent", name: "local:claude" },
          terminal: { bindingId: "binding-1", harness: "claude" },
          messages: { items: [msg] },
        },
      }],
    };
    const store = makeStore({ c: doc });
    const pastes: Array<{ text: string; messageId: string }> = [];
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        sendTerminalPaste: (_bindingId, text, messageId) => {
          pastes.push({ text, messageId });
          return true;
        },
      },
      store,
    });
    service.notifyAppended("c", "terminal", msg);
    await waitUntil(() => pastes.length === 1);
    expect(pastes).toEqual([{ text: "[message - user] echo owned; $(touch /tmp/nope) && rm -rf ~", messageId: "safe" }]);
    expect(pastes[0]!.text).not.toContain("\n");
  });

  it("formatting includes role and taskId; metadata.sender spoof ignored", async () => {
    const msg = userMsg("fmt", "do the thing", {
      metadata: { sender: "operator" },
      taskId: "task-42",
    });
    const store = makeStore({ c: agentDoc([msg]) });
    const payloads: string[] = [];
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        sendManagedTerminalPrompt: async (_bindingId, text) => {
          payloads.push(text);
          return submittedOutcome();
        },
      },
      store,
      now: () => 3,
    });
    service.notifyAppended("c", "agent", msg);
    await waitUntil(() => payloads.length >= 1);
    expect(payloads[0]).toBe("[message - user] do the thing - task task-42");
  });

  it("managed terminal prompt uses sendManagedTerminalPrompt when wired", async () => {
    const msg = userMsg("mt", "claim task");
    const base = terminalDoc([msg]);
    const doc: CanvasDoc = {
      ...base,
      nodes: [{
        ...base.nodes[0]!,
        id: "terminal",
        ether: {
          entity: { kind: "agent", name: "local:claude" },
          terminal: { bindingId: "bind-mt", harness: "claude" },
          messages: { items: [msg] },
        },
      }],
    };
    const store = makeStore({ c: doc });
    const prompts: string[] = [];
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        sendTerminalPaste: () => {
          throw new Error("paste path must not run when managed prompt is wired");
        },
        sendManagedTerminalPrompt: async (_bindingId, text) => {
          prompts.push(text);
          return submittedOutcome();
        },
      },
      store,
      now: () => 42,
    });
    service.notifyAppended("c", "terminal", msg);
    await waitUntil(() => prompts.length === 1);
    expect(prompts[0]).toBe("[message - user] claim task");
    await waitUntil(() => store.hasAcceptedMessageDelivery("c", "terminal", msg.messageId));
  });

  it("factory mail never interrupts and always summarizes", async () => {
    const msg = userMsg("mail-steer", "interrupt the turn", {
      metadata: { factoryMail: true },
    });
    const store = makeStore({ c: agentDoc([msg]) });
    const calls: Array<{
      readonly bindingId: string;
      readonly text: string;
      readonly interruptIfBusy: boolean | undefined;
    }> = [];
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        sendManagedTerminalPrompt: async (bindingId, text, options) => {
          calls.push({ bindingId, text, interruptIfBusy: options?.interruptIfBusy });
          return submittedOutcome();
        },
      },
      store,
    });

    service.notifyAppended("c", "agent", msg);
    await waitUntil(() => calls.length === 1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.bindingId).toBe("bind-profile-13");
    // Mail never interrupts a live turn — ordinary or factory.
    expect(calls[0]?.interruptIfBusy).toBeUndefined();
    // Factory mail always summarizes — full body never rides the PTY.
    expect(calls[0]?.text).toContain("mail-steer");
    expect(calls[0]?.text).toContain("msg read");
    expect(calls[0]?.text).not.toBe("[message - user] interrupt the turn");
    await waitUntil(() =>
      store.hasAcceptedMessageDelivery("c", "agent", msg.messageId),
    );
    const afterFactory = await store.readDoc("c", "scan");
    const factoryLive = afterFactory?.nodes[0]?.ether?.messages?.items[0];
    expect(factoryLive?.metadata?.readAt).toBeUndefined();
  });

  it("notifies unread mail once and leaves it unread", async () => {
    const msg = userMsg("read-retry", "stamp later");
    const store = makeStore({ c: agentDoc([msg]) }, { now: () => 7 });
    let sendCount = 0;
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        sendManagedTerminalPrompt: async () => {
          sendCount += 1;
          return submittedOutcome();
        },
      },
      store,
      now: () => 7,
    });

    service.notifyAppended("c", "agent", msg);
    await waitUntil(() => store.hasAcceptedMessageDelivery("c", "agent", "read-retry"));
    expect(sendCount).toBe(1);
    const afterFirst = (await store.readDoc("c", "scan"))?.nodes[0]?.ether?.messages?.items[0];
    expect(afterFirst?.metadata?.deliveredAt).toBe(7);
    expect(afterFirst?.metadata?.readAt).toBeUndefined();

    service.onManagedTerminalIdle("bind-profile-13");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sendCount).toBe(1);
    expect(
      (await store.readDoc("c", "scan"))?.nodes[0]?.ether?.messages?.items[0]?.metadata?.readAt,
    ).toBeUndefined();
  });

  it("does not stamp read after a PTY notify", async () => {
    const short = userMsg("short-1", "claim task");
    const store = makeStore({ c: agentDoc([short]) }, { now: () => 99 });
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        sendManagedTerminalPrompt: async () => submittedOutcome(),
      },
      store,
      now: () => 99,
    });
    service.notifyAppended("c", "agent", short);
    await waitUntil(() => store.hasAcceptedMessageDelivery("c", "agent", "short-1"));
    const after = await store.readDoc("c", "scan");
    expect(after?.nodes[0]?.ether?.messages?.items[0]?.metadata?.readAt).toBeUndefined();
  });

  it("does not inject mail the seat already listed", async () => {
    const listed = userMsg("listed-1", "already seen", {
      metadata: { readAt: 50 },
    });
    const store = makeStore({ c: agentDoc([listed]) }, { now: () => 99 });
    let sends = 0;
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        sendManagedTerminalPrompt: async () => {
          sends += 1;
          return submittedOutcome();
        },
      },
      store,
      now: () => 99,
    });
    service.notifyAppended("c", "agent", listed);
    service.onManagedTerminalIdle("bind-profile-13");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(sends).toBe(0);
    expect(await store.hasAcceptedMessageDelivery("c", "agent", "listed-1")).toBe(
      false,
    );
  });

  it("does not steer system mailbox notices", async () => {
    const msg = userMsg("mail-notice", "link enabled", {
      metadata: { msgSendEnabled: true, factoryLink: true },
    });
    const store = makeStore({ c: agentDoc([msg]) });
    let called = false;
    let options: { readonly interruptIfBusy?: boolean } | undefined;
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        sendManagedTerminalPrompt: async (_bindingId, _text, next) => {
          called = true;
          options = next;
          return submittedOutcome();
        },
      },
      store,
    });

    service.notifyAppended("c", "agent", msg);
    await waitUntil(() => called);
    expect(options).toBeUndefined();
  });

  it("managed terminal idle gate leave pending until onManagedTerminalIdle", async () => {
    const msg = userMsg("idle-gate", "wait");
    const base = terminalDoc([msg]);
    const doc: CanvasDoc = {
      ...base,
      nodes: [{
        ...base.nodes[0]!,
        id: "terminal",
        ether: {
          entity: { kind: "agent", name: "local:claude" },
          terminal: { bindingId: "bind-idle", harness: "claude" },
          messages: { items: [msg] },
        },
      }],
    };
    const store = makeStore({ c: doc });
    let accept = false;
    const prompts: string[] = [];
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        sendManagedTerminalPrompt: async (_bindingId, text) => {
          if (!accept) return refusedOutcome();
          prompts.push(text);
          return submittedOutcome();
        },
      },
      store,
      now: () => 7,
    });
    service.notifyAppended("c", "terminal", msg);
    await new Promise((r) => setTimeout(r, 30));
    expect(prompts).toEqual([]);
    expect(
      (await store.readDoc("c", "scan"))?.nodes[0]?.ether?.messages?.items[0]?.metadata?.deliveredAt,
    ).toBeUndefined();

    accept = true;
    service.onManagedTerminalIdle("bind-idle");
    await waitUntil(() => prompts.length === 1);
    expect(prompts[0]).toContain("wait");
    await waitUntil(() =>
      store.hasAcceptedMessageDelivery("c", "terminal", "idle-gate"),
    );
  });

  it("transport accept + receipt fail never re-sends on idle", async () => {
    const msg = userMsg("dup", "once only");
    let acceptOk = false;
    const store = makeStore(
      { c: agentDoc([msg]) },
      { acceptOk: () => acceptOk, now: () => 5 },
    );
    let sendCount = 0;
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        sendManagedTerminalPrompt: async () => {
          sendCount += 1;
          return submittedOutcome();
        },
      },
      store,
      now: () => 5,
    });
    service.notifyAppended("c", "agent", msg);
    await waitUntil(() => sendCount === 1);
    expect(await store.hasAcceptedMessageDelivery("c", "agent", "dup")).toBe(false);

    // Idle re-drive: receipt only, no second transport hit
    acceptOk = true;
    service.onManagedTerminalIdle("bind-profile-13");
    await waitUntil(() => store.hasAcceptedMessageDelivery("c", "agent", "dup"));
    expect(sendCount).toBe(1);
  });

  it("suspension prevents append, attach, idle, resume, and reconfiguration delivery", async () => {
    const msg = userMsg("revoked", "do not send");
    const store = makeStore({ c: agentDoc([msg]) });
    let sendCount = 0;
    const transport: MessageDeliveryTransport = {
      sendManagedTerminalPrompt: async () => {
        sendCount += 1;
        return submittedOutcome();
      },
    };
    const service = new MessageDeliveryService();
    service.configure({ transport, store });

    service.suspend();
    service.suspend();
    service.configure({ transport, store });
    service.notifyAppended("c", "agent", msg);
    service.onTerminalAttached("bind-profile-13");
    service.onManagedTerminalIdle("bind-profile-13");
    service.onResumedCanvas("c");

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sendCount).toBe(0);
    expect(
      (await store.readDoc("c", "scan"))?.nodes[0]?.ether?.messages?.items[0]
        ?.metadata?.deliveredAt,
    ).toBeUndefined();
  });

  it("a scan suspended across an async store read never reaches transport", async () => {
    const msg = userMsg("read-race", "do not race");
    const underlying = makeStore({ c: agentDoc([msg]) });
    let releaseNames!: (
      names: ReadonlyArray<string>,
    ) => void;
    const names = new Promise<ReadonlyArray<string>>((resolve) => {
      releaseNames = resolve;
    });
    let scanStarted = false;
    let sendCount = 0;
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        sendManagedTerminalPrompt: async () => {
          sendCount += 1;
          return submittedOutcome();
        },
      },
      store: {
        ...underlying,
        listCanvasNames: async () => {
          scanStarted = true;
          return names;
        },
      },
    });

    service.onManagedTerminalIdle("bind-profile-13");
    await waitUntil(() => scanStarted);
    service.suspend();
    releaseNames(["c"]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(sendCount).toBe(0);
  });

  it("a refused wake arms a deferred retry that delivers when the seat wakes", async () => {
    const msg = userMsg("wake-retry", "hello again");
    const store = makeStore({ c: agentDoc([msg]) });
    const scheduled: Array<{ readonly fn: () => void; readonly ms: number }> = [];
    let wakeSucceeds = false;
    let sends = 0;
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        wakeManagedSeat: async () => wakeSucceeds,
        sendManagedTerminalPrompt: async () => {
          sends += 1;
          return submittedOutcome();
        },
      },
      store,
      timers: {
        set: (fn, ms) => {
          scheduled.push({ fn, ms });
          return scheduled.length - 1;
        },
        clear: () => undefined,
      },
    });

    service.notifyAppended("c", "agent", msg);
    await waitUntil(() => scheduled.length === 1);
    expect(sends).toBe(0);

    // Seat becomes wakeable; the deferred attempt delivers and stops the chain.
    wakeSucceeds = true;
    scheduled[0]!.fn();
    await waitUntil(() => sends === 1);
    await waitUntil(() =>
      store.hasAcceptedMessageDelivery("c", "agent", msg.messageId),
    );
    expect(scheduled.length).toBe(1);
  });

  it("deferred wake retries are bounded and double their delay", async () => {
    const msg = userMsg("wake-retry-cap", "still cold");
    const store = makeStore({ c: agentDoc([msg]) });
    const scheduled: Array<{ readonly fn: () => void; readonly ms: number }> = [];
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        wakeManagedSeat: async () => false,
        sendManagedTerminalPrompt: async () => submittedOutcome(),
      },
      store,
      timers: {
        set: (fn, ms) => {
          scheduled.push({ fn, ms });
          return scheduled.length - 1;
        },
        clear: () => undefined,
      },
    });

    service.notifyAppended("c", "agent", msg);
    await waitUntil(() => scheduled.length === 1);
    // Drain the chain: each fired retry re-attempts, wake keeps refusing.
    for (let i = 0; i < 8 && i < scheduled.length; i++) {
      scheduled[i]!.fn();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(scheduled.length).toBe(5);
    expect(scheduled.map((s) => s.ms)).toEqual([
      45_000, 90_000, 180_000, 360_000, 720_000,
    ]);
  });

  it("onBooted delivers the durable backlog with no other trigger", async () => {
    const msg = userMsg("boot-backlog", "sent before restart");
    const store = makeStore({ c: agentDoc([msg]) });
    let sends = 0;
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        wakeManagedSeat: async () => true,
        sendManagedTerminalPrompt: async () => {
          sends += 1;
          return submittedOutcome();
        },
      },
      store,
    });

    service.onBooted();
    await waitUntil(() => sends === 1);
    await waitUntil(() =>
      store.hasAcceptedMessageDelivery("c", "agent", msg.messageId),
    );
  });

  it("batches multiple pending into one PTY notify on scan", async () => {
    const msgs = [
      userMsg("b1", "first"),
      userMsg("b2", "second", { metadata: { factoryMail: true } }),
      userMsg("b3", "third"),
    ];
    const store = makeStore({ c: agentDoc(msgs) });
    const payloads: string[] = [];
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        wakeManagedSeat: async () => true,
        sendManagedTerminalPrompt: async (_id, text) => {
          payloads.push(text);
          return submittedOutcome();
        },
      },
      store,
    });

    service.onBooted();
    await waitUntil(() => payloads.length === 1);
    expect(payloads[0]).toContain("3 unread");
    expect(payloads[0]).toContain("b1");
    expect(payloads[0]).toContain("vellum-command msg list");
    await waitUntil(async () =>
      (await store.hasAcceptedMessageDelivery("c", "agent", "b1")) &&
      (await store.hasAcceptedMessageDelivery("c", "agent", "b2")) &&
      (await store.hasAcceptedMessageDelivery("c", "agent", "b3")),
    );
    const batched = (await store.readDoc("c", "scan"))?.nodes[0]?.ether?.messages?.items ?? [];
    expect(batched.map((m) => m.metadata?.readAt)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
  });

  it("pastes a burst list newest-first and a lone unread as that latest", async () => {
    const t0 = 1_700_000_000_000;
    const older = ulid(t0);
    const newer = ulid(t0 + 2_000);
    const newest = ulid(t0 + 4_000);
    const store = makeStore({
      c: agentDoc([
        userMsg(older, "old ping"),
        userMsg(newer, "mid ping"),
        userMsg(newest, "new ping"),
      ]),
    });
    const payloads: string[] = [];
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        wakeManagedSeat: async () => true,
        sendManagedTerminalPrompt: async (_id, text) => {
          payloads.push(text);
          return submittedOutcome();
        },
      },
      store,
    });
    service.onBooted();
    await waitUntil(() => payloads.length === 1);
    expect(payloads[0]).toContain("3 unread");
    expect(payloads[0]!.indexOf(newest.slice(0, 12))).toBeLessThan(
      payloads[0]!.indexOf(older.slice(0, 12)),
    );

    const lone = makeStore({
      c: agentDoc([userMsg(newest, "solo latest")]),
    });
    const singles: string[] = [];
    const one = new MessageDeliveryService();
    one.configure({
      transport: {
        wakeManagedSeat: async () => true,
        sendManagedTerminalPrompt: async (_id, text) => {
          singles.push(text);
          return submittedOutcome();
        },
      },
      store: lone,
    });
    one.onBooted();
    await waitUntil(() => singles.length === 1);
    expect(singles[0]).toBe("[message - user] solo latest");
  });

  it("operator-draft gate holds mail without burning a transport attempt", async () => {
    const msg = userMsg("draft-block", "should wait");
    const store = makeStore({ c: agentDoc([msg]) });
    let sends = 0;
    let now = 1_000;
    const service = new MessageDeliveryService();
    let operatorDraft = false;
    const scheduled: Array<{ readonly fn: () => void; readonly ms: number }> = [];
    service.configure({
      now: () => now,
      timers: {
        set: (fn, ms) => {
          scheduled.push({ fn, ms });
          return scheduled.length - 1;
        },
        clear: () => undefined,
      },
      transport: {
        wakeManagedSeat: async () => true,
        seatDeliverySnapshot: () => ({
          idle: true,
          generationKey: "ep1",
          operatorDraft,
        }),
        sendManagedTerminalPrompt: async () => {
          sends += 1;
          return submittedOutcome();
        },
      },
      store,
    });

    // First consult arms settle (not-settled) + timer.
    service.notifyAppended("c", "agent", msg);
    await new Promise((r) => setTimeout(r, 30));
    expect(sends).toBe(0);
    expect(scheduled.length).toBe(1);

    // Past settle, but operator is drafting — still no paste.
    now = 1_000 + 2_000;
    operatorDraft = true;
    scheduled[0]!.fn();
    await new Promise((r) => setTimeout(r, 30));
    expect(sends).toBe(0);
    expect(await store.hasAcceptedMessageDelivery("c", "agent", "draft-block")).toBe(
      false,
    );
    expect(scheduled.length).toBeGreaterThanOrEqual(2);

    // Operator cleared the box — gate retry delivers without a fake idle event.
    operatorDraft = false;
    scheduled[scheduled.length - 1]!.fn();
    await waitUntil(() => sends === 1);
    await waitUntil(() =>
      store.hasAcceptedMessageDelivery("c", "agent", "draft-block"),
    );
  });

  it("not-settled gate retries via timer without a further idle event", async () => {
    const msg = userMsg("settle", "after quiet");
    const store = makeStore({ c: agentDoc([msg]) });
    let sends = 0;
    let now = 1000;
    const scheduled: Array<{ readonly fn: () => void; readonly ms: number }> = [];
    const service = new MessageDeliveryService();
    service.configure({
      now: () => now,
      timers: {
        set: (fn, ms) => {
          scheduled.push({ fn, ms });
          return scheduled.length - 1;
        },
        clear: () => undefined,
      },
      transport: {
        wakeManagedSeat: async () => true,
        seatDeliverySnapshot: () => ({
          idle: true,
          generationKey: "ep-settle",
          operatorDraft: false,
        }),
        sendManagedTerminalPrompt: async () => {
          sends += 1;
          return submittedOutcome();
        },
      },
      store,
    });

    service.notifyAppended("c", "agent", msg);
    await new Promise((r) => setTimeout(r, 30));
    // First consult sets idleSince and arms settle timer — no send yet.
    expect(sends).toBe(0);
    expect(scheduled.length).toBe(1);
    expect(scheduled[0]!.ms).toBeGreaterThanOrEqual(1_500);

    // Advance clock past settle and fire the timer (no second idle event).
    now = 1000 + 1_600;
    scheduled[0]!.fn();
    await waitUntil(() => sends === 1);
  });

  it("batch receipt-stamp failure does not re-paste on later scans", async () => {
    const msgs = [userMsg("b1", "first"), userMsg("b2", "second")];
    let acceptOk = false;
    const store = makeStore(
      { c: agentDoc(msgs) },
      { acceptOk: () => acceptOk },
    );
    let sends = 0;
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        wakeManagedSeat: async () => true,
        sendManagedTerminalPrompt: async () => {
          sends += 1;
          return submittedOutcome();
        },
      },
      store,
    });

    service.onBooted();
    await waitUntil(() => sends === 1);
    // Stamp fails — message stays pending.
    expect(await store.hasAcceptedMessageDelivery("c", "agent", "b1")).toBe(false);

    // Further scans must NOT re-paste (transportAccepted).
    service.onBooted();
    service.onManagedTerminalIdle("bind-profile-13");
    await new Promise((r) => setTimeout(r, 40));
    expect(sends).toBe(1);

    acceptOk = true;
    service.onManagedTerminalIdle("bind-profile-13");
    await waitUntil(async () =>
      (await store.hasAcceptedMessageDelivery("c", "agent", "b1")) &&
      (await store.hasAcceptedMessageDelivery("c", "agent", "b2")),
    );
    expect(sends).toBe(1);
  });

  it("batch receipt recovery only stamps messages in the accepted payload", async () => {
    const msgs = [userMsg("b1", "first"), userMsg("b2", "second")];
    let docs!: Map<string, CanvasDoc>;
    let acceptOk = false;
    const store = makeStore(
      { c: agentDoc(msgs) },
      {
        acceptOk: () => acceptOk,
        onDocs: (current) => {
          docs = current;
        },
      },
    );
    const sends: string[] = [];
    let releaseThird: ((outcome: ManagedPromptOutcome) => void) | undefined;
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        wakeManagedSeat: async () => true,
        sendManagedTerminalPrompt: async (_bindingId, text) => {
          sends.push(text);
          if (text === "[message - user] third") {
            return new Promise<ManagedPromptOutcome>((resolve) => {
              releaseThird = resolve;
            });
          }
          return submittedOutcome();
        },
      },
      store,
    });

    // The transport accepts the A/B batch, but durable receipt stamping fails.
    service.onBooted();
    await waitUntil(() => sends.length === 1);
    expect(sends[0]).toContain("2 unread");
    expect(await store.hasAcceptedMessageDelivery("c", "agent", "b1")).toBe(false);
    expect(await store.hasAcceptedMessageDelivery("c", "agent", "b2")).toBe(false);

    // C arrives through durable projection after the accepted batch, without a
    // local notifyAppended event.
    const current = docs.get("c")!;
    docs.set("c", {
      ...current,
      nodes: current.nodes.map((node) =>
        node.id === "agent"
          ? {
              ...node,
              ether: {
                ...(node.ether ?? {}),
                messages: {
                  items: [
                    ...(node.ether?.messages?.items ?? []),
                    userMsg("b3", "third"),
                  ],
                },
              },
            }
          : node,
      ),
    });

    acceptOk = true;
    service.onResumedCanvas("c");
    // Budget law: the batch spent the window; the turn the paste started
    // opens the next one for the post-batch message.
    service.onManagedTerminalTurnStart("bind-profile-13");
    await waitUntil(async () =>
      (await store.hasAcceptedMessageDelivery("c", "agent", "b1")) &&
      (await store.hasAcceptedMessageDelivery("c", "agent", "b2")),
    );

    // Recovery stamps only the accepted members. The post-batch message is
    // never receipted by recovery: it lands on its own line, and its receipt
    // waits for its own transport result.
    await waitUntil(() => sends.length === 2);
    expect(sends[1]).toBe("[message - user] third");
    await waitUntil(() => releaseThird !== undefined);
    expect(await store.hasAcceptedMessageDelivery("c", "agent", "b3")).toBe(false);
    releaseThird!(submittedOutcome());
    await waitUntil(() =>
      store.hasAcceptedMessageDelivery("c", "agent", "b3"),
    );
    expect(sends).toHaveLength(2);
  });

  it("request-response respects the seat delivery gate", async () => {
    const store = makeStore({ c: agentDoc([]) });
    let sends = 0;
    let operatorDraft = true;
    let now = 5_000;
    const scheduled: Array<{ readonly fn: () => void }> = [];
    const service = new MessageDeliveryService();
    service.configure({
      now: () => now,
      timers: {
        set: (fn) => {
          scheduled.push({ fn });
          return scheduled.length - 1;
        },
        clear: () => undefined,
      },
      transport: {
        wakeManagedSeat: async () => true,
        seatDeliverySnapshot: () => ({
          idle: true,
          generationKey: "ep-req",
          operatorDraft,
        }),
        sendManagedTerminalPrompt: async () => {
          sends += 1;
          return submittedOutcome();
        },
      },
      store,
    });

    service.notifyRequestResolved({
      canvas: "c",
      actorNodeId: "agent",
      requestId: "req-1",
      response: "short ok",
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(sends).toBe(0);

    operatorDraft = false;
    now += 3_000;
    // Fire gate retry.
    if (scheduled.length > 0) scheduled[scheduled.length - 1]!.fn();
    await waitUntil(() => sends === 1);
  });

  // ── Routing reads never build the work projection ────────────────────────
  //
  // The retry loop that pinned the main thread paid for the entire factory —
  // every sink's tasks, messages, requests, artifacts, board and pad — to run
  // one `nodes.find(id)`. These pin the cost shape, not just the outcome.

  const countingStore = (
    inner: MessageDeliveryStore,
  ): {
    readonly store: MessageDeliveryStore;
    readonly counts: { docReads: number; nodeReads: number; canvasLists: number };
  } => {
    const counts = { docReads: 0, nodeReads: 0, canvasLists: 0 };
    return {
      counts,
      store: {
        ...inner,
        listCanvasNames: async () => {
          counts.canvasLists += 1;
          return inner.listCanvasNames();
        },
        readDoc: async (canvas, site) => {
          counts.docReads += 1;
          return inner.readDoc(canvas, site);
        },
        readNodeStructure: async (canvas, nodeId) => {
          counts.nodeReads += 1;
          return inner.readNodeStructure(canvas, nodeId);
        },
      },
    };
  };

  const twoAgentDoc = (): CanvasDoc => ({
    nodes: [
      ...agentDoc([]).nodes,
      {
        id: "agent-2",
        type: "text",
        text: "nova",
        x: 200,
        y: 0,
        width: 100,
        height: 80,
        ether: {
          entity: { kind: "agent", name: "local:nova" },
          terminal: { bindingId: "bind-nova", harness: "claude" },
        },
      },
    ],
    edges: [],
  });

  it("request-response routing never reads the work projection", async () => {
    const { store, counts } = countingStore(makeStore({ c: agentDoc([]) }));
    const writes: string[] = [];
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        sendManagedTerminalPrompt: async (_bindingId, text) => {
          writes.push(text);
          return submittedOutcome();
        },
      },
      store,
    });

    service.notifyRequestResolved({
      canvas: "c",
      actorNodeId: "agent",
      requestId: "req-cheap",
      response: "ok",
    });

    await waitUntil(() => writes.length === 1);
    expect(counts.nodeReads).toBeGreaterThan(0);
    // Zero full-document reads: routing asks structural questions only.
    expect(counts.docReads).toBe(0);
  });

  it("one binding-filter lookup per distinct target per pass, not per pending", async () => {
    const { store, counts } = countingStore(makeStore({ c: twoAgentDoc() }));
    let sends = 0;
    const service = new MessageDeliveryService();
    // Refuse the transport so every response stays queued across passes.
    service.configure({
      transport: {
        sendManagedTerminalPrompt: async () => {
          sends += 1;
          return refusedOutcome();
        },
      },
      store,
    });

    // Four queued answers across two seats.
    for (const [index, nodeId] of [
      "agent",
      "agent",
      "agent-2",
      "agent-2",
    ].entries()) {
      service.notifyRequestResolved({
        canvas: "c",
        actorNodeId: nodeId,
        requestId: `req-${String(index)}`,
        response: "answer",
      });
    }
    // Let the direct attempts finish — an attempt still in flight is deduped
    // by `inFlight`, which would hide the per-pass cost this test measures.
    await waitUntil(() => sends === 4);
    await new Promise((r) => setTimeout(r, 20));

    const before = counts.nodeReads;
    // One narrowed pass. The filter resolves each distinct (canvas, node) once
    // — two lookups — then the two matching entries each re-resolve fresh
    // immediately before their own wake. Four, never one per pending item
    // times the two it would have been.
    service.onTerminalAttached("bind-profile-13");
    await waitUntil(() => counts.nodeReads > before);
    await new Promise((r) => setTimeout(r, 30));
    expect(counts.nodeReads - before).toBe(4);
    // The only full read in the pass is the mail scan, which genuinely needs
    // `ether.messages`. It is one per canvas — never one per queued response.
    expect(counts.docReads).toBe(1);
  });

  it("a node that vanishes after the filter never mints a wake", async () => {
    const docs = { c: twoAgentDoc() };
    const inner = makeStore(docs);
    let removeAfterFilter = false;
    let filterPasses = 0;
    const wakes: Array<string> = [];
    const store: MessageDeliveryStore = {
      ...inner,
      readNodeStructure: async (canvas, nodeId) => {
        const found = await inner.readNodeStructure(canvas, nodeId);
        if (!removeAfterFilter) return found;
        filterPasses += 1;
        // First call in the pass is the filter; every later call is the
        // fresh pre-wake read, and by then the node is gone.
        return filterPasses === 1 ? found : undefined;
      },
    };
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        wakeManagedSeat: async (_canvas, nodeId) => {
          wakes.push(nodeId);
          return true;
        },
        sendManagedTerminalPrompt: async () => refusedOutcome(),
      },
      store,
    });

    service.notifyRequestResolved({
      canvas: "c",
      actorNodeId: "agent",
      requestId: "req-gone",
      response: "answer",
    });
    await waitUntil(() => wakes.length === 1);

    removeAfterFilter = true;
    const wakesBefore = wakes.length;
    service.onTerminalAttached("bind-profile-13");
    await new Promise((r) => setTimeout(r, 40));
    // The filter matched on the stale view; the fresh pre-wake read refused.
    expect(filterPasses).toBeGreaterThanOrEqual(2);
    expect(wakes.length).toBe(wakesBefore);
  });

  // ── Gate retry backoff ───────────────────────────────────────────────────

  it("repeated poll refusals back off and cap; a real state change resets", async () => {
    const msg = userMsg("backoff", "hold");
    const store = makeStore({ c: agentDoc([msg]) });
    const scheduled: Array<{ readonly fn: () => void; readonly ms: number }> = [];
    const service = new MessageDeliveryService();
    service.configure({
      // Mid-jitter so the delay is the backed-off value exactly.
      random: () => 0.5,
      timers: {
        set: (fn, ms) => {
          scheduled.push({ fn, ms });
          return scheduled.length - 1;
        },
        clear: () => undefined,
      },
      transport: {
        wakeManagedSeat: async () => true,
        // Busy forever — the poll condition never clears on its own.
        seatDeliverySnapshot: () => ({
          idle: false,
          generationKey: "ep-busy",
          operatorDraft: false,
        }),
        sendManagedTerminalPrompt: async () => submittedOutcome(),
      },
      store,
    });

    service.notifyAppended("c", "agent", msg);
    await waitUntil(() => scheduled.length === 1);
    expect(scheduled[0]!.ms).toBe(1_500);

    // Each fired retry re-refuses and arms the next, doubling to the ceiling.
    const seen: number[] = [scheduled[0]!.ms];
    for (let i = 0; i < 6; i += 1) {
      const next = scheduled[scheduled.length - 1]!;
      next.fn();
      await waitUntil(() => scheduled.length === seen.length + 1);
      seen.push(scheduled[scheduled.length - 1]!.ms);
    }
    expect(seen).toEqual([1_500, 3_000, 6_000, 12_000, 12_000, 12_000, 12_000]);

    // A seat transition is a real state change — the next poll starts over.
    // (The idle re-drive finds a timer already armed, so it changes nothing
    // but the streak; firing that timer is what arms the next one.)
    service.onManagedTerminalIdle("bind-profile-13");
    await new Promise((r) => setTimeout(r, 20));
    scheduled[scheduled.length - 1]!.fn();
    await waitUntil(() => scheduled.length === seen.length + 1);
    expect(scheduled[scheduled.length - 1]!.ms).toBe(1_500);
  });

  it("jitter spreads simultaneous poll retries off one tick", async () => {
    const msg = userMsg("jitter", "hold");
    const store = makeStore({ c: agentDoc([msg]) });
    const armed: number[] = [];
    const draws = [0, 1];
    let draw = 0;
    const service = new MessageDeliveryService();
    service.configure({
      random: () => draws[draw++ % draws.length]!,
      timers: {
        set: (_fn, ms) => {
          armed.push(ms);
          return armed.length - 1;
        },
        clear: () => undefined,
      },
      transport: {
        wakeManagedSeat: async () => true,
        seatDeliverySnapshot: () => ({
          idle: false,
          generationKey: "ep-jitter",
          operatorDraft: false,
        }),
        sendManagedTerminalPrompt: async () => submittedOutcome(),
      },
      store,
    });

    service.notifyAppended("c", "agent", msg);
    await waitUntil(() => armed.length === 1);
    // 20% symmetric spread around the base: floor at random() = 0.
    expect(armed[0]).toBe(1_200);
  });

  it("the settle deadline never backs off, only spreads forward", async () => {
    const msg = userMsg("settle-2", "quiet");
    const store = makeStore({ c: agentDoc([msg]) });
    const armed: number[] = [];
    let now = 5_000;
    const service = new MessageDeliveryService();
    service.configure({
      now: () => now,
      random: () => 1,
      timers: {
        set: (_fn, ms) => {
          armed.push(ms);
          return armed.length - 1;
        },
        clear: () => undefined,
      },
      transport: {
        wakeManagedSeat: async () => true,
        seatDeliverySnapshot: () => ({
          idle: true,
          generationKey: "ep-settle-2",
          operatorDraft: false,
        }),
        sendManagedTerminalPrompt: async () => submittedOutcome(),
      },
      store,
    });

    service.notifyAppended("c", "agent", msg);
    await waitUntil(() => armed.length === 1);
    // The settle point is a known instant: fire at it, spread only forward.
    expect(armed[0]).toBeGreaterThanOrEqual(1_500);
    expect(armed[0]).toBeLessThanOrEqual(1_500 + 10 + 150);
  });

  // ── One seat transition costs the delta, not the world ───────────────────
  //
  // A transition used to list every canvas, read every document and walk every
  // node to answer "is there mail for THIS binding?" — then discard all but
  // one binding's worth. The pending index answers that from memory. The world
  // read stays as a bounded reconcile floor, never a per-transition tax.

  const seatNode = (index: number): CanvasNode => ({
    id: `seat-${String(index)}`,
    type: "text",
    text: `seat ${String(index)}`,
    x: index * 10,
    y: 0,
    width: 100,
    height: 80,
    ether: {
      entity: { kind: "agent", name: `local:seat-${String(index)}` },
      terminal: { bindingId: `bind-${String(index)}`, harness: "claude" },
    },
  });

  const noteNode = (index: number): CanvasNode => ({
    id: `note-${String(index)}`,
    type: "text",
    text: `note ${String(index)}`,
    x: index * 10,
    y: 200,
    width: 100,
    height: 80,
  });

  /** The operator's board shape: 96 nodes, half of them carrying a seat. */
  const fleetDoc = (seats: number, notes: number): CanvasDoc => ({
    nodes: [
      ...Array.from({ length: seats }, (_, i) => seatNode(i)),
      ...Array.from({ length: notes }, (_, i) => noteNode(i)),
    ],
    edges: [],
  });

  const settle = () => new Promise((r) => setTimeout(r, 30));

  it("a warm seat transition reads nothing when that seat holds no mail", async () => {
    const { store, counts } = countingStore(makeStore({ c: fleetDoc(48, 48) }));
    const service = new MessageDeliveryService();
    service.configure({
      transport: { sendManagedTerminalPrompt: async () => submittedOutcome() },
      store,
    });

    // Cold index: the first pass reconciles against the world and seeds.
    service.onBooted();
    await waitUntil(() => counts.canvasLists === 1);
    await settle();
    const warm = { ...counts };
    expect(warm.docReads).toBe(1);

    for (let i = 0; i < 50; i += 1) {
      service.onManagedTerminalIdle(`bind-${String(i % 48)}`);
    }
    await settle();

    // Fifty transitions, zero reads: nothing is queued, so there is no delta.
    expect(counts.canvasLists - warm.canvasLists).toBe(0);
    expect(counts.docReads - warm.docReads).toBe(0);
    expect(counts.nodeReads - warm.nodeReads).toBe(0);
  });

  it("a warm transition pays one routing lookup per seat holding mail", async () => {
    const doc = fleetDoc(48, 48);
    const held = doc.nodes.slice(0, 3);
    const withMail: CanvasDoc = {
      ...doc,
      nodes: doc.nodes.map((node, index) =>
        index < 3
          ? {
              ...node,
              ether: {
                ...(node.ether ?? {}),
                messages: { items: [userMsg(`held-${String(index)}`, "wait")] },
              },
            }
          : node,
      ),
    };
    const { store, counts } = countingStore(makeStore({ c: withMail }));
    const service = new MessageDeliveryService();
    service.configure({
      transport: { sendManagedTerminalPrompt: async () => submittedOutcome() },
      // Paused seats keep their mail pending without burning attempts.
      seatPaused: () => true,
      store,
    });

    service.onBooted();
    await waitUntil(() => counts.canvasLists === 1);
    await settle();
    const warm = { ...counts };

    // A seat with nothing queued: three routing lookups (one per seat that
    // does hold mail), and not a single document read.
    service.onManagedTerminalIdle("bind-40");
    await settle();
    expect(counts.nodeReads - warm.nodeReads).toBe(held.length);
    expect(counts.docReads - warm.docReads).toBe(0);
    expect(counts.canvasLists - warm.canvasLists).toBe(0);

    // The seat that does hold mail reads exactly its own document.
    const before = { ...counts };
    service.onManagedTerminalIdle("bind-0");
    await settle();
    expect(counts.nodeReads - before.nodeReads).toBe(held.length);
    expect(counts.docReads - before.docReads).toBe(1);
  });

  it("a delivered message leaves the index and stops costing lookups", async () => {
    const msg = userMsg("delivered-once", "hi");
    let docs!: Map<string, CanvasDoc>;
    const { store, counts } = countingStore(
      makeStore({ c: agentDoc([]) }, { onDocs: (map) => { docs = map; } }),
    );
    let sends = 0;
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        sendManagedTerminalPrompt: async () => {
          sends += 1;
          return submittedOutcome();
        },
      },
      store,
    });

    service.onBooted();
    await waitUntil(() => counts.canvasLists === 1);
    await settle();

    // Durable row first, then the announcement — the real append order.
    docs.set("c", agentDoc([msg]));
    service.notifyAppended("c", "agent", msg);
    await waitUntil(() => sends === 1);
    await waitUntil(() => store.hasAcceptedMessageDelivery("c", "agent", msg.messageId));
    await settle();

    const after = { ...counts };
    service.onManagedTerminalIdle("bind-profile-13");
    await settle();
    // The receipt landed, so the index holds nothing — no routing lookup, and
    // certainly no second paste.
    expect(counts.nodeReads - after.nodeReads).toBe(0);
    expect(counts.docReads - after.docReads).toBe(0);
    expect(sends).toBe(1);
  });

  it("mail held by a paused seat stays indexed and lands on resume", async () => {
    const msg = userMsg("paused-hold", "later");
    const store = makeStore({ c: agentDoc([msg]) });
    let paused = true;
    let sends = 0;
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        wakeManagedSeat: async () => true,
        sendManagedTerminalPrompt: async () => {
          sends += 1;
          return submittedOutcome();
        },
      },
      seatPaused: () => paused,
      store,
    });

    service.onBooted();
    await settle();
    expect(sends).toBe(0);

    // Two more transitions while paused must not evict the queued message.
    service.onManagedTerminalIdle("bind-profile-13");
    service.onManagedTerminalIdle("bind-profile-13");
    await settle();
    expect(sends).toBe(0);

    paused = false;
    service.onManagedTerminalIdle("bind-profile-13");
    await waitUntil(() => sends === 1);
  });

  it("durable mail that never announced itself still lands at the reconcile floor", async () => {
    // Station fact ingress writes the inbox row through the repository, so no
    // `notifyAppended` ever fires. The floor is what finds it — bounded
    // lateness, never a lost message.
    let docs!: Map<string, CanvasDoc>;
    const store = makeStore(
      { c: agentDoc([]) },
      { onDocs: (map) => { docs = map; } },
    );
    let now = 1_000_000;
    const writes: string[] = [];
    const service = new MessageDeliveryService();
    service.configure({
      now: () => now,
      transport: {
        sendManagedTerminalPrompt: async (_bindingId, text) => {
          writes.push(text);
          return submittedOutcome();
        },
      },
      store,
    });

    service.onBooted();
    await settle();

    docs.set("c", agentDoc([userMsg("ingress-1", "from the wire")]));
    service.onManagedTerminalIdle("bind-profile-13");
    await settle();

    now += MESSAGE_DELIVERY_INDEX_RECONCILE_MS;
    service.onManagedTerminalIdle("bind-profile-13");
    await waitUntil(() => writes.length === 1);
    expect(writes[0]).toBe("[message - user] from the wire");
  });

  it("an unfiltered pass still sweeps every canvas", async () => {
    const store = makeStore({
      a: agentDoc([userMsg("multi-a", "canvas a")]),
      b: terminalDoc([userMsg("multi-b", "canvas b")]),
    });
    const writes: Array<{ bindingId: string; text: string }> = [];
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        sendManagedTerminalPrompt: async (bindingId, text) => {
          writes.push({ bindingId, text });
          return submittedOutcome();
        },
      },
      store,
    });

    service.onBooted();
    await waitUntil(() => writes.length === 2);
    expect(writes.map((w) => w.bindingId).sort()).toEqual([
      "bind-profile-13",
      "bind-term",
    ]);
  });
});

describe("composer gate and the bounded edge-map claim", () => {
  const edgeDoc = (messages: ReadonlyArray<Message>): CanvasDoc => ({
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
      {
        id: "tasks",
        type: "text",
        text: "tasks",
        x: 200,
        y: 0,
        width: 100,
        height: 80,
        ether: {
          entity: { kind: "task" },
          tasks: { items: [] },
        },
      },
    ],
    edges: [
      {
        id: "e1",
        fromNode: "tasks",
        toNode: "agent",
        fromSide: "right",
        toSide: "left",
        ether: { verb: "works" },
      },
    ],
  });

  it("a composer hold does NOT burn the bounded edge-map claim; the empty boundary delivers it", async () => {
    // The battery-caught wedge: idle publishes at the turn boundary before
    // the composer repaint settles, the notice's ONE per-topology transport
    // claim is burned by a refused attempt, and the notice parks until the
    // canvas map changes. The gate must hold (no claim burn) while the
    // composer is not proven empty, and deliver on the empty boundary.
    const msg = userMsg(ulid(), "[factory - map] edge contracts changed — Added: tasks", {
      metadata: { edgeMapChange: true, addedIds: ["tasks"] },
    });
    const store = makeStore({ c: edgeDoc([msg]) });
    const sent: string[] = [];
    let composerEmpty = false;
    const transport: MessageDeliveryTransport = {
      sendTerminalPaste: () => false,
      sendManagedTerminalPrompt: async (_bindingId, text) => {
        sent.push(text);
        return submittedOutcome();
      },
      seatDeliverySnapshot: () => ({
        idle: true,
        generationKey: "g1",
        operatorDraft: !composerEmpty,
      }),
    };
    const service = new MessageDeliveryService();
    // now(): far past the settle window so the idle-settle gate passes.
    let now = 100_000;
    service.configure({ transport, store, now: () => now });

    service.notifyAppended("c", "agent", msg);
    await new Promise((r) => setTimeout(r, 20));
    expect(sent, "held: idle not settled yet").toEqual([]);

    // Past the idle-settle window with the composer STILL not proven empty:
    // the draft hold alone must refuse, and refuse without burning the
    // notice's one per-topology transport claim.
    now += 10_000;
    service.onManagedTerminalIdle("bind-profile-13");
    await new Promise((r) => setTimeout(r, 20));
    expect(sent, "held: composer not proven empty").toEqual([]);

    // Composer proven empty on screen — the boundary the notice waits on.
    composerEmpty = true;
    service.onComposerEmpty("bind-profile-13");
    await waitUntil(() => sent.length === 1);
    expect(sent[0]).toContain("edge contracts changed");

    // At-most-once still holds: further boundaries never re-paste.
    service.onComposerEmpty("bind-profile-13");
    service.onManagedTerminalIdle("bind-profile-13");
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toHaveLength(1);
    service.suspend();
  });
});

describe("bounded re-drive marks and the PTY write truth", () => {
  const edgeMsg = (): Message =>
    userMsg(ulid(), "[factory - map] edge contracts changed — Added: tasks", {
      metadata: { edgeMapChange: true, addedIds: ["tasks"] },
    });
  const edgeDoc2 = (messages: ReadonlyArray<Message>): CanvasDoc => ({
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
      {
        id: "tasks",
        type: "text",
        text: "tasks",
        x: 200,
        y: 0,
        width: 100,
        height: 80,
        ether: {
          entity: { kind: "task" },
          tasks: { items: [] },
        },
      },
    ],
    edges: [
      {
        id: "e1",
        fromNode: "tasks",
        toNode: "agent",
        fromSide: "right",
        toSide: "left",
        ether: { verb: "works" },
      },
    ],
  });

  it("a refusal that wrote nothing re-drives; the eventual paste still happens once", async () => {
    // The cursor-leg wedge: a flickery idle passed the gate, the drive
    // refused at the paste boundary WITHOUT writing, and the notice's one
    // per-topology claim was burned — parked until the map changed.
    const msg = edgeMsg();
    const store = makeStore({ c: edgeDoc2([msg]) });
    const sent: string[] = [];
    let writes = 0;
    let driveAccepts = false;
    const transport: MessageDeliveryTransport = {
      sendTerminalPaste: () => false,
      sendManagedTerminalPrompt: async (_bindingId, text) => {
        if (!driveAccepts) return refusedOutcome(); // refused BEFORE any byte
        writes += 1;
        sent.push(text);
        return submittedOutcome();
      },
      pasteWriteCount: () => writes,
      seatDeliverySnapshot: () => ({
        idle: true,
        generationKey: "g1",
        operatorDraft: false,
      }),
    };
    const service = new MessageDeliveryService();
    let now = 100_000;
    service.configure({ transport, store, now: () => now });

    service.notifyAppended("c", "agent", msg);
    await new Promise((r) => setTimeout(r, 20));
    now += 10_000;
    service.onManagedTerminalIdle("bind-profile-13");
    await new Promise((r) => setTimeout(r, 30));
    expect(sent, "refused without writing — nothing pasted yet").toEqual([]);

    // The seat truly settles; the SAME topology must still get its paste.
    driveAccepts = true;
    service.onComposerEmpty("bind-profile-13");
    await waitUntil(() => sent.length === 1);
    service.onManagedTerminalIdle("bind-profile-13");
    await new Promise((r) => setTimeout(r, 30));
    expect(sent, "delivered exactly once").toHaveLength(1);
    service.suspend();
  });

  it("a paste that wrote but never acked stays bounded — the 4x law holds", async () => {
    const msg = edgeMsg();
    const store = makeStore({ c: edgeDoc2([msg]) });
    let writes = 0;
    let pastes = 0;
    const transport: MessageDeliveryTransport = {
      sendTerminalPaste: () => false,
      sendManagedTerminalPrompt: async () => {
        writes += 1; // bytes reached the PTY…
        pastes += 1;
        return unresolvedOutcome(); // …but no turn-start ack
      },
      pasteWriteCount: () => writes,
      seatDeliverySnapshot: () => ({
        idle: true,
        generationKey: "g1",
        operatorDraft: false,
      }),
    };
    const service = new MessageDeliveryService();
    let now = 200_000;
    service.configure({ transport, store, now: () => now });

    service.notifyAppended("c", "agent", msg);
    await new Promise((r) => setTimeout(r, 20));
    now += 10_000;
    service.onManagedTerminalIdle("bind-profile-13");
    await waitUntil(() => pastes === 1);

    // Idle re-drives must NOT re-paste the same un-acked notice.
    service.onManagedTerminalIdle("bind-profile-13");
    service.onComposerEmpty("bind-profile-13");
    await new Promise((r) => setTimeout(r, 30));
    expect(pastes, "the un-acked paste is never re-pasted — the 4x class").toBe(1);
    service.suspend();
  });
});

describe("batch attempt accounting and accepted-batch recovery", () => {
  const appendItems = (
    docs: Map<string, CanvasDoc>,
    canvas: string,
    nodeId: string,
    update: (items: ReadonlyArray<Message>) => Message[],
  ): void => {
    const current = docs.get(canvas)!;
    docs.set(canvas, {
      ...current,
      nodes: current.nodes.map((node) =>
        node.id === nodeId
          ? {
              ...node,
              ether: {
                ...(node.ether ?? {}),
                messages: { items: update(node.ether?.messages?.items ?? []) },
              },
            }
          : node,
      ),
    });
  };

  it("a batch refused before any byte refunds every member; the eventual paste happens once", async () => {
    const msgs = [userMsg("r1", "first"), userMsg("r2", "second")];
    const store = makeStore({ c: agentDoc(msgs) });
    const sent: string[] = [];
    let writes = 0;
    let refusals = 0;
    let driveAccepts = false;
    const transport: MessageDeliveryTransport = {
      wakeManagedSeat: async () => true,
      sendManagedTerminalPrompt: async (_bindingId, text) => {
        if (!driveAccepts) {
          refusals += 1;
          return refusedOutcome(); // refused BEFORE any byte reached the PTY
        }
        writes += 1;
        sent.push(text);
        return submittedOutcome();
      },
      pasteWriteCount: () => writes,
    };
    const service = new MessageDeliveryService();
    service.configure({ transport, store });

    // More refusals than MAX_TRANSPORT_ATTEMPTS; none of them wrote.
    for (let round = 1; round <= 4; round += 1) {
      service.onBooted();
      await waitUntil(() => refusals === round);
    }
    expect(sent).toEqual([]);

    driveAccepts = true;
    service.onBooted();
    await waitUntil(() => sent.length === 1);
    expect(sent[0]).toContain("2 unread");
    await waitUntil(async () =>
      (await store.hasAcceptedMessageDelivery("c", "agent", "r1")) &&
      (await store.hasAcceptedMessageDelivery("c", "agent", "r2")),
    );
    service.onBooted();
    await new Promise((r) => setTimeout(r, 30));
    expect(sent, "delivered exactly once").toHaveLength(1);
    service.suspend();
  });

  it("an un-acked batch paste holds each member; held members never strand fresh mail", async () => {
    const msgs = [userMsg("u1", "first"), userMsg("u2", "second")];
    let docs!: Map<string, CanvasDoc>;
    const store = makeStore(
      { c: agentDoc(msgs) },
      {
        onDocs: (current) => {
          docs = current;
        },
      },
    );
    const sent: string[] = [];
    let writes = 0;
    const transport: MessageDeliveryTransport = {
      wakeManagedSeat: async () => true,
      sendManagedTerminalPrompt: async (_bindingId, text) => {
        writes += 1; // bytes reached the PTY…
        sent.push(text);
        return unresolvedOutcome(); // …but no turn-start ack: written, unresolved
      },
      pasteWriteCount: () => writes,
    };
    const service = new MessageDeliveryService();
    service.configure({ transport, store });

    service.onBooted();
    await waitUntil(() => sent.length === 1);
    // Same-generation re-drives never re-paste: the uncertainty hold
    // replaces the burn bound — one paste, receiptless, pending.
    service.onBooted();
    await new Promise((r) => setTimeout(r, 30));
    expect(sent).toHaveLength(1);
    expect(await store.hasAcceptedMessageDelivery("c", "agent", "u1")).toBe(false);

    // Fresh mail on the same seat batches on the next window's budget — the
    // turn the unacked paste started — while the held members are left out
    // of the payload rather than pasted again.
    appendItems(docs, "c", "agent", (items) => [
      ...items,
      userMsg("u3", "third"),
      userMsg("u4", "fourth"),
    ]);
    service.onManagedTerminalTurnStart("bind-profile-13");
    service.onBooted();
    await waitUntil(() => sent.length === 2);
    expect(sent[1]).toContain("2 unread");
    expect(sent[1]).not.toContain("4 unread");
    service.suspend();
  });

  it("a member stamped through attemptOne does not strand the seat's later batches", async () => {
    const msgs = [userMsg("b1", "first"), userMsg("b2", "second")];
    let acceptSecond = false;
    let docs!: Map<string, CanvasDoc>;
    const store = makeStore(
      { c: agentDoc(msgs) },
      {
        acceptMessage: (messageId) => messageId !== "b2" || acceptSecond,
        onDocs: (current) => {
          docs = current;
        },
      },
    );
    const payloads: string[] = [];
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        wakeManagedSeat: async () => true,
        sendManagedTerminalPrompt: async (_bindingId, text) => {
          payloads.push(text);
          return submittedOutcome();
        },
      },
      store,
    });

    service.onBooted();
    await waitUntil(async () =>
      (await store.hasAcceptedMessageDelivery("c", "agent", "b1")) &&
      !(await store.hasAcceptedMessageDelivery("c", "agent", "b2")),
    );
    expect(payloads).toHaveLength(1);

    // Only the failed member is left, so the seat re-drive routes it through
    // attemptOne, which stamps the receipt without touching the transport.
    acceptSecond = true;
    service.onManagedTerminalIdle("bind-profile-13");
    await waitUntil(() => store.hasAcceptedMessageDelivery("c", "agent", "b2"));
    expect(payloads).toHaveLength(1);

    // Later mail on the same seat must still batch: the accepted batch is
    // fully receipted, so its marker owes nothing, and the turn the paste
    // started opens the next window's budget.
    appendItems(docs, "c", "agent", (items) => [
      ...items,
      userMsg("b3", "third"),
      userMsg("b4", "fourth"),
    ]);
    service.onManagedTerminalTurnStart("bind-profile-13");
    service.onBooted();
    await waitUntil(() => payloads.length === 2);
    expect(payloads[1]).toContain("2 unread");
    await waitUntil(async () =>
      (await store.hasAcceptedMessageDelivery("c", "agent", "b3")) &&
      (await store.hasAcceptedMessageDelivery("c", "agent", "b4")),
    );
    expect(payloads).toHaveLength(2);
    service.suspend();
  });

  it("the early single-survivor path settles the accepted batch instead of stranding it", async () => {
    const msgs = [userMsg("e1", "first"), userMsg("e2", "second")];
    let acceptOk = false;
    let docs!: Map<string, CanvasDoc>;
    const store = makeStore(
      { c: agentDoc(msgs) },
      {
        acceptOk: () => acceptOk,
        onDocs: (current) => {
          docs = current;
        },
      },
    );
    const sent: string[] = [];
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        wakeManagedSeat: async () => true,
        sendManagedTerminalPrompt: async (_bindingId, text) => {
          sent.push(text);
          return submittedOutcome();
        },
      },
      store,
    });

    service.onBooted();
    await waitUntil(() => sent.length === 1);
    await new Promise((r) => setTimeout(r, 20));
    expect(await store.hasAcceptedMessageDelivery("c", "agent", "e1")).toBe(false);
    expect(await store.hasAcceptedMessageDelivery("c", "agent", "e2")).toBe(false);

    // e1's receipt lands outside this process; the process-local index still
    // carries both members, so the seat re-drive enters attemptBatch with two
    // messages and only one survivor.
    acceptOk = true;
    expect(await store.acceptMessageDelivery("c", "agent", "e1")).toBe(true);
    service.onManagedTerminalIdle("bind-profile-13");
    await waitUntil(() => store.hasAcceptedMessageDelivery("c", "agent", "e2"));
    expect(sent).toHaveLength(1);

    appendItems(docs, "c", "agent", (items) => [
      ...items,
      userMsg("e3", "third"),
      userMsg("e4", "fourth"),
    ]);
    // Budget law: the first batch spent the window; the turn it started
    // opens the next one for the fresh batch.
    service.onManagedTerminalTurnStart("bind-profile-13");
    service.onBooted();
    await waitUntil(() => sent.length === 2);
    expect(sent[1]).toContain("2 unread");
    service.suspend();
  });

  it("identical text with distinct ids: recovery and delivery are owned by message id", async () => {
    const msgs = [userMsg("same-1", "same text"), userMsg("same-2", "same text")];
    let acceptOk = false;
    let docs!: Map<string, CanvasDoc>;
    const store = makeStore(
      { c: agentDoc(msgs) },
      {
        acceptOk: () => acceptOk,
        onDocs: (current) => {
          docs = current;
        },
      },
    );
    const sent: string[] = [];
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        wakeManagedSeat: async () => true,
        sendManagedTerminalPrompt: async (_bindingId, text) => {
          sent.push(text);
          return submittedOutcome();
        },
      },
      store,
    });

    service.onBooted();
    await waitUntil(() => sent.length === 1);
    expect(sent[0]).toContain("2 unread");

    // A third message with the same text but its own id arrives after the
    // accepted payload. It is not a member and must not inherit a receipt.
    appendItems(docs, "c", "agent", (items) => [
      ...items,
      userMsg("same-3", "same text"),
    ]);
    acceptOk = true;
    service.onResumedCanvas("c");
    // Budget law: the batch spent the window; the turn the paste started
    // opens the next one for the look-alike message.
    service.onManagedTerminalTurnStart("bind-profile-13");
    await waitUntil(async () =>
      (await store.hasAcceptedMessageDelivery("c", "agent", "same-1")) &&
      (await store.hasAcceptedMessageDelivery("c", "agent", "same-2")),
    );
    // The look-alike is not a member: it earns its receipt through its own
    // paste, never through the accepted batch's recovery.
    await waitUntil(() => sent.length === 2);
    expect(sent[1]).toBe("[message - user] same text");
    await waitUntil(() => store.hasAcceptedMessageDelivery("c", "agent", "same-3"));
    expect(sent).toHaveLength(2);
    service.suspend();
  });
});

describe.each(["individual", "batch"] as const)("%s transport rejection accounting", (lane) => {
  const messages = () =>
    lane === "individual"
      ? [userMsg("reject-1", "first")]
      : [userMsg("reject-1", "first"), userMsg("reject-2", "second")];
  // All store and transport operations in these cases settle through promises.
  const flushDelivery = async () => {
    for (let i = 0; i < 100; i += 1) await Promise.resolve();
  };

  it.each(["throw", "reject"] as const)("refunds a pre-write %s so later delivery can succeed", async (failure) => {
    const msgs = messages();
    const store = makeStore({ c: agentDoc(msgs) });
    let requests = 0;
    let writes = 0;
    let ready = false;
    const service = new MessageDeliveryService();
    service.configure({
      store,
      transport: {
        wakeManagedSeat: async () => true,
        pasteWriteCount: () => writes,
        sendManagedTerminalPrompt: () => {
          requests += 1;
          if (!ready) {
            const error = new Error("transport rejected before paste");
            if (failure === "throw") throw error;
            return Promise.reject(error);
          }
          writes += 1;
          return Promise.resolve(submittedOutcome());
        },
      },
    });
    try {
      // More failures than the transport attempt cap, with no physical paste.
      for (let round = 1; round <= 4; round += 1) {
        service.onBooted();
        await flushDelivery();
        expect(requests).toBe(round);
      }
      expect(writes).toBe(0);
      for (const message of msgs) {
        expect(await store.hasAcceptedMessageDelivery("c", "agent", message.messageId)).toBe(false);
      }

      ready = true;
      service.onBooted();
      await flushDelivery();
      expect(requests).toBe(5);
      expect(writes).toBe(1);
      for (const message of msgs) {
        expect(await store.hasAcceptedMessageDelivery("c", "agent", message.messageId)).toBe(true);
      }
      service.onBooted();
      await flushDelivery();
      expect(writes).toBe(1);
    } finally {
      service.suspend();
    }
  });

  it("keeps the charge and leaves receipts pending when rejection follows a paste", async () => {
    const msgs = messages();
    const store = makeStore({ c: agentDoc(msgs) });
    let writes = 0;
    const service = new MessageDeliveryService();
    service.configure({
      store,
      transport: {
        wakeManagedSeat: async () => true,
        pasteWriteCount: () => writes,
        sendManagedTerminalPrompt: async () => {
          writes += 1;
          throw new Error("transport rejected after paste without acceptance");
        },
      },
    });
    try {
      for (let round = 1; round <= 4; round += 1) {
        service.onBooted();
        await flushDelivery();
      }
      expect(writes).toBe(3);
      for (const message of msgs) {
        expect(await store.hasAcceptedMessageDelivery("c", "agent", message.messageId)).toBe(false);
      }
    } finally {
      service.suspend();
    }
  });
});
