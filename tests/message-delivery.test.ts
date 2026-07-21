import { describe, expect, it } from "vitest";
import type { CanvasDoc, Message } from "../src/shared/canvas";
import {
  composeMessageDeliveryPayload,
  deliveryTargetOf,
  isForeignMessage,
  isMessageDelivered,
  isPendingDelivery,
  listPendingDeliveries,
  messageBriefText,
  messageSenderLabel,
  stampMessageDelivered,
} from "../src/shared/message-delivery";

const userMsg = (over: Partial<Message> = {}): Message => ({
  messageId: "m1",
  role: "user",
  parts: [{ kind: "text", text: "ping the lane" }],
  ...over,
});

const agentNode = (messages: ReadonlyArray<Message> = []): CanvasDoc["nodes"][number] => ({
  id: "agent",
  type: "text",
  text: "mira",
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  ether: {
    entity: { kind: "agent", name: "local:mira" },
    messages: { items: [...messages] },
  },
});

const herdrNode = (messages: ReadonlyArray<Message> = []): CanvasDoc["nodes"][number] => ({
  id: "herdr",
  type: "text",
  text: "cp",
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  ether: {
    entity: { kind: "herdr" },
    herdr: {
      host: "local",
      terminalId: "term-1",
      paneId: "pane-1",
    },
    messages: { items: [...messages] },
  },
});

describe("message-delivery pure helpers", () => {
  it("formats one-line payload with sender and optional taskId", () => {
    expect(composeMessageDeliveryPayload(userMsg())).toBe("[message · user] ping the lane");
    expect(
      composeMessageDeliveryPayload(
        userMsg({
          metadata: { sender: "operator" },
          taskId: "task-9",
        }),
      ),
    ).toBe("[message · operator] ping the lane · task task-9");
  });

  it("sender falls back to role; brief collapses whitespace", () => {
    expect(messageSenderLabel(userMsg())).toBe("user");
    expect(
      messageBriefText(
        userMsg({ parts: [{ kind: "text", text: "  a\n  b  " }, { kind: "text", text: "c" }] }),
      ),
    ).toBe("a b c");
  });

  it("own-echo: agent role is never pending; user role is", () => {
    expect(isForeignMessage(userMsg())).toBe(true);
    expect(isForeignMessage(userMsg({ role: "agent" }))).toBe(false);
    expect(isPendingDelivery(userMsg())).toBe(true);
    expect(isPendingDelivery(userMsg({ role: "agent" }))).toBe(false);
    expect(
      isPendingDelivery(userMsg({ metadata: { deliveredAt: 1_700_000_000_000 } })),
    ).toBe(false);
  });

  it("stamps deliveredAt through a pure doc transform (serialized-path body)", () => {
    const doc: CanvasDoc = {
      nodes: [agentNode([userMsg({ messageId: "m-a" })])],
      edges: [],
    };
    const stamped = stampMessageDelivered(doc, "agent", "m-a", 42);
    expect(stamped).not.toBeNull();
    const msg = stamped!.nodes[0]?.ether?.messages?.items[0];
    expect(msg?.metadata?.deliveredAt).toBe(42);
    expect(isMessageDelivered(msg!)).toBe(true);
    // second stamp is a no-op (at-most-once at the document layer)
    expect(stampMessageDelivered(stamped!, "agent", "m-a", 99)).toBeNull();
  });

  it("resolves agent and herdr targets; skips incomplete bindings", () => {
    expect(deliveryTargetOf(agentNode())).toEqual({
      kind: "agent",
      agentKey: "local:mira",
    });
    expect(deliveryTargetOf(herdrNode())).toEqual({
      kind: "herdr",
      terminalId: "term-1",
    });
    const bare: CanvasDoc["nodes"][number] = {
      id: "x",
      type: "text",
      text: "x",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      ether: { entity: { kind: "agent" } },
    };
    expect(deliveryTargetOf(bare)).toBeUndefined();
  });

  it("lists only foreign pending messages on agent/herdr nodes", () => {
    const doc: CanvasDoc = {
      nodes: [
        agentNode([
          userMsg({ messageId: "p1" }),
          userMsg({ messageId: "done", metadata: { deliveredAt: 1 } }),
          userMsg({ messageId: "own", role: "agent", parts: [{ kind: "text", text: "echo" }] }),
        ]),
        herdrNode([userMsg({ messageId: "h1", parts: [{ kind: "text", text: "herdr ping" }] })]),
        {
          id: "tasks",
          type: "text",
          text: "tasks",
          x: 0,
          y: 0,
          width: 10,
          height: 10,
          ether: {
            entity: { kind: "task" },
            tasks: {
              items: [
                {
                  id: "t1",
                  state: "submitted",
                  history: [userMsg({ messageId: "in-history" })],
                },
              ],
            },
          },
        },
      ],
      edges: [],
    };
    const pending = listPendingDeliveries(doc);
    expect(pending.map((p) => p.message.messageId).sort()).toEqual(["h1", "p1"]);
    expect(pending.find((p) => p.message.messageId === "p1")?.target).toEqual({
      kind: "agent",
      agentKey: "local:mira",
    });
  });
});
