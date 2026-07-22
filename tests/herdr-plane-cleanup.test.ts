import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createHerdrShutdownController,
  createHerdrOperationShutdownTracker,
  createHerdrRemoteScopeShutdownTracker,
  makeBoundedRemoteClose,
  proveHerdrProtocolReadyAfterOsHandoff,
} from "../src/main/vellum/herdr/plane";
import { cleanHerdrComponentReceipt } from "../src/main/vellum/herdr/shutdown";

describe("local Herdr daemon readiness", () => {
  it("does not confuse OS handoff with successful protocol readiness", async () => {
    const protocolProbe = vi.fn(async () => false);

    await expect(
      proveHerdrProtocolReadyAfterOsHandoff(
        Promise.resolve({ ready: true }),
        protocolProbe,
      ),
    ).resolves.toBe(false);
    expect(protocolProbe).toHaveBeenCalledOnce();
  });

  it("does not probe when OS handoff itself fails", async () => {
    const protocolProbe = vi.fn(async () => true);

    await expect(
      proveHerdrProtocolReadyAfterOsHandoff(
        Promise.reject(new Error("spawn failed")),
        protocolProbe,
      ),
    ).rejects.toThrow("spawn failed");
    expect(protocolProbe).not.toHaveBeenCalled();
  });
});

describe("Herdr plane cleanup fan-out", () => {
  it("cuts every admission synchronously, coalesces drains, and reuses the proven receipt", async () => {
    const calls: string[] = [];
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const controller = createHerdrShutdownController({
      controls: {
        beginShutdown: () => calls.push("controls:cut"),
        drainOnQuit: async () => {
          calls.push("controls:drain");
          await blocked;
          return cleanHerdrComponentReceipt();
        },
      },
      mirrors: {
        beginShutdown: () => calls.push("mirrors:cut"),
        drainOnQuit: async () => {
          calls.push("mirrors:drain");
          return cleanHerdrComponentReceipt();
        },
      },
    });

    controller.beginShutdown();
    expect(calls).toEqual(["controls:cut", "mirrors:cut"]);
    const first = controller.drainOnQuit();
    const second = controller.drainOnQuit();
    expect(second).toBe(first);
    expect(calls).toEqual([
      "controls:cut",
      "mirrors:cut",
      "controls:drain",
      "mirrors:drain",
    ]);
    release();
    const receipt = await first;
    expect(receipt).toMatchObject({ clean: true, retained: 0 });
    expect(receipt.server).toEqual({
      clean: true,
      retained: 0,
      excluded: true,
      lifetime: "daemon-outlives-app",
      reason: "independent-daemon-never-app-owned",
    });
    await expect(controller.drainOnQuit()).resolves.toBe(receipt);
    expect(calls.filter((call) => call.endsWith(":drain"))).toHaveLength(2);
  });

  it("turns a rejected component drain into an unclean retained receipt", async () => {
    const controller = createHerdrShutdownController({
      streams: {
        beginShutdown: () => undefined,
        drainOnQuit: async () => {
          throw new Error("scope finalizer rejected");
        },
      },
    });

    await expect(controller.drainOnQuit()).resolves.toMatchObject({
      clean: false,
      retained: 1,
      causes: [{
        component: "streams",
        code: "component-drain-failed",
        message: "scope finalizer rejected",
      }],
    });
  });

  it("publishes aggregate identity before a component synchronously re-enters", async () => {
    let nested: Promise<unknown> | undefined;
    let controller!: ReturnType<typeof createHerdrShutdownController>;
    controller = createHerdrShutdownController({
      reentrant: {
        beginShutdown: () => undefined,
        drainOnQuit: () => {
          nested = controller.drainOnQuit();
          return Promise.resolve(cleanHerdrComponentReceipt());
        },
      },
    });

    const outer = controller.drainOnQuit();
    expect(nested).toBe(outer);
    await expect(outer).resolves.toMatchObject({ clean: true, retained: 0 });
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

  it("reports a late terminal witness after an earlier bounded timeout", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    let closeCalls = 0;
    const underlying = new Promise<void>((resolve) => {
      release = resolve;
    });
    const close = makeBoundedRemoteClose(() => {
      closeCalls += 1;
      return underlying;
    }, 25);

    const first = close();
    await vi.advanceTimersByTimeAsync(25);
    await expect(first).resolves.toEqual({ status: "timed-out", timeoutMs: 25 });
    release();
    await Promise.resolve();
    await expect(close()).resolves.toEqual({ status: "closed" });
    expect(closeCalls).toBe(1);
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

describe("remote Herdr scope shutdown accounting", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retains a failed mirror-forward scope instead of reporting retained zero", async () => {
    const tracker = createHerdrRemoteScopeShutdownTracker(25);
    tracker.registerScope(async () => ({
      status: "failed",
      message: "scope finalizer rejected",
    }));

    await expect(tracker.drainOnQuit()).resolves.toMatchObject({
      clean: false,
      retained: 1,
      causes: [{
        code: "mirror-forward-close-failed",
        message: "scope finalizer rejected",
      }],
    });
  });

  it("converges cleanly after a timed-out scope later proves closure", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const underlying = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tracker = createHerdrRemoteScopeShutdownTracker(40);
    tracker.registerScope(makeBoundedRemoteClose(() => underlying, 25));

    const first = tracker.drainOnQuit();
    await vi.advanceTimersByTimeAsync(25);
    await expect(first).resolves.toMatchObject({
      clean: false,
      retained: 1,
      causes: expect.arrayContaining([
        expect.objectContaining({ code: "mirror-forward-close-timed-out" }),
      ]),
    });

    release();
    await Promise.resolve();
    await expect(tracker.drainOnQuit()).resolves.toMatchObject({
      clean: true,
      retained: 0,
    });
  });
});

describe("background Herdr operation shutdown accounting", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("retains an admitted warm and permanently refuses late warm work", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const admitted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tracker = createHerdrOperationShutdownTracker("herdr-warm", 25);
    void tracker.run(() => admitted);
    const first = tracker.drainOnQuit();
    await vi.advanceTimersByTimeAsync(25);
    await expect(first).resolves.toMatchObject({
      clean: false,
      retained: 1,
      causes: [expect.objectContaining({ code: "herdr-warm-retained" })],
    });

    const late = vi.fn(async () => undefined);
    await tracker.run(late);
    expect(late).not.toHaveBeenCalled();

    release();
    await Promise.resolve();
    await expect(tracker.drainOnQuit()).resolves.toMatchObject({
      clean: true,
      retained: 0,
    });
  });
});
