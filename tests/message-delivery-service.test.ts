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
  });

  it("formatting includes sender and taskId when present", async () => {
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
    expect(payloads[0]).toBe("[message · operator] do the thing · task task-42");
  });
});
