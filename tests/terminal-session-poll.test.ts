import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TerminalSessionSummary } from "../src/shared/terminal";
import {
  __resetTerminalSessionPollForTests,
  registerTerminalSessionPoll,
} from "../src/renderer/lib/terminal-session-poll";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const POLL_MS = 2500;

const summary = (
  over: Partial<TerminalSessionSummary> & { readonly bindingId: string },
): TerminalSessionSummary => ({
  epoch: "e1",
  hostId: "local",
  status: "running",
  detached: false,
  createdAt: 1,
  ...over,
});

type TerminalListFn = (
  hostId?: string,
) => Promise<readonly TerminalSessionSummary[]>;

const installApi = (terminalList: TerminalListFn): void => {
  (
    globalThis as unknown as {
      window: { vellumCommand: { terminalList: TerminalListFn } };
    }
  ).window = { vellumCommand: { terminalList } };
};

let setIntervalSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.useFakeTimers();
  // Spy AFTER useFakeTimers so the spy wraps the fake, not the real timer.
  setIntervalSpy = vi.spyOn(globalThis, "setInterval");
});

afterEach(() => {
  __resetTerminalSessionPollForTests();
  setIntervalSpy.mockRestore();
  vi.useRealTimers();
  delete (globalThis as { window?: unknown }).window;
});

describe("registerTerminalSessionPoll", () => {
  it("charges 48 cards one timer and one batch read per tick, not 48 of each", async () => {
    const bindingIds = Array.from({ length: 48 }, (_, i) => `b${i}`);
    const terminalList = vi.fn<TerminalListFn>(async () =>
      bindingIds.map((bindingId) => summary({ bindingId, pid: 100 })),
    );
    installApi(terminalList);

    const listeners = bindingIds.map(() => vi.fn());
    const offs = bindingIds.map((bindingId, i) =>
      registerTerminalSessionPoll(bindingId, undefined, listeners[i]!),
    );

    // The whole point: N registrations, one interval.
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy.mock.calls[0]?.[1]).toBe(POLL_MS);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(terminalList).toHaveBeenCalledTimes(1);
    for (const listener of listeners) expect(listener).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(terminalList).toHaveBeenCalledTimes(2);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    for (const off of offs) off();
  });

  it("hands each card its own row and reports an absent binding as no session", async () => {
    const terminalList = vi.fn<TerminalListFn>(async () => [
      summary({ bindingId: "b1", pid: 11 }),
      summary({ bindingId: "b2", pid: 22, status: "exited" }),
    ]);
    installApi(terminalList);

    const first = vi.fn();
    const second = vi.fn();
    const gone = vi.fn();
    registerTerminalSessionPoll("b1", undefined, first);
    registerTerminalSessionPoll("b2", undefined, second);
    registerTerminalSessionPoll("b3", undefined, gone);

    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(first).toHaveBeenCalledWith(
      expect.objectContaining({ bindingId: "b1", pid: 11 }),
    );
    expect(second).toHaveBeenCalledWith(
      expect.objectContaining({ bindingId: "b2", status: "exited" }),
    );
    // Parity with terminalGet: not in the host's list means no live session.
    expect(gone).toHaveBeenCalledWith(undefined);
  });

  it("delivers to every card even when one listener throws", async () => {
    installApi(async () => [summary({ bindingId: "b1" }), summary({ bindingId: "b2" })]);
    const angry = vi.fn(() => {
      throw new Error("render blew up");
    });
    const calm = vi.fn();
    registerTerminalSessionPoll("b1", undefined, angry);
    registerTerminalSessionPoll("b2", undefined, calm);

    await vi.advanceTimersByTimeAsync(POLL_MS);

    expect(angry).toHaveBeenCalledTimes(1);
    expect(calm).toHaveBeenCalledTimes(1);
  });

  it("stops the timer when the last card leaves and restarts for a new one", async () => {
    const terminalList = vi.fn<TerminalListFn>(async () => []);
    installApi(terminalList);

    const offA = registerTerminalSessionPoll("b1", undefined, vi.fn());
    const offB = registerTerminalSessionPoll("b2", undefined, vi.fn());
    expect(vi.getTimerCount()).toBe(1);

    offA();
    expect(vi.getTimerCount()).toBe(1);
    offB();
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(POLL_MS * 4);
    expect(terminalList).not.toHaveBeenCalled();

    registerTerminalSessionPoll("b1", undefined, vi.fn());
    expect(setIntervalSpy).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(terminalList).toHaveBeenCalledTimes(1);
  });

  it("survives a remount that registers before the old cleanup runs", async () => {
    installApi(async () => [summary({ bindingId: "b1" })]);
    const before = vi.fn();
    const after = vi.fn();

    const offBefore = registerTerminalSessionPoll("b1", undefined, before);
    // React strict/remount order: new effect registers, then old cleanup fires.
    registerTerminalSessionPoll("b1", undefined, after);
    offBefore();
    offBefore(); // idempotent — a double cleanup must not drop the survivor

    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(POLL_MS);
    expect(after).toHaveBeenCalledTimes(1);
    expect(before).not.toHaveBeenCalled();
  });

  it("batches per host so one bad host cannot stall the others", async () => {
    let stalledCalls = 0;
    const terminalList = vi.fn<TerminalListFn>(async (hostId?: string) => {
      if (hostId === "stalled") {
        stalledCalls += 1;
        // Never settles — a wedged Station mid host-activation.
        return new Promise<readonly TerminalSessionSummary[]>(() => undefined);
      }
      return [summary({ bindingId: "healthy-1", hostId: "local" })];
    });
    installApi(terminalList);

    const healthy = vi.fn();
    registerTerminalSessionPoll("healthy-1", undefined, healthy);
    registerTerminalSessionPoll("stalled-1", "stalled", vi.fn());

    await vi.advanceTimersByTimeAsync(POLL_MS * 3);

    // The healthy host keeps its cadence...
    expect(healthy).toHaveBeenCalledTimes(3);
    // ...and the wedged host never piles up a second in-flight read.
    expect(stalledCalls).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("drops a repeatedly failing host to the degraded cadence and recovers", async () => {
    let fail = true;
    const failingCalls: number[] = [];
    const terminalList = vi.fn<TerminalListFn>(async (hostId?: string) => {
      if (hostId !== "flaky") return [summary({ bindingId: "healthy-1" })];
      failingCalls.push(Date.now());
      if (fail) throw new Error("host unreachable");
      return [summary({ bindingId: "flaky-1", hostId: "flaky" })];
    });
    installApi(terminalList);

    const healthy = vi.fn();
    const flaky = vi.fn();
    registerTerminalSessionPoll("healthy-1", undefined, healthy);
    registerTerminalSessionPoll("flaky-1", "flaky", flaky);

    // Two consecutive failures trip the breaker; every later tick is skipped.
    // Second failure lands at t=5000, so the degraded probe is due at t=65000.
    await vi.advanceTimersByTimeAsync(POLL_MS * 10);
    expect(failingCalls.length).toBe(2);
    // A failed batch never publishes — cards keep their last painted session.
    expect(flaky).not.toHaveBeenCalled();
    // The healthy host is untouched by its neighbour's breaker.
    expect(healthy).toHaveBeenCalledTimes(10);

    // t=64999: 23 more ticks the un-broken cadence would have spent on a host
    // that is down. The breaker spent none of them.
    await vi.advanceTimersByTimeAsync(39_999);
    expect(failingCalls.length).toBe(2);
    expect(healthy).toHaveBeenCalledTimes(25);

    // t=65000 is the half-open probe: it retries, and a success closes the
    // breaker back to the normal cadence.
    fail = false;
    await vi.advanceTimersByTimeAsync(1);
    expect(failingCalls.length).toBe(3);
    expect(flaky).toHaveBeenCalledWith(
      expect.objectContaining({ bindingId: "flaky-1" }),
    );

    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(failingCalls.length).toBe(6);
  });

  it("is inert when the preload bridge has no terminalList yet", async () => {
    (globalThis as unknown as { window: { vellumCommand: object } }).window = {
      vellumCommand: {},
    };
    const listener = vi.fn();
    registerTerminalSessionPoll("b1", undefined, listener);
    await vi.advanceTimersByTimeAsync(POLL_MS * 3);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("card wiring", () => {
  const source = readFileSync(
    join(root, "src/renderer/components/terminal/TerminalCard.tsx"),
    "utf8",
  );

  it("registers in the shared poller instead of arming its own interval", () => {
    expect(source).toContain("registerTerminalSessionPoll");
    // Teeth: reinstating a per-card window.setInterval(refresh, 2500) — the
    // 48-timer, ~19-IPC/s shape this replaced — fails right here.
    expect(source).not.toMatch(/setInterval/u);
    expect(source).not.toMatch(/clearInterval/u);
  });

  it("keeps the event-driven refresh as the primary signal", () => {
    expect(source).toContain("onTerminalEvent");
    expect(source).toMatch(
      /if \(!shouldRefreshSessionFromTerminalEvent\(raw\)\) return;/u,
    );
  });
});
