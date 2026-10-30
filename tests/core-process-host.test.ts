import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The core process host forks an Electron utilityProcess; here each fork is a
// stand-in child whose kill exits it, as Electron's does.
class FakeChild extends EventEmitter {
  killed = 0;
  readonly posted: unknown[] = [];
  postMessage(message: unknown): void {
    this.posted.push(message);
  }
  kill(): boolean {
    this.killed += 1;
    queueMicrotask(() => this.emit("exit", 15));
    return true;
  }
}
const forks: FakeChild[] = [];

vi.mock("electron", () => ({
  utilityProcess: {
    fork: () => {
      const child = new FakeChild();
      forks.push(child);
      return child;
    },
  },
}));
vi.mock("../src/main/core-process/entry?modulePath", () => ({ default: "/core-entry.js" }));

const { startCoreProcess } = await import("../src/main/core-process/host");

const BOOT = {
  home: "/home", build: "test", bundlesRoot: "/bundles", operatorCommands: false,
  app: { version: "0.0.0", packaged: false, resourcesPath: "/r", appPath: "/a" },
};

beforeEach(() => {
  forks.length = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("the core process host", () => {
  it("kills a core that is not ready by its boot deadline, fails its calls, and starts another", async () => {
    const core = startCoreProcess(BOOT);
    const call = core.call("model.canvases" as never, {} as never);
    const failed = call.catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(119_000);
    expect(forks[0]!.killed).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(forks[0]!.killed).toBe(1);
    expect(await failed).toMatchObject({ tag: "CoreStopped" });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(forks).toHaveLength(2);
    core.stop();
  });

  it("keeps a core that says ready", async () => {
    const core = startCoreProcess(BOOT);
    forks[0]!.emit("message", { kind: "push", channel: "core.ready", payload: {} });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(forks[0]!.killed).toBe(0);
    expect(forks).toHaveLength(1);
    core.stop();
  });

  it("does not start another after stop during boot", async () => {
    const core = startCoreProcess(BOOT);
    core.stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(forks).toHaveLength(1);
    expect(forks[0]!.killed).toBe(1);
  });
});
