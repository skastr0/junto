import { afterEach, describe, expect, it, vi } from "vitest";
import type { CanvasDoc, Message } from "../src/shared/canvas";
import { mailExtensionMetadata, type MailExtension, type MailKind } from "../src/shared/crew";
import {
  MAIL_HELD_RETRY_MS,
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
    /** Why the seat's input box is not available, if it is not. */
    held?: () => "draft" | "dialog" | "unreadable" | undefined;
    /** Wake result; the default leaves the seat down (paused canvas). */
    wake?: () => boolean;
    /** The supervisor's answer to "did this seat run junto onboard". */
    onboarded?: (bindingId: string) => boolean;
    /** Auto offboard at delivery: true when the seat's cold session was just ended. */
    cut?: (bindingId: string, canvas: string, nodeId: string) => Promise<boolean>;
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
      ...(options.onboarded ? { seatOnboarded: options.onboarded } : {}),
      ...(options.cut ? { cutColdSession: options.cut } : {}),
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
        const hold = options.held?.();
        if (hold !== undefined) return hold;
        if (options.writeOk && !options.writeOk()) return "lost";
        writes.push(text);
        return "written";
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
  it("mail to a seat whose cold session was just ended is not typed into it: it wakes the fresh one", async () => {
    let cold = true;
    const cuts: Array<[string, string, string]> = [];
    const seat = rig({
      cut: async (id, cutCanvas, cutNode) => {
        cuts.push([id, cutCanvas, cutNode]);
        if (!cold) return false;
        cold = false;
        // The old session is gone: the seat is no longer up.
        seat.setLive(false);
        return true;
      },
      wake: () => true,
    });
    seat.append(mail("01A", "Please review the contract."));
    expect(await seat.service.deliver(canvas, nodeId, "01A")).toBe("waiting");
    expect(cuts).toEqual([[bindingId, canvas, nodeId]]);
    expect(seat.writes).toEqual([]);
    await settle();
    expect(seat.wakes).toEqual([{ bindingId, canvas, nodeId }]);
    // The fresh session comes up: the same mail is written there, once.
    seat.setLive(true);
    seat.service.onSeatLive(bindingId);
    await settle();
    expect(seat.writes).toHaveLength(1);
    expect(seat.writes[0]).toContain("junto msg read 01A");
    expect(seat.messages[0]?.metadata?.deliveredAt).toBeTypeOf("number");
  });

  it("two messages arriving together for one cold seat: neither is typed until the fresh session is up, then both in order", async () => {
    let calls = 0;
    const seat = rig({
      cut: async () => {
        calls += 1;
        const mine = calls;
        // The first asker cuts the session; the second finds it already cut.
        await new Promise((resolve) => setTimeout(resolve, mine === 1 ? 1 : 3));
        if (mine === 1) {
          seat.setLive(false);
          return true;
        }
        return false;
      },
      wake: () => true,
    });
    seat.append(mail("01A", "First."));
    seat.append(mail("01B", "Second."));
    const [first, second] = await Promise.all([
      seat.service.deliver(canvas, nodeId, "01A"),
      seat.service.deliver(canvas, nodeId, "01B"),
    ]);
    expect([first, second]).toEqual(["waiting", "waiting"]);
    await settle();
    // Nothing was typed into a seat that is down, and nothing reads as lost.
    expect(seat.writes).toEqual([]);
    // Each waiting message may ask for the wake; the transport answers a
    // seat that is already starting without starting it twice.
    expect(seat.wakes.length).toBeGreaterThanOrEqual(1);
    expect(seat.wakes.every((wake) => wake.bindingId === bindingId)).toBe(true);
    seat.setLive(true);
    seat.service.onSeatLive(bindingId);
    await settle();
    expect(seat.writes).toHaveLength(2);
    expect(seat.writes[0]).toContain("junto msg read 01A");
    expect(seat.writes[1]).toContain("junto msg read 01B");
    expect(seat.overlapped()).toBe(false);
  });

  it("a session that is not cold, or a check that fails, changes nothing: the mail is typed as usual", async () => {
    const warm = rig({ cut: async () => false });
    warm.append(mail("01A", "Please review the contract."));
    expect(await warm.service.deliver(canvas, nodeId, "01A")).toBe("delivered");
    expect(warm.writes).toHaveLength(1);
    expect(warm.wakes).toEqual([]);

    const broken = rig({
      cut: async () => {
        throw new Error("offboard gone");
      },
    });
    broken.append(mail("01B", "Please review the contract."));
    expect(await broken.service.deliver(canvas, nodeId, "01B")).toBe("delivered");
    expect(broken.writes).toHaveLength(1);
  });

  it("adds the onboard pointer to the line while the seat has not onboarded, and drops it after", async () => {
    let onboarded = false;
    const asked: string[] = [];
    const seat = rig({
      onboarded: (id) => {
        asked.push(id);
        return onboarded;
      },
    });
    seat.append(mail("01A", "Please review the contract."));
    await seat.service.deliver(canvas, nodeId, "01A");
    onboarded = true;
    seat.append(mail("01B", "Second note."));
    await seat.service.deliver(canvas, nodeId, "01B");
    // One write per message: the pointer is part of the line, not extra mail.
    expect(seat.writes).toHaveLength(2);
    expect(seat.writes[0]).toMatch(/^mail from Claude Code — .* — junto msg read 01A — new to this seat\? run `junto onboard` first$/);
    expect(seat.writes[1]).not.toContain("junto onboard");
    expect(asked).toEqual([bindingId, bindingId]);
  });

  it("a prompt to a seat that has not onboarded carries the pointer on its first line", async () => {
    const seat = rig({ onboarded: () => false });
    seat.append(mail("01A", "Review the patch", "prompt"));
    await seat.service.deliver(canvas, nodeId, "01A");
    expect(seat.writes).toEqual([
      "mail from Claude Code — new to this seat? run `junto onboard` first\nReview the patch",
    ]);
  });

  it("sends no pointer without a lookup, and a lookup that throws never costs the delivery", async () => {
    const plain = rig();
    plain.append(mail("01A", "Please review the contract."));
    await plain.service.deliver(canvas, nodeId, "01A");
    expect(plain.writes[0]).not.toContain("junto onboard");
    const broken = rig({
      onboarded: () => {
        throw new Error("supervisor gone");
      },
    });
    broken.append(mail("01B", "Please review the contract."));
    expect(await broken.service.deliver(canvas, nodeId, "01B")).toBe("delivered");
    expect(broken.writes[0]).not.toContain("junto onboard");
  });

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

  it("holds mail while the operator drafts, tells no failure, and types it in order after", async () => {
    let drafting = true;
    const seat = rig({ held: () => (drafting ? "draft" : undefined) });
    const events: Array<{ failed?: true; held?: string; messageId: string }> = [];
    seat.service.subscribeDelivered((event) => events.push(event));
    seat.append(mail("01A", "first"));
    seat.append(mail("01B", "second"));

    expect(await seat.service.deliver(canvas, nodeId, "01A")).toBe("waiting");
    expect(await seat.service.deliver(canvas, nodeId, "01A")).toBe("waiting");
    expect(await seat.service.deliver(canvas, nodeId, "01B")).toBe("waiting");
    expect(seat.writes).toHaveLength(0);
    // Told held once per message, never as a failure.
    expect(events.map((event) => [event.messageId, event.held, event.failed])).toEqual([
      ["01A", "draft", undefined],
      ["01B", "draft", undefined],
    ]);
    events.length = 0;
    expect(seat.messages[0]?.metadata?.deliveredAt).toBeUndefined();

    drafting = false;
    seat.service.onSeatLive(bindingId);
    await settle();
    expect(seat.writes).toHaveLength(2);
    expect(seat.writes[0]).toContain("junto msg read 01A");
    expect(seat.writes[1]).toContain("junto msg read 01B");
    expect(events.map((event) => event.messageId)).toEqual(["01A", "01B"]);
  });

  it("tells a dialog hold again every minute, retries by itself, and types the mail once the box is free", async () => {
    vi.useFakeTimers();
    let hold: "dialog" | "unreadable" | undefined = "dialog";
    const seat = rig({ held: () => hold });
    const events: Array<{ held?: string; messageId: string }> = [];
    seat.service.subscribeDelivered((event) => events.push(event));
    seat.append(mail("01A", "first"));

    const first = seat.service.deliver(canvas, nodeId, "01A");
    await vi.advanceTimersByTimeAsync(50);
    expect(await first).toBe("waiting");
    expect(events.map((event) => event.held)).toEqual(["dialog"]);

    // Nothing announces the box: the minute retry finds it still held and says so again.
    await vi.advanceTimersByTimeAsync(MAIL_HELD_RETRY_MS + 50);
    expect(events.map((event) => event.held)).toEqual(["dialog", "dialog"]);
    // A changed reason is told at once on the next attempt.
    hold = "unreadable";
    const again = seat.service.deliver(canvas, nodeId, "01A");
    await vi.advanceTimersByTimeAsync(50);
    expect(await again).toBe("waiting");
    expect(events.map((event) => event.held)).toEqual(["dialog", "dialog", "unreadable"]);
    expect(seat.writes).toHaveLength(0);

    // The box frees up and no release signal arrives: the retry still delivers.
    hold = undefined;
    await vi.advanceTimersByTimeAsync(MAIL_HELD_RETRY_MS + 50);
    expect(seat.writes).toHaveLength(1);
    expect(events.at(-1)?.held).toBeUndefined();
    expect(seat.messages[0]?.metadata?.deliveredAt).toBeTypeOf("number");
    vi.useRealTimers();
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
