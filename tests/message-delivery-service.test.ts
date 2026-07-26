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
        messages: { items: [...messages] },
      },
    },
  ],
  edges: [],
});

const herdrDoc = (messages: ReadonlyArray<Message>): CanvasDoc => ({
  nodes: [
    {
      id: "herdr",
      type: "text",
      text: "cp",
      x: 0,
      y: 0,
      width: 100,
      height: 80,
      ether: {
        entity: { kind: "herdr" },
        herdr: { host: "local", terminalId: "term-1", paneId: "p1" },
        messages: { items: [...messages] },
      },
    },
  ],
  edges: [],
});

const makeStore = (initial: Record<string, CanvasDoc>): MessageDeliveryStore => {
  const docs = new Map(Object.entries(initial).map(([k, v]) => [k, structuredClone(v)]));
  return {
    listCanvasNames: async () => [...docs.keys()],
    readDoc: async (name) => docs.get(name),
    stampDelivered: async (canvas, nodeId, messageId, deliveredAt) => {
      const doc = docs.get(canvas);
      if (!doc) return false;
      const node = doc.nodes.find((n) => n.id === nodeId);
      if (!node?.ether?.messages) return false;
      const items = node.ether.messages.items.map((m) =>
        m.messageId === messageId
          ? { ...m, metadata: { ...(m.metadata ?? {}), deliveredAt } }
          : m,
      );
      const next: CanvasDoc = {
        ...doc,
        nodes: doc.nodes.map((n) =>
          n.id === nodeId
            ? {
                ...n,
                ether: { ...(n.ether ?? {}), messages: { items } },
              }
            : n,
        ),
      };
      docs.set(canvas, next);
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
  it("stamps deliveredAt through the store when agent is live", async () => {
    const msg = userMsg("m1");
    const store = makeStore({ c: agentDoc([msg]) });
    const payloads: string[] = [];
    const sendAgentPrompt = async (_key: string, text: string) => {
      payloads.push(text);
      return true;
    };
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        isAgentLive: () => true,
        sendAgentPrompt,
        sendHerdrText: () => false,
      },
      store,
      now: () => 1_111,
    });

    service.notifyAppended("c", "agent", msg);
    await waitUntil(async () => {
      const live = (await store.readDoc("c"))?.nodes[0]?.ether?.messages?.items[0];
      return live?.metadata?.deliveredAt === 1_111;
    });
    expect(payloads).toEqual(["[message · user] ping"]);
  });

  it("at-most-once under rapid append burst", async () => {
    const msg = userMsg("burst");
    const store = makeStore({ c: agentDoc([msg]) });
    let resolveSend!: (v: boolean) => void;
    let sendCount = 0;
    const sendAgentPrompt = (_key: string, _text: string) => {
      sendCount += 1;
      return new Promise<boolean>((resolve) => {
        resolveSend = resolve;
      });
    };
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        isAgentLive: () => true,
        sendAgentPrompt,
        sendHerdrText: () => false,
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
        isAgentLive: () => true,
        sendAgentPrompt: async () => {
          sendCount += 1;
          return true;
        },
        sendHerdrText: () => false,
      },
      store,
    });
    service.notifyAppended("c", "agent", own);
    await new Promise((r) => setTimeout(r, 30));
    expect(sendCount).toBe(0);
    const doc = await store.readDoc("c");
    expect(doc?.nodes[0]?.ether?.messages?.items[0]?.metadata?.deliveredAt).toBeUndefined();
  });

  it("unreachable target leaves pending; attach triggers retry", async () => {
    const msg = userMsg("later", "wake");
    const store = makeStore({ c: herdrDoc([msg]) });
    const herdrPayloads: string[] = [];
    let herdrOk = false;
    const service = new MessageDeliveryService();
    const transport: MessageDeliveryTransport = {
      isAgentLive: () => false,
      sendAgentPrompt: async () => false,
      sendHerdrText: (_terminalId, text) => {
        herdrPayloads.push(text);
        return herdrOk;
      },
    };
    service.configure({ transport, store, now: () => 9 });

    service.notifyAppended("c", "herdr", msg);
    await waitUntil(() => herdrPayloads.length >= 1);
    expect(herdrPayloads.length).toBe(1);
    let doc = await store.readDoc("c");
    expect(doc?.nodes[0]?.ether?.messages?.items[0]?.metadata?.deliveredAt).toBeUndefined();

    herdrOk = true;
    service.onHerdrAttached("term-1");
    await waitUntil(async () => {
      doc = await store.readDoc("c");
      return doc?.nodes[0]?.ether?.messages?.items[0]?.metadata?.deliveredAt === 9;
    });
    expect(herdrPayloads.some((p) => p.includes("[message · user] wake"))).toBe(true);
    expect(herdrPayloads.at(-1)).toBe("\u001b[200~[message · user] wake\u001b[201~");
    expect(herdrPayloads.at(-1)).not.toContain("\n");
  });

  it("terminal fallback pastes metacharacters without newline or shell submission", async () => {
    const msg = userMsg("safe", "echo owned; $(touch /tmp/nope) && rm -rf ~");
    const base = herdrDoc([msg]);
    const doc: CanvasDoc = {
      ...base,
      nodes: [{
        ...base.nodes[0]!, id: "terminal",
        ether: { entity: { kind: "terminal" }, terminal: { bindingId: "binding-1" }, messages: { items: [msg] } },
      }],
    };
    const store = makeStore({ c: doc });
    const pastes: Array<{ text: string; messageId: string }> = [];
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        isAgentLive: () => false,
        sendAgentPrompt: async () => false,
        sendHerdrText: () => false,
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
        isAgentLive: () => true,
        sendAgentPrompt: async (_key, text) => {
          payloads.push(text);
          return true;
        },
        sendHerdrText: () => false,
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
    const base = herdrDoc([msg]);
    const doc: CanvasDoc = {
      ...base,
      nodes: [{
        ...base.nodes[0]!,
        id: "terminal",
        ether: {
          entity: { kind: "terminal" },
          terminal: { bindingId: "bind-mt" },
          messages: { items: [msg] },
        },
      }],
    };
    const store = makeStore({ c: doc });
    const prompts: string[] = [];
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        isAgentLive: () => false,
        sendAgentPrompt: async () => false,
        sendHerdrText: () => false,
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
    await waitUntil(async () => {
      const live = (await store.readDoc("c"))?.nodes[0]?.ether?.messages?.items[0];
      return live?.metadata?.deliveredAt === 42;
    });
  });

  it("managed terminal idle gate leave pending until onManagedTerminalIdle", async () => {
    const msg = userMsg("idle-gate", "wait");
    const base = herdrDoc([msg]);
    const doc: CanvasDoc = {
      ...base,
      nodes: [{
        ...base.nodes[0]!,
        id: "terminal",
        ether: {
          entity: { kind: "terminal" },
          terminal: { bindingId: "bind-idle" },
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
        isAgentLive: () => false,
        sendAgentPrompt: async () => false,
        sendHerdrText: () => false,
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
    await waitUntil(async () => {
      const live = (await store.readDoc("c"))?.nodes[0]?.ether?.messages?.items[0];
      return live?.metadata?.deliveredAt === 7;
    });
  });

  it("transport accept + stamp fail never re-sends on attach", async () => {
    const msg = userMsg("dup", "once only");
    const store = makeStore({ c: agentDoc([msg]) });
    let stampOk = false;
    let sendCount = 0;
    const service = new MessageDeliveryService();
    service.configure({
      transport: {
        isAgentLive: () => true,
        sendAgentPrompt: async () => {
          sendCount += 1;
          return true;
        },
        sendHerdrText: () => false,
      },
      store: {
        ...store,
        stampDelivered: async (...args) => {
          if (!stampOk) return false;
          return store.stampDelivered(...args);
        },
      },
      now: () => 5,
    });
    service.notifyAppended("c", "agent", msg);
    await waitUntil(() => sendCount === 1);
    expect((await store.readDoc("c"))?.nodes[0]?.ether?.messages?.items[0]?.metadata?.deliveredAt).toBeUndefined();

    // Attach re-drive: stamp only, no second transport hit
    stampOk = true;
    service.onAgentLive("local:mira");
    await waitUntil(async () => {
      const live = (await store.readDoc("c"))?.nodes[0]?.ether?.messages?.items[0];
      return live?.metadata?.deliveredAt === 5;
    });
    expect(sendCount).toBe(1);
  });
});
