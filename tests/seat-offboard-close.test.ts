/**
 * The offboard closer: `junto offboard` ends the session, mechanically and at
 * once. The moment the offboard is announced (its notes on disk, its reply
 * written), the closer rotates the seat: no idle reading, no settle, no tick.
 * A plain offboard leaves the seat resting; `--continue` starts the fresh
 * session and has it told to read its handoff. Also the rotation sequence
 * with and without the wake.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SeatOffboardCloser,
  type OffboardClosePorts,
} from "../src/main/junto/seat-sessions/offboard-close";
import * as closerModule from "../src/main/junto/seat-sessions/offboard-close";
import { rotateSeatSession, type RotatingSeat, type SeatRotatePorts } from "../src/main/junto/seat-sessions/rotate";
import type { SeatOffboardEvent } from "../src/main/junto/seat-sessions/service";
import type { OffboardMode, SeatOffboardProgress } from "../src/shared/seat-sessions";

const harness = (over: Partial<OffboardClosePorts> = {}) => {
  const h = {
    now: 1_000,
    order: [] as string[],
    closes: [] as Array<{ seatId: string; canvasName: string; wake: boolean }>,
    kickoffs: [] as string[],
    released: [] as string[],
    progress: [] as SeatOffboardProgress[],
    woke: true,
  };
  const ports: OffboardClosePorts = {
    close: async ({ seatId, canvasName }, wake) => {
      h.order.push(`close:${seatId}`);
      h.closes.push({ seatId, canvasName, wake });
      return { ok: true, ended: "s1", next: "s2", woke: wake && h.woke };
    },
    kickoff: async ({ seatId }) => {
      h.order.push(`kickoff:${seatId}`);
      h.kickoffs.push(seatId);
      return true;
    },
    release: ({ seatId }) => {
      h.released.push(seatId);
    },
    publish: (progress) => h.progress.push(progress),
    now: () => h.now,
    ...over,
  };
  return { h, closer: new SeatOffboardCloser(ports) };
};

const offboard = (mode: OffboardMode, seatId = "a", sessionId = "s1"): SeatOffboardEvent => ({
  seatId,
  canvasName: "c",
  sessionId,
  at: 1_000,
  mode,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SeatOffboardCloser", () => {
  it("issues the stop straight from the offboard: no idle reading, no settle, no tick", async () => {
    let stopIssued = false;
    const { h, closer } = harness({
      close: async ({ seatId, canvasName }, wake) => {
        stopIssued = true;
        h.closes.push({ seatId, canvasName, wake });
        return { ok: true, ended: "s1", next: "s2", woke: false };
      },
    });
    closer.offboarded(offboard("rest"));
    // Synchronously, in the same call: nothing was waited for, not even a
    // microtask. There is no clock in this test at all.
    expect(stopIssued).toBe(true);
    expect(h.closes).toEqual([{ seatId: "a", canvasName: "c", wake: false }]);
  });

  it("has no port through which it could ask whether the seat is idle or running", () => {
    // The old design read idle and waited. That it cannot is the contract.
    const { closer } = harness();
    expect(closer).not.toHaveProperty("tick");
    const ports: Record<keyof OffboardClosePorts, true> = {
      close: true,
      kickoff: true,
      release: true,
      publish: true,
      onOffboard: true,
      now: true,
      log: true,
    };
    expect(Object.keys(ports).sort()).toEqual(["close", "kickoff", "log", "now", "onOffboard", "publish", "release"]);
    expect(closerModule).not.toHaveProperty("OFFBOARD_SETTLE_MS");
    expect(closerModule).not.toHaveProperty("OFFBOARD_CLOSE_TICK_MS");
    expect(closerModule).not.toHaveProperty("seatClosable");
  });

  it("a seat that is working when it offboards is closed all the same", async () => {
    // Offboard is run mid-turn by definition: the turn in flight is cut.
    vi.useFakeTimers({ now: 1_000 });
    const seat = { state: "working" as string, pid: 100 as number | undefined };
    const { h, closer } = harness({
      close: async ({ seatId, canvasName }, wake) => {
        h.closes.push({ seatId, canvasName, wake });
        seat.pid = undefined;
        seat.state = "gone";
        return { ok: true, ended: "s1", next: "s2", woke: false };
      },
    });
    await closer.offboarded(offboard("rest"));
    expect(seat.pid).toBeUndefined();
    expect(h.progress.map((p) => p.stage)).toEqual(["saved", "resting"]);
    // And no timer was ever armed to do it later.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("plain offboard closes the session and lets the seat rest: no wake, no kickoff", async () => {
    const { h, closer } = harness();
    await closer.offboarded(offboard("rest"));
    expect(h.closes).toEqual([{ seatId: "a", canvasName: "c", wake: false }]);
    expect(h.kickoffs).toEqual([]);
    expect(h.progress.map((p) => p.stage)).toEqual(["saved", "resting"]);
  });

  it("--continue restarts: the fresh session starts, then is told to read its handoff", async () => {
    const { h, closer } = harness();
    await closer.offboarded(offboard("continue"));
    expect(h.order).toEqual(["close:a", "kickoff:a"]);
    expect(h.closes).toEqual([{ seatId: "a", canvasName: "c", wake: true }]);
    expect(h.progress.map((p) => p.stage)).toEqual(["saved", "started"]);
  });

  it("carries the operator's ask through to the close, and reports a paused canvas as waiting", async () => {
    const { h, closer } = harness();
    h.woke = false;
    closer.asked({ seatId: "a", canvasName: "c" }, "continue");
    await closer.offboarded(offboard("continue"));
    expect(h.progress.map((p) => p.stage)).toEqual(["asked", "saved", "waiting"]);
    expect(h.progress.every((p) => p.askedAt === 1_000)).toBe(true);
    // The continuation is still owed to the seat for when it starts.
    expect(h.kickoffs).toEqual(["a"]);
    expect(closer.current()).toEqual([expect.objectContaining({ seatId: "a", stage: "waiting" })]);

    // The agent's own offboard, no ask: no askedAt.
    await closer.offboarded(offboard("rest", "a", "s2"));
    expect(h.progress.at(-1)).not.toHaveProperty("askedAt");
  });

  it("a close Junto could not make is reported with its reason, and the seat may be typed into again", async () => {
    const { h, closer } = harness({
      close: async () => ({ ok: false, reason: "this seat runs on another installation" }),
    });
    await closer.offboarded(offboard("rest"));
    expect(h.progress.at(-1)).toMatchObject({ stage: "failed", message: "this seat runs on another installation" });
    // Its process was never stopped: the fence on it must not outlive the attempt.
    expect(h.released).toEqual(["a"]);
  });

  it("a close that throws is a failure of that seat, reported, never an unhandled rejection", async () => {
    const { h, closer } = harness({
      close: async () => {
        throw new Error("could not stop the process");
      },
    });
    await expect(closer.offboarded(offboard("continue"))).resolves.toBeUndefined();
    expect(h.progress.at(-1)?.stage).toBe("failed");
    expect(h.progress.at(-1)?.message).toContain("could not stop the process");
    expect(h.kickoffs).toEqual([]);
    expect(h.released).toEqual(["a"]);
  });

  it("a session that closed leaves the fence to lift with its process, not by the closer", async () => {
    const { h, closer } = harness();
    await closer.offboarded(offboard("continue"));
    expect(h.released).toEqual([]);
  });

  it("the fresh session it could not tell is a failure the operator sees", async () => {
    const { h, closer } = harness({ kickoff: async () => false });
    await closer.offboarded(offboard("continue"));
    expect(h.progress.at(-1)).toMatchObject({
      stage: "failed",
      message: "The fresh session is ready, but Junto could not send it the kickoff.",
    });
  });

  describe("which seat, on which canvas", () => {
    it("hands the offboarding seat and its canvas, by name, to the close and to the kickoff", async () => {
      const asked: Array<{ port: string; seatId: string; canvasName: string }> = [];
      const { closer } = harness({
        close: async (seat, wake) => {
          asked.push({ port: "close", ...seat });
          return { ok: true, ended: "s1", next: "s2", woke: wake };
        },
        kickoff: async (seat) => {
          asked.push({ port: "kickoff", ...seat });
          return true;
        },
      });
      await closer.offboarded(offboard("continue"));
      expect(asked).toEqual([
        { port: "close", seatId: "a", canvasName: "c" },
        { port: "kickoff", seatId: "a", canvasName: "c" },
      ]);
    });
  });

  describe("several seats offboarding in the same instant", () => {
    const SEATS = ["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"];
    /** As long as a stubborn process takes to be force-killed and declared gone. */
    const SLOW_CLOSE_MS = 3_000;

    const many = (over: Partial<OffboardClosePorts> = {}) => {
      vi.useFakeTimers({ now: 1_000 });
      const started: Array<{ seatId: string; at: number }> = [];
      const closed: Array<{ seatId: string; at: number }> = [];
      const rig = harness({
        close: async ({ seatId }, wake) => {
          started.push({ seatId, at: Date.now() });
          await new Promise((resolve) => setTimeout(resolve, SLOW_CLOSE_MS));
          closed.push({ seatId, at: Date.now() });
          return { ok: true, ended: "s1", next: "s2", woke: wake };
        },
        now: () => Date.now(),
        ...over,
      });
      const stageOf = (seatId: string) =>
        rig.h.progress.filter((entry) => entry.seatId === seatId).at(-1)?.stage;
      return { ...rig, started, closed, stageOf };
    };

    it("every stop is issued in the same instant, and they finish together", async () => {
      const { closer, started, closed, stageOf } = many();
      const at = Date.now();
      const flights = SEATS.map((seatId) => closer.offboarded(offboard("continue", seatId)));
      // All ten stops are out before a single one has finished.
      expect(started.map((entry) => entry.seatId)).toEqual(SEATS);
      expect(started.every((entry) => entry.at === at)).toBe(true);
      await vi.advanceTimersByTimeAsync(SLOW_CLOSE_MS);
      await Promise.all(flights);
      expect(closed.map((entry) => entry.seatId).sort()).toEqual(SEATS);
      // One after another this would be thirty seconds.
      expect(Math.max(...closed.map((entry) => entry.at)) - at).toBe(SLOW_CLOSE_MS);
      for (const seatId of SEATS) expect(stageOf(seatId)).toBe("started");
    });

    it("one seat whose close never returns holds up nobody", async () => {
      const { h, closer, stageOf } = many({
        close: async ({ seatId, canvasName }, wake) => {
          if (seatId === "s3") return new Promise(() => {});
          h.closes.push({ seatId, canvasName, wake });
          return { ok: true, ended: "s1", next: "s2", woke: wake };
        },
      });
      for (const seatId of SEATS) void closer.offboarded(offboard("continue", seatId));
      await vi.advanceTimersByTimeAsync(10);
      expect(h.closes.map((entry) => entry.seatId).sort()).toEqual(SEATS.filter((seatId) => seatId !== "s3"));
      expect(stageOf("s3")).toBe("saved");
      expect(stageOf("s4")).toBe("started");
    });

    it("one seat whose close fails, fails alone and says so", async () => {
      const { h, closer, stageOf } = many({
        close: async ({ seatId, canvasName }, wake) => {
          if (seatId === "s2") throw new Error("could not stop the process");
          h.closes.push({ seatId, canvasName, wake });
          return { ok: true, ended: "s1", next: "s2", woke: wake };
        },
      });
      await Promise.all(SEATS.map((seatId) => closer.offboarded(offboard("continue", seatId))));
      expect(h.closes).toHaveLength(9);
      expect(stageOf("s2")).toBe("failed");
      expect(stageOf("s6")).toBe("started");
    });

    it("a second offboard from a seat already closing does not close it twice", async () => {
      const { closer, started } = many();
      const first = closer.offboarded(offboard("continue", "s0"));
      const second = closer.offboarded(offboard("rest", "s0"));
      await vi.advanceTimersByTimeAsync(SLOW_CLOSE_MS);
      await Promise.all([first, second]);
      expect(started).toHaveLength(1);
    });

    it("the fresh session's own offboard, later, is a close of its own", async () => {
      const { closer, started } = many();
      const first = closer.offboarded(offboard("continue", "s0", "s1"));
      await vi.advanceTimersByTimeAsync(SLOW_CLOSE_MS);
      await first;
      const second = closer.offboarded(offboard("rest", "s0", "s2"));
      await vi.advanceTimersByTimeAsync(SLOW_CLOSE_MS);
      await second;
      expect(started).toHaveLength(2);
    });
  });

  describe("a process that ignores the stop", () => {
    it("is waited for only as long as the forced kill takes, and the fresh session still starts", async () => {
      // The host force-kills on its own bound and declares the generation
      // gone; rotation's stop returns then. The closer waits on nothing else.
      vi.useFakeTimers({ now: 1_000 });
      const FORCED_KILL_MS = 3_000;
      const { h, closer } = harness({
        close: async ({ seatId, canvasName }, wake) => {
          await new Promise((resolve) => setTimeout(resolve, FORCED_KILL_MS));
          h.closes.push({ seatId, canvasName, wake });
          return { ok: true, ended: "s1", next: "s2", woke: wake };
        },
        now: () => Date.now(),
      });
      const at = Date.now();
      const flight = closer.offboarded(offboard("continue"));
      await vi.advanceTimersByTimeAsync(FORCED_KILL_MS);
      await flight;
      expect(Date.now() - at).toBe(FORCED_KILL_MS);
      expect(h.kickoffs).toEqual(["a"]);
      expect(h.progress.at(-1)?.stage).toBe("started");
    });
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
      detach: async (found) => {
      acts.push(`detach ${found.bindingId}`);
      return { stopNow: async () => void acts.push(`stop ${found.bindingId}`) };
    },
      wake: async (_seat, seatId) => (acts.push(`wake ${seatId}`), true),
      mintSessionId: () => "fresh",
    };
    return { acts, ports };
  };

  it("rests: detaches, ends the session, pins a fresh id, and does not wake", async () => {
    const { acts, ports } = recorder();
    expect(await rotateSeatSession("a", ports, { wake: false })).toEqual({ ok: true, ended: "s1", next: "fresh", woke: false });
    expect(acts).toEqual(["detach bind-a", "end a s1", "write a fresh"]);
  });

  it("continues: the same, then wakes", async () => {
    const { acts, ports } = recorder();
    expect(await rotateSeatSession("a", ports, { wake: true })).toMatchObject({ ok: true, woke: true });
    expect(acts.at(-1)).toBe("wake a");
  });
});
