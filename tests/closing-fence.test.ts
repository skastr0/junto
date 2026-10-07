/**
 * The closing fence: from `junto offboard` accepted to the old process gone,
 * nothing is typed into the seat; what arrives in that window goes to the
 * fresh session (continue) or wakes the seat (rest), exactly once.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClosingFence, fencedWriter } from "../src/main/junto/term/closing-fence";
import { createManagedTerminalDrive } from "../src/main/junto/term/drive/managed-drive-factory";
import { InjectionSupervisor } from "../src/main/junto/term/injection-supervisor";
import { makeOnboardNudgeInterject } from "../src/main/junto/term/onboard-nudge-interject";
import { MessageDeliveryService, type MessageDeliveryStore } from "../src/main/junto/work/message-delivery";
import type { CanvasDoc, Message } from "../src/shared/canvas";
import { mailExtensionMetadata, type MailExtension } from "../src/shared/crew";
import { buildOnboardNudge } from "../src/shared/managed-terminal-injection";

afterEach(() => {
  vi.useRealTimers();
});

/** A binding whose live generation the test moves by hand. */
const fenceOn = (initial: string | undefined = "e1") => {
  const live: { epoch: string | undefined } = { epoch: initial };
  const fence = new ClosingFence();
  fence.setLiveGeneration(() => live.epoch);
  const lifted: string[] = [];
  fence.subscribeLifted((bindingId) => lifted.push(bindingId));
  return { fence, live, lifted };
};

describe("ClosingFence", () => {
  it("seals the session that offboarded, from the instant it is told", () => {
    const { fence } = fenceOn();
    expect(fence.sealed("b1")).toBe(false);
    fence.seal("b1");
    expect(fence.sealed("b1")).toBe(true);
    expect(fence.sealed("b2")).toBe(false);
  });

  it("lifts by itself when that process is gone, and says so once", () => {
    const { fence, live, lifted } = fenceOn();
    fence.seal("b1");
    live.epoch = undefined;
    expect(fence.sealed("b1")).toBe(false);
    expect(fence.sealed("b1")).toBe(false);
    expect(lifted).toEqual(["b1"]);
  });

  it("never holds the session that comes next", () => {
    const { fence, live, lifted } = fenceOn();
    fence.seal("b1");
    // The fresh generation is up on the same binding.
    live.epoch = "e2";
    expect(fence.sealed("b1")).toBe(false);
    expect(lifted).toEqual(["b1"]);
    // And stays open for it.
    expect(fence.sealed("b1")).toBe(false);
  });

  it("is released when the close failed before the process was stopped", () => {
    const { fence, lifted } = fenceOn();
    fence.seal("b1");
    fence.release("b1");
    expect(fence.sealed("b1")).toBe(false);
    fence.release("b1");
    expect(lifted).toEqual(["b1"]);
  });

  it("ignores a seat it cannot name", () => {
    const { fence } = fenceOn();
    expect(() => fence.seal(undefined)).not.toThrow();
    expect(() => fence.release(undefined)).not.toThrow();
  });
});

describe("nothing is typed into a sealed seat", () => {
  /** The real drive over a fenced writer, as the app builds it. */
  const sealedSeat = () => {
    vi.useFakeTimers({ now: 1_000_000 });
    const { fence, live, lifted } = fenceOn();
    const typed: string[] = [];
    const drive = createManagedTerminalDrive({
      write: fencedWriter(fence, (_bindingId: string, data: string) => {
        typed.push(data);
        return true;
      }, false),
      isSeatIdle: () => true,
      seatState: () => "idle" as const,
      onAttention: () => {},
      snapshot: () => ({ text: "", lines: [] as string[] }),
      composerVerdict: () => "empty" as const,
      harnessFor: () => "codex",
    });
    const settle = async (ms: number) => {
      await vi.advanceTimersByTimeAsync(ms);
      for (let i = 0; i < 8; i += 1) await Promise.resolve();
    };
    return { fence, live, lifted, typed, drive, settle };
  };

  it("mail: not a byte reaches the PTY, and the write does not report it as delivered", async () => {
    const { fence, typed, drive, settle } = sealedSeat();
    fence.seal("b1");
    const outcome = drive.writeMail("b1", "mail from A");
    await settle(2_000);
    expect(await outcome).not.toBe("written");
    expect(typed).toEqual([]);
    drive.resetForTest();
  });

  it("a prompt (a pulse, the continuation line, an overseer write): refused, nothing typed", async () => {
    const { fence, typed, drive, settle } = sealedSeat();
    fence.seal("b1");
    const outcome = drive.writePrompt("b1", "a prompt", { queueIfBusy: false });
    await settle(2_000);
    expect((await outcome).status).not.toBe("submitted");
    expect(typed).toEqual([]);
    drive.resetForTest();
  });

  it("the onboarding nudge: refused before the drive is asked, and never typed", async () => {
    const { fence, typed, drive, settle } = sealedSeat();
    const supervisor = new InjectionSupervisor();
    const outcomes: string[] = [];
    const interject = makeOnboardNudgeInterject({
      suspended: () => false,
      sealed: (bindingId) => fence.sealed(bindingId),
      mailReady: () => true,
      writeMail: (bindingId, text) => drive.writeMail(bindingId, text),
    });
    supervisor.setWriter((bindingId, text) =>
      interject(bindingId, text).then((outcome) => {
        outcomes.push(outcome);
        return outcome === "written";
      }),
    );
    supervisor.noteSeatState({ bindingId: "b1", epoch: "e1", state: "working", reason: "t", confidence: "high", at: 0 });
    await settle(1);
    fence.seal("b1");
    // A first message makes a nudge due in this very turn.
    supervisor.noteMailWritten("b1");
    await settle(2_000);
    expect(outcomes).toEqual(["unavailable"]);
    expect(typed.join("")).not.toContain(buildOnboardNudge());
    drive.resetForTest();
  });

  it("the same seat takes mail again once the fresh session is up", async () => {
    const { fence, live, typed, drive, settle } = sealedSeat();
    fence.seal("b1");
    live.epoch = "e2";
    drive.invalidateBinding("b1");
    const outcome = drive.writeMail("b1", "mail from A");
    await settle(2_000);
    expect(await outcome).toBe("written");
    expect(typed.join("")).toContain("mail from A");
    drive.resetForTest();
  });
});

describe("mail that arrives between the offboard and the exit", () => {
  const CANVAS = "crew";
  const NODE = "agent-b";
  const BINDING = "bind-b";

  const mail = (messageId: string, text: string): Message => ({
    messageId,
    role: "user",
    parts: [{ kind: "text", text }],
    metadata: {
      factoryMail: true,
      ...mailExtensionMetadata({
        mailKind: "notice",
        fromSeat: `seat_${"a".repeat(64)}` as MailExtension["fromSeat"],
        senderNodeId: "agent-a",
        senderName: "Claude Code",
        senderGeneration: "ep_a",
        senderHarness: "claude",
      }),
    },
  });

  /**
   * The real mail delivery service over a seat whose process the test starts
   * and stops, wired to the fence the way ipc.ts wires it: a sealed seat is
   * not live for mail, and a lifted fence asks delivery to look again.
   */
  const mailbox = (onWake: "starts" | "paused") => {
    const messages: Message[] = [];
    const doc = {
      nodes: [{
        id: NODE,
        type: "text",
        text: "Claude Code",
        x: 0,
        y: 0,
        width: 100,
        height: 80,
        ether: {
          entity: { kind: "agent", name: "local:claude" },
          terminal: { bindingId: BINDING, harness: "claude" },
          messages: { items: messages },
        },
      }],
      edges: [],
    } as unknown as CanvasDoc;
    const seat = { epoch: "e1" as string | undefined, generations: 1 };
    const fence = new ClosingFence();
    fence.setLiveGeneration(() => seat.epoch);
    const written: Array<{ into: string | undefined; text: string }> = [];
    const wakes: string[] = [];
    const store: MessageDeliveryStore = {
      listCanvasNames: async () => [CANVAS],
      readDoc: async () => doc,
      acceptMessageDelivery: async (_canvas, _node, messageId) => {
        const index = messages.findIndex((message) => message.messageId === messageId);
        messages[index] = { ...messages[index]!, metadata: { ...messages[index]!.metadata, deliveredAt: Date.now() } };
        return true;
      },
    };
    const service = new MessageDeliveryService();
    service.configure({
      store,
      transport: {
        seatLive: (bindingId) => !fence.sealed(bindingId) && seat.epoch !== undefined,
        wakeSeat: async (bindingId) => {
          // A process still there needs no wake (ipc.ts wakeSeat).
          if (seat.epoch !== undefined) return true;
          wakes.push(bindingId);
          if (onWake === "paused") return false;
          seat.generations += 1;
          seat.epoch = `e${seat.generations}`;
          // The fresh process's TUI comes up a little later, as in the app.
          setTimeout(() => service.onSeatLive(bindingId), 5);
          return true;
        },
        writeMail: async (_bindingId, text) => {
          written.push({ into: seat.epoch, text });
          return "written";
        },
      },
    });
    fence.subscribeLifted((bindingId) => service.onSeatLive(bindingId));
    const settle = async () => {
      for (let i = 0; i < 30; i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
    };
    /** The old process is gone; the app tells the fence on the seat's gone event. */
    const exit = () => {
      seat.epoch = undefined;
      fence.release(BINDING);
    };
    return { service, fence, seat, messages, written, wakes, settle, exit };
  };

  it("is typed into nothing while the old session ends", async () => {
    const box = mailbox("starts");
    box.fence.seal(BINDING);
    box.messages.push(mail("01A", "Please review the contract."));
    expect(await box.service.deliver(CANVAS, NODE, "01A")).toBe("waiting");
    await box.settle();
    expect(box.written).toEqual([]);
    // The old process is still there: nothing is started beside it.
    expect(box.wakes).toEqual([]);
    box.service.suspend();
  });

  it("rest: wakes the seat once the old process is gone, and is read by the fresh session, once", async () => {
    const box = mailbox("starts");
    box.fence.seal(BINDING);
    box.messages.push(mail("01A", "Please review the contract."));
    await box.service.deliver(CANVAS, NODE, "01A");
    box.exit();
    await box.settle();
    expect(box.wakes).toEqual([BINDING]);
    expect(box.written).toHaveLength(1);
    expect(box.written[0]).toMatchObject({ into: "e2" });
    expect(box.written[0]!.text).toContain("junto msg read 01A");
    // Nothing further happens to it, however often the seat is looked at.
    box.service.onSeatLive(BINDING);
    await box.settle();
    expect(box.written).toHaveLength(1);
    box.service.suspend();
  });

  it("continue: goes to the fresh session Junto starts, never to the one that offboarded", async () => {
    const box = mailbox("starts");
    box.fence.seal(BINDING);
    box.messages.push(mail("01A", "First."), mail("01B", "Second."));
    await box.service.deliver(CANVAS, NODE, "01A");
    await box.service.deliver(CANVAS, NODE, "01B");
    // The rotation: old process gone, fresh one started by Junto itself.
    box.seat.epoch = undefined;
    box.seat.generations += 1;
    box.seat.epoch = "e2";
    box.fence.release(BINDING);
    await box.settle();
    expect(box.written.map((write) => write.into)).toEqual(["e2", "e2"]);
    expect(box.written.map((write) => /junto msg read (\w+)/.exec(write.text)?.[1])).toEqual(["01A", "01B"]);
    box.service.suspend();
  });

  it("on a paused canvas it waits in the mailbox, and is delivered once when the seat does start", async () => {
    const box = mailbox("paused");
    box.fence.seal(BINDING);
    box.messages.push(mail("01A", "Please review the contract."));
    await box.service.deliver(CANVAS, NODE, "01A");
    box.exit();
    await box.settle();
    expect(box.written).toEqual([]);
    // The canvas plays; the seat comes up.
    box.seat.epoch = "e2";
    box.service.onSeatLive(BINDING);
    await box.settle();
    expect(box.written.map((write) => write.into)).toEqual(["e2"]);
    box.service.suspend();
  });
});
