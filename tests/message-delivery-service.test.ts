import { afterEach, describe, expect, it } from "vitest";
import type { CanvasDoc, Message } from "../src/shared/canvas";
import { mailExtensionMetadata, type MailExtension, type MailKind } from "../src/shared/crew";
import {
  MessageDeliveryService,
  type MessageDeliveryStore,
} from "../src/main/junto/work/message-delivery";

const canvas = "crew";
const nodeId = "agent-b";
const bindingId = "bind-b";
const SENDER = `seat_${"a".repeat(64)}` as MailExtension["fromSeat"];

const mail = (messageId: string, text: string, mailKind: MailKind = "notice"): Message => ({
  messageId,
  role: "user",
  parts: [{ kind: "text", text }],
  metadata: {
    factoryMail: true,
    ...mailExtensionMetadata({
      mailKind,
      fromSeat: SENDER,
      senderNodeId: "agent-a",
      senderName: "Claude Code",
      senderGeneration: "ep_a",
      senderHarness: "claude",
    }),
  },
});

const seatNode = (messages: Message[]) => ({
  id: nodeId,
  type: "text" as const,
  text: "Claude Code",
  x: 0,
  y: 0,
  width: 100,
  height: 80,
  ether: {
    entity: { kind: "agent" as const, name: "local:claude" },
    terminal: { bindingId, harness: "claude" },
    messages: { items: messages },
  },
});

/**
 * One canvas whose mailbox the test appends to, a receipt plane that stamps
 * `deliveredAt` like the real projection, and a seat the test turns on/off.
 */
const rig = (
  options: {
    live?: boolean;
    writeOk?: () => boolean;
    /** Wake result; the default leaves the seat down (paused canvas). */
    wake?: () => boolean;
  } = {},
) => {
  const messages: Message[] = [];
  const doc = { nodes: [seatNode(messages)], edges: [] } as unknown as CanvasDoc;
  let live = options.live ?? true;
  const writes: string[] = [];
  let writing = 0;
  let overlapped = false;
  const wakes: Array<{ bindingId: string; canvas: string; nodeId: string }> = [];
  const store: MessageDeliveryStore = {
    listCanvasNames: async () => [canvas],
    readDoc: async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return doc;
    },
    acceptMessageDelivery: async (_canvas, _node, messageId) => {
      const index = messages.findIndex((m) => m.messageId === messageId);
      messages[index] = {
        ...messages[index]!,
        metadata: { ...messages[index]!.metadata, deliveredAt: Date.now() },
      };
      return true;
    },
  };
  const service = new MessageDeliveryService();
  service.configure({
    store,
    transport: {
      seatLive: (id) => id === bindingId && live,
      wakeSeat: async (id, wakeCanvas, wakeNode) => {
        wakes.push({ bindingId: id, canvas: wakeCanvas, nodeId: wakeNode });
        await new Promise((resolve) => setTimeout(resolve, 1));
        return options.wake?.() ?? false;
      },
      writeMail: async (_id, text) => {
        writing += 1;
        if (writing > 1) overlapped = true;
        await new Promise((resolve) => setTimeout(resolve, 2));
        writing -= 1;
        if (options.writeOk && !options.writeOk()) return false;
        writes.push(text);
        return true;
      },
    },
  });
  services.push(service);
  return {
    service,
    writes,
    wakes,
    messages,
    append: (message: Message) => messages.push(message),
    setLive: (next: boolean) => {
      live = next;
    },
    overlapped: () => overlapped,
  };
};

const services: MessageDeliveryService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.suspend();
});

const settle = async (): Promise<void> => {
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 2));
};

describe("mail delivery", () => {
  it("types a notice into a live seat at once and stamps its receipt", async () => {
    const seat = rig();
    seat.append(mail("01A", "Please review the contract."));

    expect(await seat.service.deliver(canvas, nodeId, "01A")).toBe("delivered");

    expect(seat.writes).toHaveLength(1);
    expect(seat.writes[0]).toContain("mail from Claude Code");
    expect(seat.writes[0]).toContain("junto msg read 01A");
    expect(seat.messages[0]?.metadata?.deliveredAt).toBeTypeOf("number");
  });

  it("types a prompt's full text, however long", async () => {
    const seat = rig();
    const body = `Review this. ${"x".repeat(400)}`;
    seat.append(mail("01A", body, "prompt"));

    expect(await seat.service.deliver(canvas, nodeId, "01A")).toBe("delivered");

    expect(seat.writes).toEqual([`mail from Claude Code\n${body}`]);
  });

  it("shares one flight between the append and the sender, so the sender is never refused", async () => {
    // The 2026-09-24 trial: msg send --prompt appended, the append started
    // its own delivery, and the sender's call was refused SeatBusy.
    const seat = rig();
    const message = mail("01A", "Hi, reply by mail.", "prompt");
    seat.append(message);

    seat.service.notifyAppended(canvas, nodeId, message);
    const sender = await seat.service.deliver(canvas, nodeId, "01A");

    expect(sender).toBe("delivered");
    await settle();
    expect(seat.writes).toHaveLength(1);
  });

  it("never types a delivered message twice", async () => {
    const seat = rig();
    seat.append(mail("01A", "once"));
    await seat.service.deliver(canvas, nodeId, "01A");

    expect(await seat.service.deliver(canvas, nodeId, "01A")).toBe("delivered");
    seat.service.onSeatLive(bindingId);
    await settle();

    expect(seat.writes).toHaveLength(1);
  });

  it("waits for a seat that is not up and types the mail when it starts", async () => {
    const seat = rig({ live: false });
    seat.append(mail("01A", "first"));
    seat.append(mail("01B", "second"));

    expect(await seat.service.deliver(canvas, nodeId, "01A")).toBe("waiting");
    expect(await seat.service.deliver(canvas, nodeId, "01B")).toBe("waiting");
    expect(seat.writes).toHaveLength(0);

    seat.setLive(true);
    seat.service.onSeatLive(bindingId);
    await settle();

    expect(seat.writes.map((text) => text.includes("01A") ? "A" : "B")).toEqual(["A", "B"]);
    expect(seat.overlapped()).toBe(false);
    expect(seat.messages.every((m) => typeof m.metadata?.deliveredAt === "number")).toBe(true);
  });

  it("starts a down seat once for all the mail waiting on it", async () => {
    const seat = rig({ live: false, wake: () => true });
    seat.append(mail("01A", "first"));
    seat.append(mail("01B", "second"));

    await Promise.all([
      seat.service.deliver(canvas, nodeId, "01A"),
      seat.service.deliver(canvas, nodeId, "01B"),
    ]);

    expect(seat.wakes).toEqual([{ bindingId, canvas, nodeId }]);
    expect(seat.writes).toHaveLength(0);

    // The started seat's TUI comes up: the mail is typed then, in order.
    seat.setLive(true);
    seat.service.onSeatLive(bindingId);
    await settle();
    expect(seat.writes.map((text) => text.includes("01A") ? "A" : "B")).toEqual(["A", "B"]);
  });

  it("never starts a seat for mail its sender held back from waking", async () => {
    const seat = rig({ live: false, wake: () => true });
    seat.service.holdWake("01A");
    seat.append(mail("01A", "stop"));

    expect(await seat.service.deliver(canvas, nodeId, "01A")).toBe("waiting");
    await settle();
    expect(seat.wakes).toHaveLength(0);

    // Still written if the seat comes up some other way.
    seat.setLive(true);
    seat.service.onSeatLive(bindingId);
    await settle();
    expect(seat.writes).toHaveLength(1);
  });

  it("keeps mail queued while paused and starts the seat when play resumes", async () => {
    // A paused canvas refuses the wake; play retries the waiting mail.
    const seat = rig({ live: false, wake: () => false });
    seat.append(mail("01A", "held"));
    expect(await seat.service.deliver(canvas, nodeId, "01A")).toBe("waiting");
    await settle();
    expect(seat.wakes).toHaveLength(1);

    seat.service.onResumed("other-canvas");
    await settle();
    expect(seat.wakes).toHaveLength(1);

    seat.service.onResumed(canvas);
    await settle();
    expect(seat.wakes).toHaveLength(2);
    expect(seat.writes).toHaveLength(0);
  });

  it("keeps mail waiting when the seat died during the write, and types it on restart", async () => {
    let dead = true;
    const seat = rig({ writeOk: () => !dead });
    seat.append(mail("01A", "survives"));

    expect(await seat.service.deliver(canvas, nodeId, "01A")).toBe("waiting");

    dead = false;
    seat.service.onSeatLive(bindingId);
    await settle();
    expect(seat.writes).toHaveLength(1);
  });

  it("writes into one seat one message at a time, in send order", async () => {
    const seat = rig();
    for (const id of ["01A", "01B", "01C"]) seat.append(mail(id, id));

    const states = await Promise.all(
      ["01A", "01B", "01C"].map((id) => seat.service.deliver(canvas, nodeId, id)),
    );

    expect(states).toEqual(["delivered", "delivered", "delivered"]);
    expect(seat.overlapped()).toBe(false);
    expect(seat.writes.map((text) => text.match(/01[ABC]/)?.[0])).toEqual(["01A", "01B", "01C"]);
  });

  it("delivers the backlog at boot and leaves mail for a seat that is not up waiting", async () => {
    const seat = rig({ live: false });
    seat.append(mail("01A", "from before"));

    await seat.service.onBooted();
    await settle();
    expect(seat.writes).toHaveLength(0);

    seat.setLive(true);
    seat.service.onSeatLive(bindingId);
    await settle();
    expect(seat.writes).toHaveLength(1);
  });

  it("tells wire-traffic listeners once per message typed into a seat", async () => {
    const seat = rig();
    const events: unknown[] = [];
    seat.service.subscribeDelivered((event) => events.push(event));
    seat.append(mail("01A", "rebase is done"));

    await seat.service.deliver(canvas, nodeId, "01A");
    await seat.service.deliver(canvas, nodeId, "01A");

    expect(events).toEqual([
      expect.objectContaining({
        canvasName: canvas,
        toNodeId: nodeId,
        fromNodeId: "agent-a",
        fromName: "Claude Code",
        kind: "notice",
        messageId: "01A",
        preview: "rebase is done",
      }),
    ]);
  });

  it("tells wire-traffic listeners nothing for mail still waiting", async () => {
    const seat = rig({ live: false });
    const events: unknown[] = [];
    seat.service.subscribeDelivered((event) => events.push(event));
    seat.append(mail("01A", "later"));
    await seat.service.deliver(canvas, nodeId, "01A");
    expect(events).toEqual([]);
  });

  it("tells a failed write into a live seat once, then the delivery when it lands", async () => {
    let ok = false;
    const seat = rig({ writeOk: () => ok });
    const events: Array<{ failed?: true; messageId: string }> = [];
    seat.service.subscribeDelivered((event) => events.push(event));
    seat.append(mail("01A", "rebase is done"));

    expect(await seat.service.deliver(canvas, nodeId, "01A")).toBe("waiting");
    expect(await seat.service.deliver(canvas, nodeId, "01A")).toBe("waiting");
    expect(events).toEqual([expect.objectContaining({ messageId: "01A", failed: true })]);

    ok = true;
    expect(await seat.service.deliver(canvas, nodeId, "01A")).toBe("delivered");
    expect(events).toHaveLength(2);
    expect(events[1]?.failed).toBeUndefined();
  });

  it("writes nothing after suspend", async () => {
    const seat = rig();
    seat.append(mail("01A", "late"));
    seat.service.suspend();

    expect(await seat.service.deliver(canvas, nodeId, "01A")).toBe("waiting");
    expect(seat.writes).toHaveLength(0);
  });

  it("pushes a request answer now, or when the raising seat starts", async () => {
    const seat = rig({ live: false });
    seat.service.notifyRequestResolved({
      canvas,
      actorNodeId: nodeId,
      requestId: "req-1",
      response: "Use the v2 schema.",
    });
    await settle();
    expect(seat.writes).toHaveLength(0);

    seat.setLive(true);
    seat.service.onSeatLive(bindingId);
    await settle();
    expect(seat.writes).toEqual(["[request resolved - req-1] Use the v2 schema."]);
  });
});
