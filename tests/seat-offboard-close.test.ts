/**
 * The offboard closer: once the agent that ran `junto offboard` is idle, a
 * plain offboard closes the session and leaves the seat resting, and only
 * `--continue` starts the fresh session and mails it the kickoff. Also the
 * rotation sequence with and without the wake.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OFFBOARD_CLOSE_TICK_MS,
  OFFBOARD_SETTLE_MS,
  SeatOffboardCloser,
  seatClosable,
  type ClosingSeat,
  type OffboardClosePorts,
} from "../src/main/junto/seat-sessions/offboard-close";
import { rotateSeatSession, type RotatingSeat, type SeatRotatePorts } from "../src/main/junto/seat-sessions/rotate";
import type { SeatOffboardEvent } from "../src/main/junto/seat-sessions/service";
import type { OffboardMode, SeatOffboardProgress } from "../src/shared/seat-sessions";

const harness = (over: Partial<OffboardClosePorts> = {}) => {
  const h = {
    now: 1_000,
    running: true,
    idle: false,
    seat: { bindingId: "bind-a", sessionId: "s1" } as ClosingSeat | undefined,
    closes: [] as Array<{ seatId: string; wake: boolean }>,
    kickoffs: [] as string[],
    progress: [] as SeatOffboardProgress[],
    woke: true,
  };
  const ports: OffboardClosePorts = {
    locate: async () => h.seat,
    isRunning: () => h.running,
    isIdle: () => h.idle,
    close: async ({ seatId }, wake) => {
      h.closes.push({ seatId, wake });
      return { ok: true, ended: "s1", next: "s2", woke: wake && h.woke };
    },
    kickoff: async ({ seatId }) => (h.kickoffs.push(seatId), true),
    publish: (progress) => h.progress.push(progress),
    now: () => h.now,
    ...over,
  };
  return { h, closer: new SeatOffboardCloser(ports) };
};

const offboard = (mode: OffboardMode, sessionId = "s1"): SeatOffboardEvent => ({
  seatId: "a",
  canvasName: "c",
  sessionId,
  at: 1_000,
  mode,
});

/** Tick through the settle period while the seat sits idle. */
const settle = async (h: { now: number }, closer: SeatOffboardCloser) => {
  await closer.tick();
  h.now += OFFBOARD_SETTLE_MS;
  await closer.tick();
};

describe("SeatOffboardCloser", () => {
  it("plain offboard closes the session once idle and lets the seat rest: no wake, no kickoff", async () => {
    const { h, closer } = harness();
    closer.offboarded(offboard("rest"));
    // Mid-turn: nothing happens.
    await closer.tick();
    expect(h.closes).toEqual([]);

    h.idle = true;
    await settle(h, closer);
    expect(h.closes).toEqual([{ seatId: "a", wake: false }]);
    expect(h.kickoffs).toEqual([]);
    expect(h.progress.map((p) => p.stage)).toEqual(["saved", "resting"]);

    // Closed once, never again.
    await settle(h, closer);
    expect(h.closes).toHaveLength(1);
  });

  it("--continue rotates right away: the fresh session starts and gets the kickoff", async () => {
    const { h, closer } = harness();
    closer.offboarded(offboard("continue"));
    h.idle = true;
    await settle(h, closer);
    expect(h.closes).toEqual([{ seatId: "a", wake: true }]);
    expect(h.kickoffs).toEqual(["a"]);
    expect(h.progress.map((p) => p.stage)).toEqual(["saved", "started"]);
  });

  it("waits out the settle period, and starts it over when a turn begins", async () => {
    const { h, closer } = harness();
    closer.offboarded(offboard("rest"));
    h.idle = true;
    await closer.tick();
    h.now += OFFBOARD_SETTLE_MS - 1;
    h.idle = false;
    await closer.tick();
    h.idle = true;
    h.now += 1;
    await closer.tick();
    expect(h.closes).toEqual([]);
    h.now += OFFBOARD_SETTLE_MS;
    await closer.tick();
    expect(h.closes).toHaveLength(1);
  });

  it("closes a seat with no running process at once", async () => {
    const { h, closer } = harness();
    h.running = false;
    closer.offboarded(offboard("rest"));
    await closer.tick();
    expect(h.closes).toEqual([{ seatId: "a", wake: false }]);
  });

  it("the latest offboard's mode wins", async () => {
    const { h, closer } = harness();
    closer.offboarded(offboard("continue"));
    closer.offboarded(offboard("rest"));
    h.idle = true;
    await settle(h, closer);
    expect(h.closes).toEqual([{ seatId: "a", wake: false }]);
  });

  it("drops an offboard whose seat already moved to another session", async () => {
    const { h, closer } = harness();
    closer.offboarded(offboard("continue", "s0"));
    h.idle = true;
    await settle(h, closer);
    expect(h.closes).toEqual([]);
  });

  it("carries the operator's ask through to the close, and reports a paused canvas as waiting", async () => {
    const { h, closer } = harness();
    h.woke = false;
    closer.asked({ seatId: "a", canvasName: "c" }, "continue");
    closer.offboarded(offboard("continue"));
    h.idle = true;
    await settle(h, closer);
    expect(h.progress.map((p) => p.stage)).toEqual(["asked", "saved", "waiting"]);
    expect(h.progress.every((p) => p.askedAt === 1_000)).toBe(true);
    // The kickoff waits in the mailbox for the wake.
    expect(h.kickoffs).toEqual(["a"]);
    expect(closer.current()).toEqual([expect.objectContaining({ seatId: "a", stage: "waiting" })]);

    // The agent's own offboard, no ask: no askedAt.
    closer.offboarded(offboard("rest", "s2"));
    expect(h.progress.at(-1)).not.toHaveProperty("askedAt");
  });

  it("reports a close Junto could not make, and a seat that left its canvas", async () => {
    const failing = harness({ close: async () => ({ ok: false, reason: "this seat runs on another installation" }) });
    failing.closer.offboarded(offboard("rest"));
    failing.h.idle = true;
    await settle(failing.h, failing.closer);
    expect(failing.h.progress.at(-1)).toMatchObject({ stage: "failed", message: "this seat runs on another installation" });

    const gone = harness();
    gone.h.seat = undefined;
    gone.closer.offboarded(offboard("continue"));
    await gone.closer.tick();
    expect(gone.h.closes).toEqual([]);
    expect(gone.h.progress.at(-1)).toMatchObject({ stage: "failed" });
  });
});

describe("rotateSeatSession wake", () => {
  const seat: RotatingSeat = { canvasName: "c", bindingId: "bind-a", harness: "claude", sessionId: "s1", local: true };
  const recorder = () => {
    const acts: string[] = [];
    const ports: SeatRotatePorts = {
      locate: async () => seat,
      endSession: async (seatId, sessionId) => void acts.push(`end ${seatId} ${sessionId}`),
      reopenSession: async () => undefined,
      writeSessionId: async (_seat, seatId, next) => (acts.push(`write ${seatId} ${next ?? "(none)"}`), true),
      stop: async (bindingId) => void acts.push(`stop ${bindingId}`),
      wake: async (_seat, seatId) => (acts.push(`wake ${seatId}`), true),
      mintSessionId: () => "fresh",
    };
    return { acts, ports };
  };

  it("rests: ends the session, pins a fresh id, stops, and does not wake", async () => {
    const { acts, ports } = recorder();
    expect(await rotateSeatSession("a", ports, { wake: false })).toEqual({ ok: true, ended: "s1", next: "fresh", woke: false });
    expect(acts).toEqual(["end a s1", "write a fresh", "stop bind-a"]);
  });

  it("continues: the same, then wakes", async () => {
    const { acts, ports } = recorder();
    expect(await rotateSeatSession("a", ports, { wake: true })).toMatchObject({ ok: true, woke: true });
    expect(acts.at(-1)).toBe("wake a");
  });

  describe("which seat, on which canvas", () => {
    /**
     * A canvas that answers only for the seat it holds, the way the app's
     * lookup does. Asked for canvas "a" and seat "c" it knows nothing.
     */
    const canvases: Record<string, Record<string, ClosingSeat>> = {
      c: { a: { bindingId: "bind-a", sessionId: "s1" } },
    };
    const lookedUp: Array<{ seatId: string; canvasName: string }> = [];
    const onCanvas = (over: Partial<OffboardClosePorts> = {}) =>
      harness({
        locate: async (seat) => {
          lookedUp.push({ ...seat });
          return canvases[seat.canvasName]?.[seat.seatId];
        },
        ...over,
      });

    it("the closer finds the seat it is closing, so the session does close", async () => {
      // The defect this pins: the lookup was handed the seat where it expected
      // the canvas, found nothing, and every close failed as "no longer on its
      // canvas" while the agent's notes sat saved.
      lookedUp.length = 0;
      const { h, closer } = onCanvas();
      h.idle = true;
      closer.offboarded(offboard("continue"));
      await settle(h, closer);
      expect(lookedUp.at(-1)).toEqual({ seatId: "a", canvasName: "c" });
      expect(h.closes).toEqual([{ seatId: "a", wake: true }]);
      expect(h.kickoffs).toEqual(["a"]);
      expect(h.progress.at(-1)).toMatchObject({ stage: "started" });
      expect(h.progress.some((progress) => progress.stage === "failed")).toBe(false);
    });

    it("hands the same seat and canvas to the close and to the kickoff", async () => {
      const asked: Array<{ port: string; seatId: string; canvasName: string }> = [];
      const { h, closer } = onCanvas({
        close: async (seat, wake) => {
          asked.push({ port: "close", ...seat });
          return { ok: true, ended: "s1", next: "s2", woke: wake };
        },
        kickoff: async (seat) => {
          asked.push({ port: "kickoff", ...seat });
          return true;
        },
      });
      h.idle = true;
      closer.offboarded(offboard("continue"));
      await settle(h, closer);
      expect(asked).toEqual([
        { port: "close", seatId: "a", canvasName: "c" },
        { port: "kickoff", seatId: "a", canvasName: "c" },
      ]);
    });

    it("a seat that really is gone from its canvas fails with that reason, published for the seat", async () => {
      const { h, closer } = onCanvas();
      h.idle = true;
      closer.offboarded({ ...offboard("rest"), seatId: "ghost" });
      await settle(h, closer);
      expect(h.closes).toEqual([]);
      expect(h.progress.at(-1)).toMatchObject({
        seatId: "ghost",
        canvasName: "c",
        stage: "failed",
        message: "The seat is no longer on its canvas.",
      });
    });
  });

  describe("several seats offboarding at once", () => {
    const SEATS = ["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"];
    /** Each close takes as long as a stubborn process takes to exit. */
    const SLOW_CLOSE_MS = 10_000;

    const many = (over: Partial<OffboardClosePorts> = {}) => {
      vi.useFakeTimers({ now: 1_000 });
      const closed: Array<{ seatId: string; at: number }> = [];
      const progress: SeatOffboardProgress[] = [];
      const idle = new Set<string>(SEATS);
      const closer = new SeatOffboardCloser({
        locate: async ({ seatId }) => ({ bindingId: `bind-${seatId}`, sessionId: "s1" }),
        isRunning: () => true,
        isIdle: (bindingId) => idle.has(bindingId.replace("bind-", "")),
        close: async ({ seatId }, wake) => {
          await new Promise((resolve) => setTimeout(resolve, SLOW_CLOSE_MS));
          closed.push({ seatId, at: Date.now() });
          return { ok: true, ended: "s1", next: "s2", woke: wake };
        },
        kickoff: async () => true,
        publish: (entry) => progress.push(entry),
        now: () => Date.now(),
        ...over,
      });
      const offboardAll = (seats: ReadonlyArray<string> = SEATS) => {
        for (const seatId of seats) {
          closer.offboarded({ seatId, canvasName: "c", sessionId: "s1", at: Date.now(), mode: "continue" });
        }
      };
      /** The closer's own clock: a tick every second, as in the app. */
      const run = async (ms: number) => {
        for (let elapsed = 0; elapsed < ms; elapsed += OFFBOARD_CLOSE_TICK_MS) {
          void closer.tick();
          await vi.advanceTimersByTimeAsync(OFFBOARD_CLOSE_TICK_MS);
        }
      };
      const stageOf = (seatId: string) => progress.filter((entry) => entry.seatId === seatId).at(-1)?.stage;
      return { closer, closed, progress, idle, offboardAll, run, stageOf };
    };

    afterEach(() => {
      vi.useRealTimers();
    });

    it("ten seats close together, not one after another", async () => {
      const { closed, offboardAll, run, stageOf } = many();
      const startedAt = Date.now();
      offboardAll();
      // Settle, then one slow close each, side by side.
      await run(OFFBOARD_SETTLE_MS + SLOW_CLOSE_MS + 2 * OFFBOARD_CLOSE_TICK_MS);
      expect(closed.map((entry) => entry.seatId).sort()).toEqual(SEATS);
      const last = Math.max(...closed.map((entry) => entry.at)) - startedAt;
      // One after another this is over a minute and a half.
      expect(last).toBeLessThanOrEqual(OFFBOARD_SETTLE_MS + SLOW_CLOSE_MS + 2 * OFFBOARD_CLOSE_TICK_MS);
      for (const seatId of SEATS) expect(stageOf(seatId)).toBe("started");
    });

    it("a seat that goes idle while others are still closing is not kept waiting for them", async () => {
      const { closed, idle, offboardAll, run } = many();
      idle.delete("s9");
      offboardAll();
      await run(OFFBOARD_SETTLE_MS + 2 * OFFBOARD_CLOSE_TICK_MS);
      // Nine closes are in flight. The tenth finishes its turn now.
      const idleAt = Date.now();
      idle.add("s9");
      await run(OFFBOARD_SETTLE_MS + SLOW_CLOSE_MS + 2 * OFFBOARD_CLOSE_TICK_MS);
      const late = closed.find((entry) => entry.seatId === "s9");
      expect(late).toBeDefined();
      expect(late!.at - idleAt).toBeLessThanOrEqual(OFFBOARD_SETTLE_MS + SLOW_CLOSE_MS + 2 * OFFBOARD_CLOSE_TICK_MS);
    });

    it("one seat whose close never returns does not hold up the others", async () => {
      const { closed, offboardAll, run, stageOf } = many({
        close: async ({ seatId }, wake) => {
          if (seatId === "s3") return new Promise(() => {});
          await new Promise((resolve) => setTimeout(resolve, 100));
          closed.push({ seatId, at: Date.now() });
          return { ok: true, ended: "s1", next: "s2", woke: wake };
        },
      });
      offboardAll();
      await run(OFFBOARD_SETTLE_MS + 3 * OFFBOARD_CLOSE_TICK_MS);
      expect(closed.map((entry) => entry.seatId).sort()).toEqual(SEATS.filter((seatId) => seatId !== "s3"));
      expect(stageOf("s3")).toBe("saved");
      expect(stageOf("s4")).toBe("started");
    });

    it("one seat whose close fails, or whose lookup throws, fails alone and says so", async () => {
      const { closed, offboardAll, run, stageOf, progress } = many({
        locate: async ({ seatId }) => {
          if (seatId === "s5") throw new Error("canvas unreadable");
          return { bindingId: `bind-${seatId}`, sessionId: "s1" };
        },
        close: async ({ seatId }, wake) => {
          if (seatId === "s2") throw new Error("could not stop the process");
          closed.push({ seatId, at: Date.now() });
          return { ok: true, ended: "s1", next: "s2", woke: wake };
        },
      });
      offboardAll();
      await run(OFFBOARD_SETTLE_MS + 3 * OFFBOARD_CLOSE_TICK_MS);
      expect(closed).toHaveLength(8);
      expect(stageOf("s2")).toBe("failed");
      expect(progress.find((entry) => entry.seatId === "s2" && entry.stage === "failed")?.message).toContain(
        "could not stop the process",
      );
      expect(stageOf("s5")).toBe("failed");
      expect(stageOf("s6")).toBe("started");
    });

    it("never closes the same seat twice, however many ticks pass while its close is in flight", async () => {
      let closes = 0;
      const { offboardAll, run } = many({
        close: async (_seat, wake) => {
          closes += 1;
          await new Promise((resolve) => setTimeout(resolve, SLOW_CLOSE_MS));
          return { ok: true, ended: "s1", next: "s2", woke: wake };
        },
      });
      offboardAll(["s0"]);
      await run(OFFBOARD_SETTLE_MS + SLOW_CLOSE_MS + 3 * OFFBOARD_CLOSE_TICK_MS);
      expect(closes).toBe(1);
    });

    it("an offboard that arrives for a seat while its close is in flight waits for that close", async () => {
      const order: string[] = [];
      const { closer, offboardAll, run } = many({
        close: async (_seat, wake) => {
          order.push("close:start");
          await new Promise((resolve) => setTimeout(resolve, SLOW_CLOSE_MS));
          order.push("close:end");
          return { ok: true, ended: "s1", next: "s2", woke: wake };
        },
        // The fresh session is the one the node names once the close is done.
        locate: async () => ({ bindingId: "bind-s0", sessionId: order.includes("close:end") ? "s2" : "s1" }),
      });
      offboardAll(["s0"]);
      await run(OFFBOARD_SETTLE_MS + 2 * OFFBOARD_CLOSE_TICK_MS);
      expect(order).toEqual(["close:start"]);
      // The fresh session offboards too, before the first close has returned.
      closer.offboarded({ seatId: "s0", canvasName: "c", sessionId: "s2", at: Date.now(), mode: "rest" });
      await run(4 * OFFBOARD_CLOSE_TICK_MS);
      expect(order).toEqual(["close:start"]);
      await run(SLOW_CLOSE_MS + OFFBOARD_SETTLE_MS + SLOW_CLOSE_MS + 3 * OFFBOARD_CLOSE_TICK_MS);
      expect(order).toEqual(["close:start", "close:end", "close:start", "close:end"]);
    });
  });

  describe("an operator draft when the close comes due", () => {
    it("a seat is closable only when idle with nothing of the operator's in its input box", () => {
      expect(seatClosable({ idle: true, inputBoxHold: undefined })).toBe(true);
      expect(seatClosable({ idle: true, inputBoxHold: "draft" })).toBe(false);
      expect(seatClosable({ idle: true, inputBoxHold: "dialog" })).toBe(false);
      // Junto types nothing to close a session: an unread box is no reason to
      // wait, and for a harness with no probes it would be a wait for ever.
      expect(seatClosable({ idle: true, inputBoxHold: "unreadable" })).toBe(true);
      expect(seatClosable({ idle: false, inputBoxHold: undefined })).toBe(false);
    });

    it("the close waits while the draft is there, restarts its settle, and goes when it is gone", async () => {
      const box = { hold: "draft" as "draft" | undefined };
      const { h, closer } = harness({
        isIdle: () => seatClosable({ idle: true, inputBoxHold: box.hold }),
      });
      closer.offboarded(offboard("rest"));
      for (let i = 0; i < 5; i += 1) await settle(h, closer);
      expect(h.closes).toEqual([]);
      expect(h.progress.at(-1)).toMatchObject({ stage: "saved" });
      // The operator sends or clears the draft.
      box.hold = undefined;
      await closer.tick();
      expect(h.closes).toEqual([]);
      h.now += OFFBOARD_SETTLE_MS;
      await closer.tick();
      expect(h.closes).toEqual([{ seatId: "a", wake: false }]);
    });
  });
});
