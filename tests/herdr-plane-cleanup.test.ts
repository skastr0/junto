import { afterEach, describe, expect, it, vi } from "vitest";
import {
  makeBoundedRemoteClose,
  runHerdrCleanupSteps,
} from "../src/main/vellum/herdr/plane";

describe("Herdr plane cleanup fan-out", () => {
  it("runs every finalizer component when an earlier component throws", async () => {
    const calls: string[] = [];

    await expect(
      runHerdrCleanupSteps([
        () => {
          calls.push("streams");
          throw new Error("stream cleanup failed");
        },
        () => {
          calls.push("mirrors");
        },
        () => {
          calls.push("service-map");
        },
      ]),
    ).resolves.toBeUndefined();

    expect(calls).toEqual(["streams", "mirrors", "service-map"]);
  });

  it("starts every independent cleanup before awaiting any one", async () => {
    const calls: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });

    const cleanup = runHerdrCleanupSteps([
      () => {
        calls.push("streams:start");
        return blocked.then(() => {
          calls.push("streams:done");
        });
      },
      () => {
        calls.push("mirrors");
      },
      () => {
        calls.push("service-map");
      },
    ]);

    expect(calls).toEqual(["streams:start", "mirrors", "service-map"]);
    release();
    await cleanup;
    expect(calls.at(-1)).toBe("streams:done");
  });
});

describe("bounded remote Herdr scope close", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("coalesces callers onto one close flight and reports proven closure", async () => {
    let release!: () => void;
    let closeCalls = 0;
    const closeScope = new Promise<void>((resolve) => {
      release = resolve;
    });
    const close = makeBoundedRemoteClose(() => {
      closeCalls += 1;
      return closeScope;
    }, 100);

    const first = close();
    const second = close();
    expect(second).toBe(first);
    expect(closeCalls).toBe(1);
    release();
    await expect(first).resolves.toEqual({ status: "closed" });
  });

  it("reports a timeout without pretending the scope closed", async () => {
    vi.useFakeTimers();
    const close = makeBoundedRemoteClose(
      () => new Promise<void>(() => undefined),
      25,
    );

    const receipt = close();
    await vi.advanceTimersByTimeAsync(25);
    await expect(receipt).resolves.toEqual({ status: "timed-out", timeoutMs: 25 });
  });

  it("contains synchronous close defects as failed receipts", async () => {
    const close = makeBoundedRemoteClose(() => {
      throw new Error("scope close defect");
    });

    await expect(close()).resolves.toEqual({
      status: "failed",
      message: "scope close defect",
    });
  });
});
