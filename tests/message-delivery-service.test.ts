import { canvasOf, region, seat } from "./support/model-nodes";
import { asNodeId } from "../src/shared/model";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message } from "../src/shared/work-model";
import { mailExtensionMetadata, type MailExtension, type MailKind } from "../src/shared/crew";
import {
  MAIL_BATCHING,
  MAIL_HELD_RETRY_MS,
  MAIL_PASS_CHUNK,
  MessageDeliveryService,
  type MailBatching,
  type MessageDeliveryStore,
} from "../src/main/junto/work/message-delivery";
import { composeMailBatch, MAIL_BATCH_BODY_MAX, MAIL_TYPED_BODY_MAX } from "../src/shared/message-delivery";
import { OTHER_MACHINE, THIS_MACHINE } from "./support/machines";

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

const crew = canvasOf(
  [seat(nodeId, { width: 100, height: 80, label: "Claude Code", agentKey: "local:claude", bindingId: bindingId as never })],
  [],
  "crew",
);

/**
 * One canvas whose mailbox the test appends to, a receipt plane that stamps
 * `deliveredAt` like the real projection, and a seat the test turns on/off.
 */
const rig = (
  options: {
    /** The canvas the store holds; the crew canvas unless the test says so. */
    canvas?: typeof crew;
    live?: boolean;
    writeOk?: () => boolean;
    /** Why the seat's input box is not available, if it is not. */
    held?: () => "draft" | "dialog" | "unreadable" | undefined;
    /** Wake result; the default leaves the seat down (paused canvas). */
    wake?: () => boolean;
    /** The supervisor's answer to "did this seat run junto onboard". */
    onboarded?: (bindingId: string) => boolean;
    /** How mail gathers; a short window unless the test is about gathering. */
    batching?: MailBatching;
    /** How long one write takes to type. */
    writeMs?: number;
  } = {},
) => {
  const messages: Message[] = [];
  let live = options.live ?? true;
  const writes: string[] = [];
  let writing = 0;
  let overlapped = false;
  const wakes: Array<{ bindingId: string; canvas: string; nodeId: string }> = [];
  let modelReads = 0;
  const store: MessageDeliveryStore = {
    listCanvasNames: async () => [canvas],
    readModel: async () => {
      modelReads += 1;
      await new Promise((resolve) => setTimeout(resolve, 1));
      return options.canvas ?? crew;
    },
    readMessage: async (_canvas, _nodeId, messageId) => messages.find((message) => message.messageId === messageId),
    listMail: async () => messages,
    acceptMessageDelivery: async (_canvas, _node, messageId, read) => {
      const index = messages.findIndex((m) => m.messageId === messageId);
      messages[index] = {
        ...messages[index]!,
        metadata: { ...messages[index]!.metadata, deliveredAt: Date.now(), ...(read ? { readAt: Date.now() } : {}) },
      };
      return true;
    },
  };
  const service = new MessageDeliveryService(() => THIS_MACHINE, options.batching ?? { quietMs: 10, maxWaitMs: 50 });
  service.configure({
    store,
    transport: {
      seatLive: (id) => id === bindingId && live,
      ...(options.onboarded ? { seatOnboarded: options.onboarded } : {}),
      wakeSeat: async (id, wakeCanvas, wakeNode) => {
        wakes.push({ bindingId: id, canvas: wakeCanvas, nodeId: wakeNode });
        await new Promise((resolve) => setTimeout(resolve, 1));
        return options.wake?.() ?? false;
      },
      writeMail: async (_id, text) => {
        writing += 1;
        if (writing > 1) overlapped = true;
        await new Promise((resolve) => setTimeout(resolve, options.writeMs ?? 2));
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
    modelReads: () => modelReads,
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
  describe("to a seat on another machine", () => {
    /** The same seat, placed on a machine this one is not; its terminal would even answer as live here. */
    const elsewhere = canvasOf(
      [seat(nodeId, { width: 100, height: 80, label: "Claude Code", host: OTHER_MACHINE as never, agentKey: "local:claude", bindingId: bindingId as never })],
      [],
      "crew",
    );

    it("is not typed, and does not start the seat or stamp a receipt", async () => {
      const away = rig({ canvas: elsewhere, live: true, wake: () => true });
      away.append(mail("01A", "for the other machine"));
      expect(await away.service.deliver(canvas, nodeId, "01A")).toBe("held");
      await settle();
      expect(away.writes).toEqual([]);
      expect(away.wakes).toEqual([]);
      expect(away.messages[0]!.metadata?.deliveredAt).toBeUndefined();
    });

    it("is left alone by the boot scan and by a seat coming up here", async () => {
      const away = rig({ canvas: elsewhere, live: true, wake: () => true });
      away.append(mail("01A", "for the other machine"));
      await away.service.onBooted();
      away.service.onSeatLive(bindingId);
      await settle();
      expect(away.writes).toEqual([]);
      expect(away.wakes).toEqual([]);
    });

    it("is not typed into a peer, the seat as a copy of the canvas holds it", async () => {
      const copy = canvasOf(
        [{
          kind: "peer", id: asNodeId(nodeId), x: 0, y: 0, width: 100, height: 80, z: 0,
          label: "Claude Code" as never, host: OTHER_MACHINE as never, seatId: SENDER as never,
        }],
        [],
        "crew",
      );
      const away = rig({ canvas: copy, live: true, wake: () => true });
      away.append(mail("01A", "for the other machine"));
      // Mail for another machine is no fault here: nothing is reported as one.
      const faults = vi.spyOn(console, "error").mockImplementation(() => undefined);
      expect(await away.service.deliver(canvas, nodeId, "01A")).toBe("held");
      expect(faults).not.toHaveBeenCalled();
      faults.mockRestore();
      await away.service.onBooted();
      await settle();
      expect(away.writes).toEqual([]);
      expect(away.wakes).toEqual([]);
      expect(away.messages[0]!.metadata?.deliveredAt).toBeUndefined();
    });

    it("tells its sender it was handed to a link when one is open on its way, and held when none is", async () => {
      const away = rig({ canvas: elsewhere, live: true, wake: () => true });
      away.append(mail("01A", "for the other machine"));
      away.append(mail("01B", "for the other machine"));
      const asked: string[] = [];
      let open = true;
      away.service.followLinks(async (askedCanvas, askedNode) => {
        asked.push(`${askedCanvas}/${askedNode}`);
        return open;
      });
      expect(await away.service.deliver(canvas, nodeId, "01A")).toBe("handed");
      open = false;
      expect(await away.service.deliver(canvas, nodeId, "01B")).toBe("held");
      expect(asked).toEqual([`${canvas}/${nodeId}`, `${canvas}/${nodeId}`]);
      expect(away.writes).toEqual([]);
    });

    it("sends a mail's files toward the seat's machine each time it is routed there, and none with no files", async () => {
      const away = rig({ canvas: elsewhere, live: true, wake: () => true });
      const ref = { sha256: "a".repeat(64), byteLength: 3, mediaType: "image/png", displayName: "shot.png" };
      const withFile = mail("01A", "a picture");
      away.append({ ...withFile, metadata: { ...withFile.metadata, attachments: [ref] } });
      away.append(mail("01B", "no picture"));
      const sent: Array<[string, unknown]> = [];
      away.service.followFiles((machine, files) => sent.push([machine, files]));
      away.service.followLinks(async () => false);
      expect(await away.service.deliver(canvas, nodeId, "01A")).toBe("held");
      expect(await away.service.deliver(canvas, nodeId, "01A")).toBe("held");
      expect(await away.service.deliver(canvas, nodeId, "01B")).toBe("held");
      expect(sent).toEqual([[OTHER_MACHINE, [ref]], [OTHER_MACHINE, [ref]]]);
    });

    it("is typed once the seat is on this machine", async () => {
      const away = rig({ canvas: elsewhere, live: true });
      away.append(mail("01A", "for whoever runs the seat"));
      expect(await away.service.deliver(canvas, nodeId, "01A")).toBe("held");
      const here = rig({ live: true });
      here.append(mail("01A", "for whoever runs the seat"));
      expect(await here.service.deliver(canvas, nodeId, "01A")).toBe("delivered");
      expect(here.writes).toHaveLength(1);
    });
  });

  it("runs no cut at delivery: a running seat takes the mail in the session it has, a resting one is only asked to start", async () => {
    const running = rig({ live: true });
    running.append(mail("01A", "Please review the contract."));
    expect(await running.service.deliver(canvas, nodeId, "01A")).toBe("delivered");
    expect(running.writes).toHaveLength(1);
    expect(running.wakes).toEqual([]);

    // An answer to the seat's signal is mail to the seat like any other.
    const resting = rig({ live: false, wake: () => true });
    const answer = mail("01B", "Use the second option.", "prompt");
    resting.append({ ...answer, metadata: { ...answer.metadata, agentSignalId: "signal-1" } });
    resting.append(mail("01C", "Please review the contract."));
    expect(await resting.service.deliver(canvas, nodeId, "01B")).toBe("waiting");
    await settle();
    expect(resting.wakes).toEqual([{ bindingId, canvas, nodeId }]);
    expect(resting.writes).toEqual([]);
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
    expect(seat.writes[0]).toMatch(/^mail from Claude Code, id 01A — reply: .* — new to this seat\? run `junto onboard` first\nPlease review the contract\.$/u);
    expect(seat.writes[1]).not.toContain("junto onboard");
    expect(asked).toEqual([bindingId, bindingId]);
  });

  it("a prompt to a seat that has not onboarded carries the pointer on its first line", async () => {
    const seat = rig({ onboarded: () => false });
    seat.append(mail("01A", "Review the patch", "prompt"));
    await seat.service.deliver(canvas, nodeId, "01A");
    expect(seat.writes).toHaveLength(1);
    expect(seat.writes[0]).toMatch(/^mail from Claude Code, id 01A — reply: .* — new to this seat\? run `junto onboard` first\nReview the patch$/u);
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

  it("types a notice whole into a live seat at once, stamps its receipt, and marks it read", async () => {
    const seat = rig();
    seat.append(mail("01A", "Please review the contract."));

    expect(await seat.service.deliver(canvas, nodeId, "01A")).toBe("delivered");

    expect(seat.writes).toEqual([
      `mail from Claude Code, id 01A — reply: junto msg reply '{"target":"agent-a","inReplyTo":"01A","text":"..."}'\nPlease review the contract.`,
    ]);
    expect(seat.messages[0]?.metadata?.deliveredAt).toBeTypeOf("number");
    expect(seat.messages[0]?.metadata?.readAt).toBeTypeOf("number");
  });

  it("names the sender as the canvas does at delivery, with every region around it", async () => {
    const regioned = canvasOf(
      [
        region("outer", { x: 0, y: 0, width: 2000, height: 2000 }, { label: "Junto" }),
        region("inner", { x: 500, y: 500, width: 400, height: 400 }, { label: "CLI" }),
        seat(nodeId, { width: 100, height: 80, label: "Claude Code", agentKey: "local:claude", bindingId: bindingId as never }),
        seat("agent-a", { x: 600, y: 600, width: 100, height: 80, label: "cli-lead", agentKey: "local:a", bindingId: "bind-a" as never }),
      ],
      [],
      "crew",
    );
    const seat_ = rig({ canvas: regioned });
    seat_.append(mail("01A", "Please review the contract."));
    await seat_.service.deliver(canvas, nodeId, "01A");
    expect(seat_.writes[0]).toMatch(/^mail from cli-lead \(Junto \/ CLI\), id 01A — reply: junto msg reply '\{"target":"agent-a",/u);
  });

  it("leaves a notice cut at the cap unread, so the rest is still waiting in the mailbox", async () => {
    const seat = rig();
    seat.append(mail("01A", "x".repeat(MAIL_TYPED_BODY_MAX + 1)));
    expect(await seat.service.deliver(canvas, nodeId, "01A")).toBe("delivered");
    expect(seat.writes[0]).toContain("the rest: junto msg read 01A");
    expect(seat.messages[0]?.metadata?.deliveredAt).toBeTypeOf("number");
    expect(seat.messages[0]?.metadata?.readAt).toBeUndefined();
  });

  it("marks nothing read when the write did not land", async () => {
    const seat = rig({ writeOk: () => false });
    seat.append(mail("01A", "Please review the contract."));
    expect(await seat.service.deliver(canvas, nodeId, "01A")).toBe("waiting");
    expect(seat.messages[0]?.metadata?.readAt).toBeUndefined();
    expect(seat.messages[0]?.metadata?.deliveredAt).toBeUndefined();
  });

  it("types a prompt's full text, however long, and marks it read", async () => {
    const seat = rig();
    const body = `Review this. ${"x".repeat(MAIL_TYPED_BODY_MAX + 400)}`;
    seat.append(mail("01A", body, "prompt"));

    expect(await seat.service.deliver(canvas, nodeId, "01A")).toBe("delivered");

    expect(seat.writes).toHaveLength(1);
    expect(seat.writes[0]).toMatch(/^mail from Claude Code, id 01A — reply: junto msg reply '[^\n]*'\n/u);
    expect(seat.writes[0]?.endsWith(`\n${body}`)).toBe(true);
    expect(seat.messages[0]?.metadata?.readAt).toBeTypeOf("number");
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

  it("waits for a seat that is not up and types the mail when it starts, as one turn", async () => {
    const seat = rig({ live: false });
    seat.append(mail("01A", "first"));
    seat.append(mail("01B", "second"));

    expect(await seat.service.deliver(canvas, nodeId, "01A")).toBe("waiting");
    expect(await seat.service.deliver(canvas, nodeId, "01B")).toBe("waiting");
    expect(seat.writes).toHaveLength(0);

    seat.setLive(true);
    seat.service.onSeatLive(bindingId);
    await settle();

    expect(seat.writes).toHaveLength(1);
    expect(seat.writes[0]).toMatch(/^2 mails, oldest first\n\nmail from Claude Code, id 01A\b[^]*\n\nmail from Claude Code, id 01B\b/u);
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

    // The started seat's TUI comes up: the mail is typed then, one turn, in order.
    seat.setLive(true);
    seat.service.onSeatLive(bindingId);
    await settle();
    expect(seat.writes).toHaveLength(1);
    expect(seat.writes[0]!.indexOf("id 01A")).toBeLessThan(seat.writes[0]!.indexOf("id 01B"));
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

  it("types mail sent together into one seat as one turn, in send order", async () => {
    const seat = rig();
    for (const id of ["01C", "01A", "01B"]) seat.append(mail(id, id));

    const states = await Promise.all(
      ["01C", "01A", "01B"].map((id) => seat.service.deliver(canvas, nodeId, id)),
    );

    expect(states).toEqual(["delivered", "delivered", "delivered"]);
    expect(seat.overlapped()).toBe(false);
    expect(seat.writes).toHaveLength(1);
    expect([...seat.writes[0]!.matchAll(/, id (01[ABC])\b/gu)].map((match) => match[1])).toEqual(["01A", "01B", "01C"]);
  });

  describe("a seat with a large backlog", () => {
    const backlog = (count: number) => Array.from({ length: count }, (_, index) => `01${String(index).padStart(5, "0")}`);
    const indexed = async (seat: ReturnType<typeof rig>, ids: ReadonlyArray<string>) => {
      for (const id of ids) seat.append(mail(id, id));
      await seat.service.onBooted();
      await settle();
    };

    it("tries only its oldest mail while it is starting, so its start is not held behind the rest", async () => {
      const seat = rig({ live: false, wake: () => false });
      await indexed(seat, backlog(2_000));
      const before = seat.modelReads();

      seat.service.onSeatLive(bindingId);
      await settle();

      // One attempt, which asks for the wake again; every mail stays waiting.
      expect(seat.modelReads() - before).toBe(1);
      expect(seat.wakes).toHaveLength(2);
      expect(seat.writes).toHaveLength(0);
    });

    it("tries its oldest mail that may wake it, past held-back mail, so the mail behind still starts it", async () => {
      const seat = rig({ live: false, wake: () => false });
      const ids = backlog(3);
      seat.service.holdWake(ids[0]!);
      await indexed(seat, ids);
      const before = seat.modelReads();

      seat.service.onSeatLive(bindingId);
      await settle();

      expect(seat.modelReads() - before).toBe(1);
      expect(seat.wakes).toHaveLength(2);
      expect(seat.writes).toHaveLength(0);
    });

    it("starts its mail a chunk per turn once it is ready, and every mail lands in order", async () => {
      const seat = rig({ live: false, batching: { quietMs: 10, maxWaitMs: 60_000 } });
      const ids = backlog(2_000);
      await indexed(seat, ids);
      seat.setLive(true);
      const before = seat.modelReads();

      seat.service.onSeatLive(bindingId);
      await Promise.resolve();
      expect(seat.modelReads() - before).toBeLessThanOrEqual(MAIL_PASS_CHUNK);

      await vi.waitFor(() => expect(seat.messages.every((m) => typeof m.metadata?.deliveredAt === "number")).toBe(true),
        { timeout: 10_000 });
      const typed = seat.writes.flatMap((text) => [...text.matchAll(/, id (01\d{5})\b/gu)].map((match) => match[1]));
      expect(typed).toEqual(ids.slice(0, typed.length));
    });

    it("stops its walk when delivery is suspended in the middle of one, and types nothing", async () => {
      const seat = rig({ live: false });
      await indexed(seat, backlog(2_000));
      seat.setLive(true);
      const before = seat.modelReads();

      seat.service.onSeatLive(bindingId);
      await Promise.resolve();
      seat.service.suspend();
      await settle();

      expect(seat.modelReads() - before).toBe(MAIL_PASS_CHUNK);
      expect(seat.writes).toHaveLength(0);
    });

    it("stops its walk when the seat stops being ready, leaves the rest waiting, and types it when it is back", async () => {
      const seat = rig({ live: false, wake: () => false, batching: { quietMs: 10, maxWaitMs: 60_000 } });
      await indexed(seat, backlog(2_000));
      const wakesBefore = seat.wakes.length;
      seat.setLive(true);
      const before = seat.modelReads();

      seat.service.onSeatLive(bindingId);
      await Promise.resolve();
      seat.setLive(false);
      await settle();

      // Only the chunk already started was tried, and it asked for one wake, not one per mail.
      expect(seat.modelReads() - before).toBe(MAIL_PASS_CHUNK);
      expect(seat.wakes.length - wakesBefore).toBeLessThanOrEqual(1);
      expect(seat.writes).toHaveLength(0);

      seat.setLive(true);
      seat.service.onSeatLive(bindingId);
      await vi.waitFor(() => expect(seat.messages.every((m) => typeof m.metadata?.deliveredAt === "number")).toBe(true),
        { timeout: 10_000 });
    });
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
    expect(seat.writes).toHaveLength(1);
    expect([...seat.writes[0]!.matchAll(/, id (01[AB])\b/gu)].map((match) => match[1])).toEqual(["01A", "01B"]);
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

  describe("gathering mail for one seat into one turn", () => {
    afterEach(() => {
      vi.useRealTimers();
    });
    const gathering = (options: Parameters<typeof rig>[0] = {}) => {
      vi.useFakeTimers();
      return rig({ batching: MAIL_BATCHING, ...options });
    };
    const send = (seat: ReturnType<typeof rig>, message: Message): void => {
      seat.append(message);
      seat.service.notifyAppended(canvas, nodeId, message);
    };
    const ids = (text: string | undefined): ReadonlyArray<string> =>
      [...(text ?? "").matchAll(/^mail from [^\n]*?, id (\w+)/gmu)].map((match) => match[1]!);

    it("waits 2 s of quiet, then types a lone mail exactly as it is alone", async () => {
      const seat = gathering();
      send(seat, mail("01A", "alone"));
      await vi.advanceTimersByTimeAsync(MAIL_BATCHING.quietMs - 100);
      expect(seat.writes).toEqual([]);
      await vi.advanceTimersByTimeAsync(200);
      expect(seat.writes).toEqual([composeMailBatch([{ message: mail("01A", "alone") }], { onboarded: true }).text]);
      expect(seat.messages[0]?.metadata?.readAt).toBeTypeOf("number");
    });

    it("types a burst of five sends inside 2 s as exactly one turn: a count line, then each mail under its own header, oldest first", async () => {
      const seat = gathering();
      const burst = ["01A", "01B", "01C", "01D", "01E"].map((id) => mail(id, `burst ${id}`));
      for (const [index, message] of burst.entries()) {
        if (index > 0) await vi.advanceTimersByTimeAsync(400);
        send(seat, message);
      }
      await vi.advanceTimersByTimeAsync(MAIL_BATCHING.quietMs - 100);
      expect(seat.writes).toEqual([]);
      await vi.advanceTimersByTimeAsync(MAIL_BATCHING.maxWaitMs);

      expect(seat.writes).toEqual([composeMailBatch(burst.map((message) => ({ message }))).text]);
      expect(seat.writes[0]!.startsWith("5 mails, oldest first\n\n")).toBe(true);
      expect(seat.messages.every((message) => typeof message.metadata?.readAt === "number")).toBe(true);
    });

    it("types a steady trickle at most 10 s after its first mail", async () => {
      const seat = gathering();
      const every = MAIL_BATCHING.quietMs - 500;
      for (let index = 0; index < 10; index += 1) {
        send(seat, mail(`01${String.fromCharCode(65 + index)}`, `tick ${String(index)}`));
        await vi.advanceTimersByTimeAsync(every);
      }
      // 15 s of mail 1.5 s apart: the first turn left at 10 s, with what had come.
      expect(seat.writes).toHaveLength(1);
      expect(ids(seat.writes[0])).toEqual(["01A", "01B", "01C", "01D", "01E", "01F", "01G"]);
      await vi.advanceTimersByTimeAsync(MAIL_BATCHING.quietMs + 100);
      expect(seat.writes).toHaveLength(2);
      expect(ids(seat.writes[1])).toEqual(["01H", "01I", "01J"]);
    });

    it("past the cap, types each further mail as one line with its id and leaves it unread", async () => {
      const seat = gathering();
      const third = MAIL_BATCH_BODY_MAX / 3;
      for (const [id, fill] of [["01A", "a"], ["01B", "b"], ["01C", "c"]] as const) send(seat, mail(id, fill.repeat(third)));
      send(seat, mail("01D", "one more"));
      await vi.advanceTimersByTimeAsync(MAIL_BATCHING.quietMs + 100);

      expect(seat.writes).toHaveLength(1);
      expect(seat.writes[0]!.endsWith("\n\nmail from Claude Code, id 01D — junto msg read 01D")).toBe(true);
      expect(seat.messages.map((message) => [typeof message.metadata?.deliveredAt, typeof message.metadata?.readAt])).toEqual([
        ["number", "number"],
        ["number", "number"],
        ["number", "number"],
        ["number", "undefined"],
      ]);
    });

    it("gathers mail that arrives while a turn is being typed into the next turn, not one each", async () => {
      const seat = gathering({ writeMs: 5_000 });
      send(seat, mail("01A", "first"));
      await vi.advanceTimersByTimeAsync(MAIL_BATCHING.quietMs + 1_000);
      // 01A is being typed until 7 s. 01B's quiet ends at 5 s, behind that write;
      // 01C comes at 6 s and rides the same turn.
      send(seat, mail("01B", "second"));
      await vi.advanceTimersByTimeAsync(3_000);
      send(seat, mail("01C", "third"));
      await vi.advanceTimersByTimeAsync(20_000);

      expect(seat.writes.map(ids)).toEqual([["01A"], ["01B", "01C"]]);
      expect(seat.overlapped()).toBe(false);
    });

    it("holds every mail while the operator drafts, and types them as one turn once the box is free", async () => {
      let drafting = true;
      const seat = gathering({ held: () => (drafting ? "draft" : undefined) });
      send(seat, mail("01A", "first"));
      await vi.advanceTimersByTimeAsync(MAIL_BATCHING.quietMs + 100);
      send(seat, mail("01B", "second"));
      await vi.advanceTimersByTimeAsync(MAIL_BATCHING.quietMs + 100);
      send(seat, mail("01C", "third"));
      await vi.advanceTimersByTimeAsync(MAIL_BATCHING.quietMs + 100);
      expect(seat.writes).toEqual([]);

      drafting = false;
      seat.service.onSeatLive(bindingId);
      await vi.advanceTimersByTimeAsync(MAIL_BATCHING.quietMs + 100);
      expect(seat.writes.map(ids)).toEqual([["01A", "01B", "01C"]]);
    });

    it("types a prompt as its own turn, after the mail already gathering, and never into a batch", async () => {
      const seat = gathering();
      send(seat, mail("01A", "notice before"));
      await vi.advanceTimersByTimeAsync(500);
      send(seat, mail("01B", "the prompt", "prompt"));
      await vi.advanceTimersByTimeAsync(100);
      send(seat, mail("01C", "notice after"));
      await vi.advanceTimersByTimeAsync(MAIL_BATCHING.quietMs + 100);

      expect(seat.writes).toHaveLength(3);
      expect(ids(seat.writes[0])).toEqual(["01A"]);
      expect(seat.writes[1]).toMatch(/^mail from Claude Code, id 01B — reply: junto msg reply '[^\n]*'\nthe prompt$/u);
      expect(ids(seat.writes[2])).toEqual(["01C"]);
    });

    it("never types mail that was read while it gathered", async () => {
      const seat = gathering();
      send(seat, mail("01A", "read in time"));
      send(seat, mail("01B", "still new"));
      await vi.advanceTimersByTimeAsync(500);
      seat.messages[0] = { ...seat.messages[0]!, metadata: { ...seat.messages[0]!.metadata, readAt: Date.now() } };
      await vi.advanceTimersByTimeAsync(MAIL_BATCHING.quietMs + 100);

      expect(seat.writes.map(ids)).toEqual([["01B"]]);
    });

    it("types a gathered mail once, however many callers ask for it", async () => {
      const seat = gathering();
      send(seat, mail("01A", "once"));
      const asked = [seat.service.deliver(canvas, nodeId, "01A"), seat.service.deliver(canvas, nodeId, "01A")];
      seat.service.onSeatLive(bindingId);
      await vi.advanceTimersByTimeAsync(MAIL_BATCHING.quietMs + 100);

      expect(await Promise.all(asked)).toEqual(["delivered", "delivered"]);
      expect(seat.writes).toHaveLength(1);
    });

    it("answers the sender `delivered` once its turn is typed", async () => {
      const seat = gathering();
      seat.append(mail("01A", "waits for its turn"));
      let state: string | undefined;
      void seat.service.deliver(canvas, nodeId, "01A").then((answer) => {
        state = answer;
      });
      await vi.advanceTimersByTimeAsync(MAIL_BATCHING.quietMs - 100);
      expect(state).toBeUndefined();
      await vi.advanceTimersByTimeAsync(200);
      expect(state).toBe("delivered");
    });

    it("types nothing gathered after suspend, and answers its sender", async () => {
      const seat = gathering();
      seat.append(mail("01A", "gathering"));
      const asked = seat.service.deliver(canvas, nodeId, "01A");
      await vi.advanceTimersByTimeAsync(500);
      seat.service.suspend();
      await vi.advanceTimersByTimeAsync(MAIL_BATCHING.quietMs + 100);

      expect(await asked).toBe("waiting");
      expect(seat.writes).toEqual([]);
    });
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
