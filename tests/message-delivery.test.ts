import { describe, expect, it } from "vitest";
import type { CanvasDoc, Message } from "../src/shared/canvas";
import {
  composeMessageDeliveryPayload,
  composeMessageDeliverySummary,
  composerBlocksMailInject,
  deliveryTargetOf,
  isFactoryMailMessage,
  isForeignMessage,
  isMessageDelivered,
  isPendingDelivery,
  listPendingDeliveries,
  messageBriefText,
  messageSenderLabel,
  MESSAGE_PTY_FULL_BODY_MAX,
  operatorTypedThisGeneration,
  shouldSummarizeMessageForPty,
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
    // Managed terminal is the only agent delivery surface.
    terminal: { bindingId: "bind-mira", harness: "claude" },
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

const terminalNode = (messages: ReadonlyArray<Message> = []): CanvasDoc["nodes"][number] => ({
  id: "terminal", type: "text", text: "shell", x: 0, y: 0, width: 200, height: 100,
  ether: { entity: { kind: "terminal" }, terminal: { bindingId: "binding-1" }, messages: { items: [...messages] } },
});

describe("message-delivery pure helpers", () => {
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
    expect(line.startsWith("[message - user] factory mail from agent-01KZRZK09851NV4407M2499WJM")).toBe(
      true,
    );
    expect(line).toContain("01KZSM4A84AS");
    expect(line).toContain("vellum-command msg list");
    // Essay body is not dumped — only a short preview + CLI pointer.
    expect(line.includes("\n")).toBe(false);
    expect(line.length).toBeLessThan(220);
    expect(line).not.toContain("nothing run, nothing edited");
  });

  it("batches multiple pending into one notify line", () => {
    const batch = composeMessageDeliverySummary([
      userMsg({ messageId: "01AAA", parts: [{ kind: "text", text: "one" }] }),
      userMsg({
        messageId: "01BBB",
        metadata: { factoryMail: true },
        parts: [{ kind: "text", text: "two essay" }],
      }),
      userMsg({ messageId: "01CCC", parts: [{ kind: "text", text: "three" }] }),
    ]);
    expect(batch).toContain("3 pending");
    expect(batch).toContain("1 factory mail");
    expect(batch).toContain("vellum-command msg list");
    expect(batch.includes("\n")).toBe(false);
  });

  it("composerBlocksMailInject: harness chrome is NOT draft; only paste chip blocks", () => {
    expect(composerBlocksMailInject("")).toBe(false);
    expect(composerBlocksMailInject("   ")).toBe(false);
    expect(composerBlocksMailInject("[message - user] mail · 01abc · vellum-command msg list")).toBe(
      false,
    );
    // Real startup-idle chrome must not kill mail (review BLOCK #1).
    expect(composerBlocksMailInject('Try "fix typecheck errors"')).toBe(false);
    expect(composerBlocksMailInject("Grok 4.5 (low) · 22K / 500K (4%) · ctrl+o transcript")).toBe(
      false,
    );
    expect(composerBlocksMailInject("gpt-5.4-mini low · /tmp")).toBe(false);
    expect(composerBlocksMailInject("please fix the seat brick")).toBe(false);
    expect(composerBlocksMailInject("[Pasted text #3 +12 lines]")).toBe(true);
  });

  it("operatorTypedThisGeneration is the load-bearing draft gate", () => {
    expect(
      operatorTypedThisGeneration({
        lastUserInputAtMs: undefined,
        generationStartedAtMs: 1000,
      }),
    ).toBe(false);
    expect(
      operatorTypedThisGeneration({
        lastUserInputAtMs: 999,
        generationStartedAtMs: 1000,
      }),
    ).toBe(false);
    expect(
      operatorTypedThisGeneration({
        lastUserInputAtMs: 1000,
        generationStartedAtMs: 1000,
      }),
    ).toBe(true);
    expect(
      operatorTypedThisGeneration({
        lastUserInputAtMs: 1500,
        generationStartedAtMs: 1000,
      }),
    ).toBe(true);
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

  it("resolves the agent seat; bare agent, herdr and raw terminals are unreachable", () => {
    // Agents without ether.terminal.bindingId never fall back to ACP.
    expect(deliveryTargetOf(agentNode())).toEqual({
      bindingId: "bind-mira",
    });
    // Geography holds no inbox — neither a herdr pane nor a raw user terminal
    // is a delivery target.
    expect(deliveryTargetOf(herdrNode())).toBeUndefined();
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
    expect(pending.map((p) => p.message.messageId).sort()).toEqual(["p1"]);
    expect(pending.find((p) => p.message.messageId === "p1")?.target).toEqual({
      bindingId: "bind-mira",
    });
  });
});
