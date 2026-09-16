import { describe, expect, it } from "vitest";
import { ulid } from "ulid";
import type { CanvasDoc, Message } from "../src/shared/canvas";
import {
  composeMessageDeliveryPayload,
  composeImmediatePromptPayload,
  composeMessageDeliverySummary,
  mailDisplayFactsOf,
  deliveryTargetOf,
  isFactoryMailMessage,
  isForeignMessage,
  isMessageDelivered,
  isPendingDelivery,
  listPendingDeliveries,
  messageBriefText,
  messageSenderLabel,
  MESSAGE_PTY_FULL_BODY_MAX,
  ptyInjectMarksRead,
  shouldSummarizeMessageForPty,
  sortMessagesNewestFirst,
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
  text: "profile-13",
  x: 0,
  y: 0,
  width: 200,
  height: 100,
  ether: {
    entity: { kind: "agent", name: "local:profile-13" },
    // Managed terminal is the only agent delivery surface.
    terminal: { bindingId: "bind-profile-13", harness: "claude" },
    messages: { items: [...messages] },
  },
});


const terminalNode = (messages: ReadonlyArray<Message> = []): CanvasDoc["nodes"][number] => ({
  id: "terminal", type: "text", text: "shell", x: 0, y: 0, width: 200, height: 100,
  ether: { entity: { kind: "terminal" }, terminal: { bindingId: "binding-1" }, messages: { items: [...messages] } },
});

describe("message-delivery pure helpers", () => {
  it("projects legacy notification and preserved uncertainty without inventing a read", () => {
    const at = "2026-09-15T00:00:00.000Z";
    const deliveredAt = Date.parse(at);
    const legacy = mailDisplayFactsOf(userMsg({ metadata: { deliveredAt } }));
    expect(legacy.notifiedAt).toBe(at);
    expect(legacy.readAt).toBeUndefined();
    const facts = mailDisplayFactsOf(userMsg({ metadata: {
      deliveredAt, generation: "binding-e1", queuedAt: at, unresolvedAt: at,
      refusedAt: at, refusedReason: "seat-busy", readAt: deliveredAt,
      reactions: [{ kind: "ack", at: deliveredAt }],
    } }));
    expect(facts).toMatchObject({
      notifiedAt: at, unresolvedAt: at, refusedAt: at, refusedReason: "seat-busy",
      readAt: at, reactedAt: at, generation: "binding-e1",
    });
  });

  it("strips recognized current envelopes without dropping other sender-like prose", () => {
    const message = userMsg({
      metadata: { factoryMail: true, fromSeat: "seat-a", senderName: "Peer Reviewer" },
      parts: [{ kind: "text", text: "mail from Peer Reviewer\nReview the patch" }],
    });
    expect(composeMessageDeliveryPayload(message)).toContain("mail from Peer Reviewer — Review the patch");
    expect(composeImmediatePromptPayload(message)).toBe("mail from Peer Reviewer\nReview the patch");
    expect(composeImmediatePromptPayload({ ...message, parts: [{ kind: "text", text: "mail from someone else should be checked" }] }))
      .toContain("mail from someone else should be checked");
  });
  it("preserves a prompt body and attributes it to the server-stamped sender", () => {
    const message = userMsg({
      metadata: { factoryMail: true, mailKind: "prompt", fromSeat: "seat_hash", senderName: "Reviewer" },
      parts: [{ kind: "text", text: "Read the patch.\nCheck the failing case." }],
    });
    expect(composeImmediatePromptPayload(message)).toBe(
      "mail from Reviewer\nRead the patch.\nCheck the failing case.",
    );
    expect(composeMessageDeliveryPayload(message)).toContain("junto msg read m1");
  });

  it("formats one-line payload with role and optional taskId", () => {
    expect(composeMessageDeliveryPayload(userMsg())).toBe("[message - user] ping the lane");
    expect(
      composeMessageDeliveryPayload(
        userMsg({
          metadata: { sender: "operator" }, // spoof ignored — label is role only
          taskId: "task-9",
        }),
      ),
    ).toBe("[message - user] ping the lane - task task-9");
  });

  it("summarizes factory mail and long bodies; never dumps the essay", () => {
    const long = "x".repeat(MESSAGE_PTY_FULL_BODY_MAX + 40);
    expect(shouldSummarizeMessageForPty(userMsg({ parts: [{ kind: "text", text: long }] }))).toBe(
      true,
    );
    const factory = userMsg({
      messageId: "01KZSM4A84ASFRTZ77YAQ09CVH",
      metadata: { factoryMail: true, fromSeat: "agent-01KZRZK09851NV4407M2499WJM" },
      parts: [
        {
          kind: "text",
          text:
            "[factory mail from agent-01KZRZK09851NV4407M2499WJM] HARNESS-INTEGRATION ANALYSIS\n\n1. WHAT IS SHARED",
        },
      ],
    });
    expect(isFactoryMailMessage(factory)).toBe(true);
    expect(shouldSummarizeMessageForPty(factory)).toBe(true);
    const line = composeMessageDeliveryPayload(factory);
    expect(line.startsWith("mail from agent-01KZRZK09851NV4407M2499WJM")).toBe(
      true,
    );
    expect(line).toContain("01KZSM4A84AS");
    expect(line).toContain("junto msg read 01KZSM4A84ASFRTZ77YAQ09CVH");
    expect(line).not.toContain("[factory mail from");
    // Essay body is not dumped — only a short preview + CLI pointer.
    expect(line.includes("\n")).toBe(false);
    expect(line.length).toBeLessThan(220);
    expect(line).not.toContain("nothing run, nothing edited");
    expect(ptyInjectMarksRead(factory)).toBe(false);
    expect(ptyInjectMarksRead(userMsg())).toBe(false);
  });

  it("batches multiple unread into one newest-first list line", () => {
    const t0 = 1_700_000_000_000;
    const oldest = ulid(t0);
    const middle = ulid(t0 + 1_000);
    const newest = ulid(t0 + 2_000);
    const extra1 = ulid(t0 + 3_000);
    const extra2 = ulid(t0 + 4_000);
    const batch = composeMessageDeliverySummary([
      userMsg({ messageId: oldest, parts: [{ kind: "text", text: "one" }] }),
      userMsg({
        messageId: middle,
        metadata: { factoryMail: true },
        parts: [{ kind: "text", text: "two essay" }],
      }),
      userMsg({ messageId: newest, parts: [{ kind: "text", text: "three" }] }),
    ]);
    expect(batch).toContain("3 unread");
    expect(batch).not.toContain("factory mail");
    expect(batch).toContain("junto msg list");
    expect(batch.includes("\n")).toBe(false);
    const newestIdx = batch.indexOf(newest.slice(0, 12));
    const middleIdx = batch.indexOf(middle.slice(0, 12));
    const oldestIdx = batch.indexOf(oldest.slice(0, 12));
    expect(newestIdx).toBeGreaterThan(-1);
    expect(middleIdx).toBeGreaterThan(newestIdx);
    expect(oldestIdx).toBeGreaterThan(middleIdx);

    const burst = composeMessageDeliverySummary([
      userMsg({ messageId: oldest, parts: [{ kind: "text", text: "a" }] }),
      userMsg({ messageId: middle, parts: [{ kind: "text", text: "b" }] }),
      userMsg({ messageId: newest, parts: [{ kind: "text", text: "c" }] }),
      userMsg({ messageId: extra1, parts: [{ kind: "text", text: "d" }] }),
      userMsg({ messageId: extra2, parts: [{ kind: "text", text: "e" }] }),
    ]);
    expect(burst).toContain("5 unread");
    expect(burst).toContain("+2");
    expect(burst).toContain(extra2.slice(0, 12));
    expect(burst).not.toContain(oldest.slice(0, 12));
  });

  it("sorts mail newest-first so a lone unread is the latest", () => {
    const t0 = 1_700_000_000_000;
    const older = userMsg({ messageId: ulid(t0), parts: [{ kind: "text", text: "old" }] });
    const latest = userMsg({
      messageId: ulid(t0 + 5_000),
      parts: [{ kind: "text", text: "new ping" }],
    });
    expect(sortMessagesNewestFirst([older, latest]).map((m) => m.messageId)).toEqual([
      latest.messageId,
      older.messageId,
    ]);
    expect(composeMessageDeliverySummary([older, latest])).toContain("2 unread");
    expect(composeMessageDeliveryPayload(latest)).toBe("[message - user] new ping");
  });


  it("sender is role only; brief strips controls and collapses whitespace", () => {
    expect(messageSenderLabel(userMsg({ metadata: { sender: "operator" } }))).toBe("user");
    expect(
      messageBriefText(
        userMsg({
          parts: [
            { kind: "text", text: "  a\n  b  " },
            { kind: "text", text: "c\u001b[31mx" },
          ],
        }),
      ),
    ).toBe("a b c [31mx");
  });

  it("own-echo: agent role is never pending; user role is", () => {
    expect(isForeignMessage(userMsg())).toBe(true);
    expect(isForeignMessage(userMsg({ role: "agent" }))).toBe(false);
    expect(isPendingDelivery(userMsg())).toBe(true);
    expect(isPendingDelivery(userMsg({ role: "agent" }))).toBe(false);
    expect(
      isPendingDelivery(userMsg({ metadata: { deliveredAt: 1_700_000_000_000 } })),
    ).toBe(false);
    expect(
      isPendingDelivery(userMsg({ metadata: { readAt: 1_700_000_000_000 } })),
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

  it("resolves the agent seat; bare agent and raw terminals are unreachable", () => {
    // Agents without ether.terminal.bindingId never fall back to ACP.
    expect(deliveryTargetOf(agentNode())).toEqual({
      bindingId: "bind-profile-13",
    });
    // Geography holds no inbox — a raw user terminal
    // is a delivery target.
    expect(deliveryTargetOf(terminalNode())).toBeUndefined();
    const bare: CanvasDoc["nodes"][number] = {
      id: "x",
      type: "text",
      text: "x",
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      ether: { entity: { kind: "agent", name: "local:orphan" } },
    };
    expect(deliveryTargetOf(bare)).toBeUndefined();
  });

  it("lists only foreign pending messages on actor nodes", () => {
    const doc: CanvasDoc = {
      nodes: [
        agentNode([
          userMsg({ messageId: "p1" }),
          userMsg({ messageId: "done", metadata: { deliveredAt: 1 } }),
          userMsg({ messageId: "listed", metadata: { readAt: 2 } }),
          userMsg({ messageId: "own", role: "agent", parts: [{ kind: "text", text: "echo" }] }),
        ]),
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
    expect(pending.map((p) => p.message.messageId).sort()).toEqual(["p1"]);
    expect(pending.find((p) => p.message.messageId === "p1")?.target).toEqual({
      bindingId: "bind-profile-13",
    });
  });

  it("lists pending on a seat newest-first", () => {
    const t0 = 1_700_000_000_000;
    const older = ulid(t0);
    const newer = ulid(t0 + 10_000);
    const doc: CanvasDoc = {
      nodes: [
        agentNode([
          userMsg({ messageId: older, parts: [{ kind: "text", text: "old" }] }),
          userMsg({ messageId: newer, parts: [{ kind: "text", text: "new" }] }),
        ]),
      ],
      edges: [],
    };
    expect(listPendingDeliveries(doc).map((p) => p.message.messageId)).toEqual([
      newer,
      older,
    ]);
  });
});
