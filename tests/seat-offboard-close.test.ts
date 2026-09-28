/**
 * The offboard closer: once the agent that ran `junto offboard` is idle, a
 * plain offboard closes the session and leaves the seat resting, and only
 * `--continue` starts the fresh session and mails it the kickoff. Also the
 * rotation sequence with and without the wake.
 */
import { describe, expect, it } from "vitest";
import {
  OFFBOARD_SETTLE_MS,
  SeatOffboardCloser,
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
    close: async (seatId, _canvas, wake) => {
      h.closes.push({ seatId, wake });
      return { ok: true, ended: "s1", next: "s2", woke: wake && h.woke };
    },
    kickoff: async (seatId) => (h.kickoffs.push(seatId), true),
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
    expect(closer.handles("c", "a", "s1")).toBe(false);
  });

  it("owns the seat while pending, closing, and for the session it closed", async () => {
    const { h, closer } = harness();
    expect(closer.handles("c", "a", "s1")).toBe(false);
    closer.offboarded(offboard("rest"));
    expect(closer.handles("c", "a", "s1")).toBe(true);
    h.idle = true;
    await settle(h, closer);
    // Still the closed session (a stale seat list): leave it alone.
    expect(closer.handles("c", "a", "s1")).toBe(true);
    // The fresh session is the pressure clock's again.
    expect(closer.handles("c", "a", "s2")).toBe(false);
  });

  it("carries the operator's ask through to the close, and reports a paused canvas as waiting", async () => {
    const { h, closer } = harness();
    h.woke = false;
    closer.asked("a", "c", "continue");
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
});
