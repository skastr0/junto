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

describe("MessageDeliveryService", () => {
  it("pushes an operator response to the exact requesting actor", async () => {
    const store = makeStore({ c: agentDoc([]) });
    const writes: Array<{ bindingId: string; text: string }> = [];
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        sendManagedTerminalPrompt: async (bindingId, text) => {
          writes.push({ bindingId, text });
          return true;
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
          return true;
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
          return accepts;
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
      return true;
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
          return true;
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
          return true;
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
    let resolveSend!: (v: boolean) => void;
    let sendCount = 0;
    const sendManagedTerminalPrompt = (_bindingId: string, _text: string) => {
      sendCount += 1;
      return new Promise<boolean>((resolve) => {
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
    resolveSend(true);
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
    let releaseFirst!: (accepted: boolean) => void;
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        wakeManagedSeat: async () => true,
        sendManagedTerminalPrompt: async (_bindingId, text) => {
          payloads.push(text);
          if (payloads.length === 1) {
            return new Promise<boolean>((resolve) => {
              releaseFirst = resolve;
            });
          }
          return true;
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

    releaseFirst(true);
    await waitUntil(async () =>
      (await store.hasAcceptedMessageDelivery("c", "agent", "m-one")) &&
      (await store.hasAcceptedMessageDelivery("c", "agent", "m-two")),
    );
    expect(payloads).toHaveLength(2);
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
          return true;
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
    service.onResumed();

    await waitUntil(() =>
      store.hasAcceptedMessageDelivery("c", "agent", "b-two"),
    );
    expect(payloads).toHaveLength(1);
    expect(await store.hasAcceptedMessageDelivery("c", "agent", "b-three")).toBe(
      false,
    );
  });

  it("does not let an individual notify a message already reserved by a batch", async () => {
    const msgs = [userMsg("batch-one", "first"), userMsg("batch-two", "second")];
    const store = makeStore({ c: agentDoc(msgs) });
    const payloads: string[] = [];
    let releaseBatch!: (accepted: boolean) => void;
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        wakeManagedSeat: async () => true,
        sendManagedTerminalPrompt: async (_bindingId, text) => {
          payloads.push(text);
          return new Promise<boolean>((resolve) => {
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

    releaseBatch(true);
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
          return true;
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
          return true;
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
          return true;
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
          return true;
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

  it("marks explicit factory mail for busy-seat interruption", async () => {
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
          return true;
        },
      },
      store,
    });

    service.notifyAppended("c", "agent", msg);
    await waitUntil(() => calls.length === 1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.bindingId).toBe("bind-profile-13");
    expect(calls[0]?.interruptIfBusy).toBe(true);
    // Factory mail always summarizes — full body never rides the PTY.
    expect(calls[0]?.text).toContain("factory mail");
    expect(calls[0]?.text).toContain("mail-steer");
    expect(calls[0]?.text).toContain("vellum-command msg list");
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
          return true;
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
        sendManagedTerminalPrompt: async () => true,
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
          return true;
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
          return true;
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
          if (!accept) return false;
          prompts.push(text);
          return true;
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
          return true;
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
        return true;
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
    service.onResumed();

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
          return true;
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
          return true;
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
        sendManagedTerminalPrompt: async () => true,
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
          return true;
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
          return true;
        },
      },
      store,
    });

    service.onBooted();
    await waitUntil(() => payloads.length === 1);
    expect(payloads[0]).toContain("3 unread");
    expect(payloads[0]).toContain("factory mail");
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
          return true;
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
          return true;
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
          return true;
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
          return true;
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
          return true;
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
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        wakeManagedSeat: async () => true,
        sendManagedTerminalPrompt: async (_bindingId, text) => {
          sends.push(text);
          return true;
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
    service.onResumed();
    await waitUntil(async () =>
      (await store.hasAcceptedMessageDelivery("c", "agent", "b1")) &&
      (await store.hasAcceptedMessageDelivery("c", "agent", "b2")),
    );
    expect(await store.hasAcceptedMessageDelivery("c", "agent", "b3")).toBe(false);
    expect(sends).toHaveLength(1);

    // The post-batch message remains pending and is delivered on its own later.
    service.onManagedTerminalIdle("bind-profile-13");
    await waitUntil(() => sends.length === 2);
    expect(sends[1]).toBe("[message - user] third");
    await waitUntil(() =>
      store.hasAcceptedMessageDelivery("c", "agent", "b3"),
    );
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
          return true;
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
          return true;
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
          return false;
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
        sendManagedTerminalPrompt: async () => false,
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
        sendManagedTerminalPrompt: async () => true,
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
        sendManagedTerminalPrompt: async () => true,
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
        sendManagedTerminalPrompt: async () => true,
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
      transport: { sendManagedTerminalPrompt: async () => true },
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
      transport: { sendManagedTerminalPrompt: async () => true },
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
          return true;
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
          return true;
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
          return true;
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
          return true;
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
        return true;
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
        if (!driveAccepts) return false; // refused BEFORE any byte
        writes += 1;
        sent.push(text);
        return true;
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
        return false; // …but no turn-start ack
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
