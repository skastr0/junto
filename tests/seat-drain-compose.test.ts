/**
 * Offboard detaches the old process and winds it down: the host, the
 * seat-state reading, the drain manager and the record, joined.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DRAIN_CAP_MS, DRAIN_SETTLE_MS } from "../src/main/junto/seat-sessions/drain";
import { composeSeatDrain } from "../src/main/junto/seat-sessions/drain-seat";
import { rotateSeatSession, type RotatingSeat, type SeatRotatePorts } from "../src/main/junto/seat-sessions/rotate";

const seatOf = (bindingId: string, sessionId: string | null = "s1"): RotatingSeat => ({
  canvasName: "c",
  bindingId,
  harness: "claude",
  ...(sessionId === null ? {} : { sessionId }),
  local: true,
});

/** A host that detaches by binding, and a detached process that can be driven. */
const rig = (options: { drainable?: boolean } = {}) => {
  const acts: string[] = [];
  const idle = new Set<string>();
  const stateListeners = new Set<(drainKey: string) => void>();
  const endedListeners = new Set<(drainKey: string, code: number | undefined) => void>();
  const stops: Array<{ drainKey: string; reason: string }> = [];
  const exitOnStop = { value: true };
  let epoch = 0;
  const clock = { now: 1_000 };
  const exit = (drainKey: string, code: number | undefined) => {
    for (const listener of [...endedListeners]) listener(drainKey, code);
  };
  const drain = composeSeatDrain({
    host: {
      drain: (bindingId) => {
        if (options.drainable === false) return undefined;
        epoch += 1;
        acts.push(`detach ${bindingId}`);
        return { drainKey: `drain:${bindingId}:e${epoch}` };
      },
      stopDraining: (drainKey, reason) => {
        stops.push({ drainKey, reason });
        if (exitOnStop.value) queueMicrotask(() => exit(drainKey, undefined));
        return true;
      },
      onDrainEnded: (listener) => {
        endedListeners.add(listener);
        return () => endedListeners.delete(listener);
      },
    },
    isIdle: (drainKey) => idle.has(drainKey),
    subscribeDrainState: (listener) => {
      stateListeners.add(listener);
      return () => stateListeners.delete(listener);
    },
    stopSeat: async (bindingId) => void acts.push(`stop ${bindingId}`),
    record: {
      begin: async (seatId, sessionId, at) => void acts.push(`record ${seatId} ${sessionId} detached at ${at}`),
      end: async (seatId, sessionId, how, at) => void acts.push(`record ${seatId} ${sessionId} ended ${how} at ${at}`),
      cancel: async (seatId, sessionId) => void acts.push(`record ${seatId} ${sessionId} was not offboarded`),
    },
    stopWaitMs: 500,
    now: () => clock.now,
  });
  const reads = (drainKey: string, value: "idle" | "working") => {
    if (value === "idle") idle.add(drainKey);
    else idle.delete(drainKey);
    for (const listener of [...stateListeners]) listener(drainKey);
  };
  const ports = (found: RotatingSeat, over: Partial<SeatRotatePorts> = {}): SeatRotatePorts => ({
    locate: async () => found,
    endSession: async (seatId, sessionId) => void acts.push(`end ${seatId} ${sessionId}`),
    reopenSession: async (seatId, sessionId) => void acts.push(`reopen ${seatId} ${sessionId}`),
    writeSessionId: async (_seat, seatId, next) => (acts.push(`write ${seatId} ${next ?? "(none)"}`), true),
    detach: drain.detach,
    wake: async (_seat, seatId) => (acts.push(`wake ${seatId}`), true),
    mintSessionId: () => "fresh",
    ...over,
  });
  return { acts, drain, stops, reads, exit, clock, ports, exitOnStop };
};

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("offboard detaches the old process and winds it down", () => {
  it("the fresh session starts at once; the old process is not stopped while it works", async () => {
    const { acts, drain, stops, ports } = rig();
    expect(await rotateSeatSession("a", ports(seatOf("bind-a")))).toMatchObject({ ok: true, woke: true });
    expect(acts.filter((act) => !act.startsWith("record"))).toEqual([
      "detach bind-a",
      "end a s1",
      "write a fresh",
      "wake a",
    ]);
    expect(stops).toEqual([]);
    expect(drain.drainingSessionIds("a")).toEqual(["s1"]);
    // Mid-turn for nine minutes: still not stopped.
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(stops).toEqual([]);
  });

  it("rest leaves the seat resting, with the old process winding down beside it", async () => {
    const { acts, stops, ports } = rig();
    expect(await rotateSeatSession("a", ports(seatOf("bind-a")), { wake: false })).toMatchObject({ ok: true, woke: false });
    expect(acts).not.toContain("wake a");
    expect(stops).toEqual([]);
  });

  it("it is stopped once it reads idle and stays idle, and the record says settled", async () => {
    const { acts, drain, stops, reads, clock, ports } = rig();
    await rotateSeatSession("a", ports(seatOf("bind-a")));
    reads("drain:bind-a:e1", "working");
    await vi.advanceTimersByTimeAsync(30_000);
    reads("drain:bind-a:e1", "idle");
    await vi.advanceTimersByTimeAsync(DRAIN_SETTLE_MS - 1);
    expect(stops).toEqual([]);
    clock.now = 45_000;
    await vi.advanceTimersByTimeAsync(1);
    expect(stops).toEqual([{ drainKey: "drain:bind-a:e1", reason: "offboard" }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(acts.filter((act) => act.startsWith("record"))).toEqual([
      "record a s1 detached at 1000",
      "record a s1 ended settled at 45000",
    ]);
    expect(drain.drainingSessionIds("a")).toEqual([]);
  });

  it("an idle that does not last is not the end of its turn", async () => {
    const { stops, reads, ports } = rig();
    await rotateSeatSession("a", ports(seatOf("bind-a")));
    reads("drain:bind-a:e1", "idle");
    await vi.advanceTimersByTimeAsync(DRAIN_SETTLE_MS - 1);
    reads("drain:bind-a:e1", "working");
    await vi.advanceTimersByTimeAsync(DRAIN_SETTLE_MS * 3);
    expect(stops).toEqual([]);
  });

  it("the cap stops one that never settles, and the record says the cap ended it", async () => {
    const { acts, stops, ports } = rig();
    await rotateSeatSession("a", ports(seatOf("bind-a")));
    await vi.advanceTimersByTimeAsync(DRAIN_CAP_MS);
    expect(stops).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(acts.at(-1)).toMatch(/^record a s1 ended cap at /);
  });

  it("one that dies by itself is recorded as crashed", async () => {
    const { acts, exit, ports } = rig();
    await rotateSeatSession("a", ports(seatOf("bind-a")));
    exit("drain:bind-a:e1", 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(acts.at(-1)).toMatch(/^record a s1 ended crashed at /);
  });

  it("quitting records what was still winding down as ended by the quit", async () => {
    const { acts, drain, ports } = rig();
    await rotateSeatSession("a", ports(seatOf("bind-a")));
    await rotateSeatSession("b", ports(seatOf("bind-b", "s9")));
    drain.quit();
    await vi.advanceTimersByTimeAsync(0);
    expect(acts.filter((act) => act.includes("ended"))).toEqual([
      "record a s1 ended quit at 1000",
      "record b s9 ended quit at 1000",
    ]);
  });

  it("many seats at once, and a seat offboarding again while its last session winds down", async () => {
    const { drain, stops, reads, ports } = rig();
    await Promise.all([
      rotateSeatSession("a", ports(seatOf("bind-a", "a1"))),
      rotateSeatSession("b", ports(seatOf("bind-b", "b1"))),
      rotateSeatSession("c", ports(seatOf("bind-c", "c1"))),
    ]);
    await rotateSeatSession("a", ports(seatOf("bind-a", "a2")));
    expect(drain.drainingSessionIds("a")).toEqual(["a1", "a2"]);
    expect(drain.drainingSessionIds("b")).toEqual(["b1"]);
    // One settles; the others are untouched.
    reads("drain:bind-b:e2", "idle");
    await vi.advanceTimersByTimeAsync(DRAIN_SETTLE_MS);
    expect(stops.map((stop) => stop.drainKey)).toEqual(["drain:bind-b:e2"]);
    await vi.advanceTimersByTimeAsync(0);
    expect(drain.drainingSessionIds("b")).toEqual([]);
    expect(drain.drainingSessionIds("a")).toEqual(["a1", "a2"]);
    expect(drain.drainingSessionIds("c")).toEqual(["c1"]);
  });

  it("a process that cannot be left to wind down is stopped, and the seat waits only for that", async () => {
    const { acts, drain, ports } = rig({ drainable: false });
    expect(await rotateSeatSession("a", ports(seatOf("bind-a")))).toMatchObject({ ok: true, woke: true });
    expect(acts).toEqual(["stop bind-a", "end a s1", "write a fresh", "wake a"]);
    expect(drain.drainingSessionIds("a")).toEqual([]);
  });

  it("a seat that could not be given a fresh session has its detached process stopped at once", async () => {
    const { acts, stops, drain, ports } = rig();
    const result = await rotateSeatSession("a", ports(seatOf("bind-a"), { writeSessionId: async () => false }));
    expect(result).toMatchObject({ ok: false });
    expect(stops).toEqual([{ drainKey: "drain:bind-a:e1", reason: "offboard" }]);
    expect(drain.drainingSessionIds("a")).toEqual([]);
    await vi.advanceTimersByTimeAsync(0);
    // The session is the seat's again: no wind-down stays on its record, and
    // nothing says it settled, hit the cap or crashed.
    expect(acts.filter((act) => act.startsWith("record"))).toEqual([
      "record a s1 detached at 1000",
      "record a s1 was not offboarded",
    ]);
    expect(acts).toContain("reopen a s1");
  });

  it("that stop is bounded: a process that will not go does not hold the seat", async () => {
    const { exitOnStop, ports } = rig();
    exitOnStop.value = false;
    let settled = false;
    const closing = rotateSeatSession("a", ports(seatOf("bind-a"), { writeSessionId: async () => false })).then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await closing;
    expect(settled).toBe(true);
  });

  it("a seat that named no session is drained all the same, with nothing to write beside", async () => {
    const { acts, stops, reads, ports } = rig();
    await rotateSeatSession("a", ports(seatOf("bind-a", null)));
    reads("drain:bind-a:e1", "idle");
    await vi.advanceTimersByTimeAsync(DRAIN_SETTLE_MS);
    expect(stops).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(0);
    expect(acts.filter((act) => act.startsWith("record"))).toEqual([]);
  });
});
