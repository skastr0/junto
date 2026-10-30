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
  app: { getAppPath: () => "/app" },
  utilityProcess: {
    fork: (path: string) => {
      forkedPaths.push(path);
      const child = new FakeChild();
      forks.push(child);
      return child;
    },
  },
}));

const { startCoreProcess } = await import("../src/main/core-process/host");
const { hostOps } = await import("../src/main/core-process/host-ops");

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
    expect(forkedPaths).toEqual(["/app/out/main/core-process.js"]);
    core.stop();
  });

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

  it("sends a call made while the core restarts to the next core", async () => {
    const core = startCoreProcess(BOOT);
    forks[0]!.kill();
    await vi.advanceTimersByTimeAsync(0);
    void core.call("model.canvases" as never, {} as never).catch(() => undefined);
    expect(forks).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(forks[1]!.posted).toEqual([expect.objectContaining({ kind: "call", name: "model.canvases" })]);
    core.stop();
  });

  it("never hands an old core's host answer to the next core", async () => {
    const answers: Array<(value: unknown) => void> = [];
    const off = hostOps({ "test.slow": () => new Promise((resolve) => answers.push(resolve)) } as never);
    const core = startCoreProcess(BOOT);
    forks[0]!.emit("message", { kind: "hostCall", id: 1, name: "test.slow", input: {} });
    forks[0]!.kill();
    await vi.advanceTimersByTimeAsync(1_000);
    // The new core asks with the same id while the old core's call still runs in main.
    forks[1]!.emit("message", { kind: "hostCall", id: 1, name: "test.slow", input: {} });
    answers[0]!("old");
    await vi.advanceTimersByTimeAsync(0);
    expect(forks[1]!.posted).toEqual([]);
    answers[1]!("new");
    await vi.advanceTimersByTimeAsync(0);
    expect(forks[1]!.posted).toEqual([{ kind: "hostAnswer", id: 1, ok: true, value: "new" }]);
    off();
    core.stop();
  });

  it("fails a call made after stop instead of leaving it waiting", async () => {
    const core = startCoreProcess(BOOT);
    core.stop();
    await vi.advanceTimersByTimeAsync(0);
    const late = core.call("model.canvases" as never, {} as never).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(await late).toMatchObject({ tag: "CoreStopped" });
  });

  it("does not start another after stop during boot", async () => {
    const core = startCoreProcess(BOOT);
    core.stop();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(forks).toHaveLength(1);
    expect(forks[0]!.killed).toBe(1);
  });
});
