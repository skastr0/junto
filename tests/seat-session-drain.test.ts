/**
 * The drain manager: after `junto offboard` the old process is detached from
 * its seat and left to finish its turn. Junto keeps reading it and stops it
 * when it settles, or at the cap. How it ended goes on record.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DRAIN_CAP_MS,
  DRAIN_SETTLE_MS,
  SessionDrainManager,
  type DrainEnd,
  type DrainingSession,
} from "../src/main/junto/seat-sessions/drain";

beforeEach(() => {
  vi.useFakeTimers({ now: 1_000_000 });
});
afterEach(() => {
  vi.useRealTimers();
});

const session = (over: Partial<DrainingSession> = {}): DrainingSession => ({
  seatId: "seat-a",
  sessionId: "s1",
  drainKey: "drain:bind-a:e1",
  ...over,
});

/** Processes the test starts idle or working, and a record of what the manager did. */
const rig = (over: { stopTakesMs?: number; stopNeverEnds?: boolean } = {}) => {
  const idle = new Set<string>();
  const alive = new Set<string>();
  const stops: Array<{ drainKey: string; at: number }> = [];
  const began: Array<DrainingSession & { at: number }> = [];
  const ended: Array<{ sessionId: string; how: DrainEnd; at: number }> = [];
  const manager = new SessionDrainManager({
    isIdle: (drainKey) => idle.has(drainKey),
    stop: (drainKey) => {
      stops.push({ drainKey, at: Date.now() });
      if (over.stopNeverEnds) return;
      setTimeout(() => {
        if (!alive.delete(drainKey)) return;
        manager.noteExit(drainKey, 143);
      }, over.stopTakesMs ?? 50);
    },
    record: {
      begin: (draining, at) => began.push({ ...draining, at }),
      end: (draining, how, at) => ended.push({ sessionId: draining.sessionId, how, at }),
    },
    now: () => Date.now(),
  });
  const begin = (draining: DrainingSession = session()) => {
    alive.add(draining.drainKey);
    manager.begin(draining);
  };
  const goIdle = (drainKey = session().drainKey) => {
    idle.add(drainKey);
    manager.noteState(drainKey);
  };
  const goBusy = (drainKey = session().drainKey) => {
    idle.delete(drainKey);
    manager.noteState(drainKey);
  };
  return { manager, idle, alive, stops, began, ended, begin, goIdle, goBusy };
};

describe("SessionDrainManager", () => {
  it("records the drain as begun and stops nothing while the process works", async () => {
    const { manager, stops, began, begin } = rig();
    begin();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(began).toEqual([expect.objectContaining({ sessionId: "s1", at: 1_000_000 })]);
    expect(stops).toEqual([]);
    expect(manager.draining()).toEqual([expect.objectContaining({ sessionId: "s1" })]);
  });

  it("stops the process once it reads idle and stays so for the settle, and records that it settled", async () => {
    const { manager, stops, ended, begin, goIdle } = rig();
    begin();
    await vi.advanceTimersByTimeAsync(30_000);
    goIdle();
    await vi.advanceTimersByTimeAsync(DRAIN_SETTLE_MS - 1);
    expect(stops).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(stops).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(ended).toEqual([{ sessionId: "s1", how: "settled", at: 1_000_000 + 30_000 + DRAIN_SETTLE_MS + 50 }]);
    expect(manager.draining()).toEqual([]);
  });

  it("a turn that starts again before the settle is up restarts the wait", async () => {
    const { stops, begin, goIdle, goBusy } = rig();
    begin();
    goIdle();
    await vi.advanceTimersByTimeAsync(DRAIN_SETTLE_MS - 1);
    goBusy();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(stops).toEqual([]);
    goIdle();
    await vi.advanceTimersByTimeAsync(DRAIN_SETTLE_MS);
    expect(stops).toHaveLength(1);
  });

  it("a process already idle when it is detached still gets its settle, then is stopped", async () => {
    const { idle, stops, begin } = rig();
    idle.add(session().drainKey);
    begin();
    await vi.advanceTimersByTimeAsync(DRAIN_SETTLE_MS);
    expect(stops).toHaveLength(1);
  });

  it("stops it at the cap whatever it is doing, and records that the cap ended it", async () => {
    const { stops, ended, begin } = rig();
    begin();
    await vi.advanceTimersByTimeAsync(DRAIN_CAP_MS - 1);
    expect(stops).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(stops).toEqual([{ drainKey: "drain:bind-a:e1", at: 1_000_000 + DRAIN_CAP_MS }]);
    await vi.advanceTimersByTimeAsync(100);
    expect(ended.map((end) => end.how)).toEqual(["cap"]);
  });

  it("the cap is ten minutes", () => {
    expect(DRAIN_CAP_MS).toBe(10 * 60 * 1_000);
  });

  it("a process that exits by itself is recorded by its exit: clean is settled, otherwise crashed", async () => {
    const clean = rig();
    clean.begin();
    clean.manager.noteExit("drain:bind-a:e1", 0);
    expect(clean.ended.map((end) => end.how)).toEqual(["settled"]);
    expect(clean.stops).toEqual([]);

    const crashed = rig();
    crashed.begin();
    crashed.manager.noteExit("drain:bind-a:e1", 1);
    expect(crashed.ended.map((end) => end.how)).toEqual(["crashed"]);

    const signalled = rig();
    signalled.begin();
    signalled.manager.noteExit("drain:bind-a:e1", undefined);
    expect(signalled.ended.map((end) => end.how)).toEqual(["crashed"]);
  });

  it("is stopped once: neither the cap nor a late idle sends a second stop", async () => {
    const { stops, ended, begin, goIdle } = rig({ stopNeverEnds: true });
    begin();
    goIdle();
    await vi.advanceTimersByTimeAsync(DRAIN_SETTLE_MS);
    goIdle();
    await vi.advanceTimersByTimeAsync(DRAIN_CAP_MS * 2);
    expect(stops).toHaveLength(1);
    // The host's own bound declares it gone; until then it is still draining.
    expect(ended).toEqual([]);
  });

  it("every drain is its own: two sessions of one seat, and other seats, do not wait on each other", async () => {
    const { manager, stops, ended, begin, goIdle } = rig();
    const first = session({ sessionId: "s1", drainKey: "drain:bind-a:e1" });
    const second = session({ sessionId: "s2", drainKey: "drain:bind-a:e2" });
    const other = session({ seatId: "seat-b", sessionId: "t1", drainKey: "drain:bind-b:e1" });
    begin(first);
    await vi.advanceTimersByTimeAsync(60_000);
    // The fresh session offboards too while the first is still winding down.
    begin(second);
    begin(other);
    expect(manager.draining().map((draining) => draining.sessionId)).toEqual(["s1", "s2", "t1"]);
    goIdle(second.drainKey);
    await vi.advanceTimersByTimeAsync(DRAIN_SETTLE_MS + 100);
    expect(stops.map((stop) => stop.drainKey)).toEqual([second.drainKey]);
    expect(ended.map((end) => end.sessionId)).toEqual(["s2"]);
    // The first is capped on its own clock, counted from its own detach.
    await vi.advanceTimersByTimeAsync(DRAIN_CAP_MS - 60_000 - DRAIN_SETTLE_MS - 100);
    expect(stops.map((stop) => stop.drainKey)).toEqual([second.drainKey, first.drainKey]);
    // Its process takes a moment to go; then only the other seat's is left.
    await vi.advanceTimersByTimeAsync(100);
    expect(ended.map((end) => [end.sessionId, end.how])).toEqual([["s2", "settled"], ["s1", "cap"]]);
    expect(manager.draining().map((draining) => draining.sessionId)).toEqual(["t1"]);
  });

  it("at quit every drain still open is recorded as ended by Junto quitting, and no timer is left", () => {
    const { manager, ended, begin } = rig();
    begin(session({ sessionId: "s1", drainKey: "drain:bind-a:e1" }));
    begin(session({ sessionId: "s2", drainKey: "drain:bind-a:e2" }));
    manager.quit();
    expect(ended.map((end) => [end.sessionId, end.how])).toEqual([["s1", "quit"], ["s2", "quit"]]);
    expect(manager.draining()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    // The exits that follow the shutdown's own signals change nothing.
    manager.noteExit("drain:bind-a:e1", 143);
    expect(ended).toHaveLength(2);
  });

  it("events for a key it is not draining are ignored", () => {
    const { manager, stops, ended } = rig();
    expect(() => manager.noteState("drain:nope:e9")).not.toThrow();
    expect(() => manager.noteExit("drain:nope:e9", 0)).not.toThrow();
    expect(stops).toEqual([]);
    expect(ended).toEqual([]);
  });

  it("a record that throws does not stop the drain from being managed", async () => {
    const stops: string[] = [];
    const manager = new SessionDrainManager({
      isIdle: () => true,
      stop: (drainKey) => void stops.push(drainKey),
      record: {
        begin: () => {
          throw new Error("database is closed");
        },
        end: () => {
          throw new Error("database is closed");
        },
      },
      now: () => Date.now(),
    });
    manager.begin(session());
    await vi.advanceTimersByTimeAsync(DRAIN_SETTLE_MS);
    expect(stops).toEqual(["drain:bind-a:e1"]);
    expect(() => manager.noteExit("drain:bind-a:e1", 143)).not.toThrow();
    expect(manager.draining()).toEqual([]);
  });
});
