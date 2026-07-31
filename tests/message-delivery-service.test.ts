import { describe, expect, it } from "vitest";
import type { CanvasDoc, Message } from "../src/shared/canvas";
import { isMessageDelivered } from "../src/shared/message-delivery";
import {
  MessageDeliveryService,
  type MessageDeliveryStore,
  type MessageDeliveryTransport,
} from "../src/main/vellum/work/message-delivery";

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
      text: "mira",
      x: 0,
      y: 0,
      width: 100,
      height: 80,
      ether: {
        entity: { kind: "agent", name: "local:mira" },
        terminal: { bindingId: "bind-mira", harness: "claude" },
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
  options: { readonly acceptOk?: () => boolean; readonly now?: () => number } = {},
): MessageDeliveryStore => {
  const docs = new Map(Object.entries(initial).map(([k, v]) => [k, structuredClone(v)]));
  const accepted = new Set<string>();
  const keyOf = (canvas: string, nodeId: string, messageId: string) =>
    `${canvas}::${nodeId}::${messageId}`;
  return {
    listCanvasNames: async () => [...docs.keys()],
    readDoc: async (name) => docs.get(name),
    hasAcceptedMessageDelivery: async (canvas, nodeId, messageId) =>
      accepted.has(keyOf(canvas, nodeId, messageId)),
    acceptMessageDelivery: async (canvas, nodeId, messageId) => {
      if (options.acceptOk && !options.acceptOk()) return false;
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
        bindingId: "bind-mira",
        text: "[request resolved · request-7] Use the staging key.",
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
    service.onManagedTerminalIdle("bind-mira");
    await waitUntil(() => writes.length === 2);
    service.onManagedTerminalIdle("bind-mira");
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
    expect(payloads).toEqual(["[message · user] ping"]);
    const live = (await store.readDoc("c"))?.nodes[0]?.ether?.messages?.items[0];
    expect(live?.metadata?.deliveredAt).toBe(1_111);
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
      const doc = await store.readDoc("c");
      return isMessageDelivered(doc!.nodes[0]!.ether!.messages!.items[0]!);
    });
    expect(sendCount).toBe(1);
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
    const doc = await store.readDoc("c");
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
            text: "mira",
            x: 0,
            y: 0,
            width: 100,
            height: 80,
            ether: {
              entity: { kind: "agent", name: "local:mira" },
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
    let doc = await store.readDoc("c");
    expect(doc?.nodes[0]?.ether?.messages?.items[0]?.metadata?.deliveredAt).toBeUndefined();

    accepts = true;
    service.onTerminalAttached("bind-term");
    await waitUntil(() => store.hasAcceptedMessageDelivery("c", "terminal", msg.messageId));
    expect(payloads.some((p) => p.includes("[message · user] wake"))).toBe(true);
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
    expect(pastes).toEqual([{ text: "[message · user] echo owned; $(touch /tmp/nope) && rm -rf ~", messageId: "safe" }]);
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
    expect(payloads[0]).toBe("[message · user] do the thing · task task-42");
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
    expect(prompts[0]).toBe("[message · user] claim task");
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
    expect(calls).toEqual([
      {
        bindingId: "bind-mira",
        text: "[message · user] interrupt the turn",
        interruptIfBusy: true,
      },
    ]);
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
      (await store.readDoc("c"))?.nodes[0]?.ether?.messages?.items[0]?.metadata?.deliveredAt,
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
    service.onManagedTerminalIdle("bind-mira");
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
    service.onTerminalAttached("bind-mira");
    service.onManagedTerminalIdle("bind-mira");
    service.onResumed();

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(sendCount).toBe(0);
    expect(
      (await store.readDoc("c"))?.nodes[0]?.ether?.messages?.items[0]
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

    service.onManagedTerminalIdle("bind-mira");
    await waitUntil(() => scanStarted);
    service.suspend();
    releaseNames(["c"]);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(sendCount).toBe(0);
  });
});
