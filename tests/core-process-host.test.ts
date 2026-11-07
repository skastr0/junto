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
const forkedPaths: string[] = [];

vi.mock("electron", () => ({
  utilityProcess: {
    fork: (path: string) => {
      forkedPaths.push(path);
      const child = new FakeChild();
      forks.push(child);
      return child;
    },
  },
}));

const { startCoreProcess } = await import("../src/app/core-process/host");

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
  it("forks the entry built beside main's index.js, wherever this module's chunk lands", () => {
    forkedPaths.length = 0;
    const core = startCoreProcess(BOOT);
    expect(forkedPaths).toEqual(["/a/out/main/core-process.js"]);
    core.stop();
  });

  it("forks the entry an E2E launch names, and never outside an E2E run", () => {
    forkedPaths.length = 0;
    try {
      process.env.JUNTO_E2E = "1";
      process.env.JUNTO_E2E_CORE_ENTRY = "/tmp/core-that-fails-at-boot.mjs";
      const scenario = startCoreProcess(BOOT);
      expect(forkedPaths).toEqual(["/tmp/core-that-fails-at-boot.mjs"]);
      scenario.stop();

      delete process.env.JUNTO_E2E;
      forkedPaths.length = 0;
      const product = startCoreProcess(BOOT);
      expect(forkedPaths).toEqual(["/a/out/main/core-process.js"]);
      product.stop();
    } finally {
      delete process.env.JUNTO_E2E;
      delete process.env.JUNTO_E2E_CORE_ENTRY;
    }
  });

  it("kills a core that is not ready by its boot deadline, tells its link it left, and starts another", async () => {
    const core = startCoreProcess(BOOT);
    const heard: unknown[] = [];
    core.link.listen((message) => heard.push(message));
    await vi.advanceTimersByTimeAsync(119_000);
    expect(forks[0]!.killed).toBe(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(forks[0]!.killed).toBe(1);
    expect(heard).toEqual([expect.objectContaining({ kind: "down" })]);
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

  it("sends a request made while the core restarts to the next core", async () => {
    const core = startCoreProcess(BOOT);
    forks[0]!.kill();
    await vi.advanceTimersByTimeAsync(0);
    core.link.post({ kind: "rpc", client: 1, data: { _tag: "Request", tag: "Ask" } });
    expect(forks).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(forks[1]!.posted).toEqual([expect.objectContaining({ kind: "rpc", client: 1 })]);
    core.stop();
  });

  it("refuses a request made after stop instead of leaving it waiting", async () => {
    const core = startCoreProcess(BOOT);
    core.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(() => core.link.post({ kind: "rpc", client: 1, data: {} })).toThrow(/stopped/u);
  });

  it("does not start another after stop during boot", async () => {
    const core = startCoreProcess(BOOT);
    core.stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(forks).toHaveLength(1);
    expect(forks[0]!.killed).toBe(1);
  });
});
