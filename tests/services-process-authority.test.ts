import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  resolvedSpawnEnv: vi.fn(async () => ({ PATH: "/usr/bin:/bin" })),
  handles: [] as unknown[],
}));

vi.mock("../src/main/junto/process-epoch", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/main/junto/process-epoch")>();
  return {
    ...actual,
    captureChildProcessEpoch: (pid: number) => ({
      pid,
      startKey: `test-child-${pid}`,
    }),
    childProcessEpochIsCurrent: (
      pid: number,
      epoch: { readonly pid: number; readonly startKey: string },
    ) => epoch.pid === pid && epoch.startKey === `test-child-${pid}`,
  };
});

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));

vi.mock("../src/main/junto/adapters/exec", () => ({
  resolvedSpawnEnv: mocks.resolvedSpawnEnv,
}));

vi.mock("../src/main/junto/process-signal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/main/junto/process-signal")>();
  return {
    ...actual,
    admitChildProcess: (input: Parameters<typeof actual.admitChildProcess>[0]) => {
      const handle = actual.admitChildProcess(input);
      mocks.handles.push(handle);
      return handle;
    },
  };
});

import {
  quiesceServiceChildrenOnQuit,
  runProcess,
  SERVICE_CHILD_PLANE_QUIESCING_ERROR,
  SERVICE_CHILD_TEARDOWN_PENDING_ERROR,
  spawnServiceChild,
} from "../src/main/services/process";
import { signalOwned, type OwnedProcess } from "../src/main/junto/process-signal";

class FakeWritable extends EventEmitter {
  readonly write = vi.fn(() => true);
  readonly end = vi.fn(() => this);
  readonly destroy = vi.fn(() => this);
}

let nextFakePid = 42_001;

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new FakeWritable();
  readonly kill = vi.fn((_signal?: NodeJS.Signals) => true);
  readonly pid = nextFakePid++;
}

const capturedHandle = (): OwnedProcess => {
  const handle = mocks.handles.at(-1);
  if (handle === undefined) throw new Error("expected a captured process authority");
  return handle as OwnedProcess;
};

const closeChild = (
  child: FakeChild,
  code: number | null = 0,
  signal: NodeJS.Signals | null = null,
): void => {
  child.emit("exit", code, signal);
  child.emit("close", code, signal);
};

beforeEach(() => {
  mocks.spawn.mockReset();
  mocks.resolvedSpawnEnv.mockClear();
  mocks.handles.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("central service child authority", () => {
  it("exposes a frozen stream facade without child or pid authority", () => {
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);

    const lease = spawnServiceChild({
      source: "services.test:opaque-facade",
      command: "example",
    });

    expect(Object.isFrozen(lease.io)).toBe(true);
    expect("pidForDiagnostics" in lease.io).toBe(false);
    expect("pid" in lease.io).toBe(false);
    expect("kill" in lease.io).toBe(false);
    expect("child" in lease).toBe(false);
    expect("process" in lease).toBe(false);
    closeChild(child);
  });

  it("releases runProcess authority when the operation closes", async () => {
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);

    const resultPromise = runProcess("example", ["--version"]);
    child.stdout.write("example 1.0\n");
    child.stderr.write("diagnostic\n");
    child.emit("close", 0);

    await expect(resultPromise).resolves.toEqual({
      code: 0,
      stdout: "example 1.0\n",
      stderr: "diagnostic\n",
    });
    expect(signalOwned(capturedHandle(), "SIGKILL")).toMatchObject({
      attempted: false,
      via: "none",
    });
    expect(child.kill).not.toHaveBeenCalled();
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    expect(child.stdout.listenerCount("data")).toBe(0);
    expect(child.stderr.listenerCount("data")).toBe(0);
  });

  it("bounds a timed-out runProcess with TERM then KILL and releases authority", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    child.kill.mockReturnValue(false);
    mocks.spawn.mockReturnValue(child);

    const resultPromise = runProcess("stuck", [], { timeoutMs: 25 }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(25);

    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    expect(child.stdout.listenerCount("data")).toBe(0);
    expect(child.stderr.listenerCount("data")).toBe(0);

    // Even a child that refused TERM can no longer feed an abandoned result.
    child.stdout.emit("data", Buffer.alloc(1024 * 1024, "x"));
    child.stderr.emit("data", Buffer.alloc(1024 * 1024, "y"));

    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    child.emit("close", null, "SIGKILL");
    expect(await resultPromise).toEqual(new Error("stuck timed out after 25ms"));
    expect(signalOwned(capturedHandle(), "SIGTERM").attempted).toBe(false);
    expect(child.kill).toHaveBeenCalledTimes(2);
    expect(child.stdout.listenerCount("data")).toBe(0);
    expect(child.stderr.listenerCount("data")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("blocks a same-source runProcess retry while failed teardown is unclean", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    child.kill.mockReturnValue(false);
    mocks.spawn.mockReturnValue(child);

    const failed = runProcess("retrying", [], { timeoutMs: 25 }).catch(
      (error) => error,
    );
    await vi.advanceTimersByTimeAsync(1_275);
    expect(await failed).toEqual(new Error("retrying timed out after 25ms"));
    expect(child.kill).toHaveBeenCalledTimes(2);

    await expect(runProcess("retrying", [])).rejects.toThrow(
      SERVICE_CHILD_TEARDOWN_PENDING_ERROR,
    );
    expect(mocks.spawn).toHaveBeenCalledOnce();

    child.emit("close", null, "SIGKILL");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels runProcess escalation when exit is observed", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);

    const resultPromise = runProcess("slow", [], { timeoutMs: 25 }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(25);
    child.emit("exit", null, "SIGTERM");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("close", null, "SIGTERM");
    expect(await resultPromise).toEqual(new Error("slow timed out after 25ms"));
    expect(signalOwned(capturedHandle(), "SIGKILL").attempted).toBe(false);
  });

  it("retains runProcess authority after error until bounded teardown", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);

    const resultPromise = runProcess("broken", []).catch((error) => error);
    child.emit("error", new Error("child channel failed"));

    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    child.emit("close", null, "SIGKILL");
    expect(await resultPromise).toEqual(new Error("child channel failed"));
    expect(vi.getTimerCount()).toBe(0);
    expect(signalOwned(capturedHandle(), "SIGTERM").attempted).toBe(false);
  });

  it.each(["stdout", "stderr"] as const)(
    "contains runProcess %s pipe errors and bounds teardown",
    async (channel) => {
      vi.useFakeTimers();
      const child = new FakeChild();
      mocks.spawn.mockReturnValue(child);

      const resultPromise = runProcess("streaming", []).catch((error) => error);
      child[channel].emit("error", new Error("pipe failed"));

      expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
      expect(child.stdout.destroyed).toBe(true);
      expect(child.stderr.destroyed).toBe(true);
      expect(child.stdout.listenerCount("data")).toBe(0);
      expect(child.stderr.listenerCount("data")).toBe(0);
      expect(child.stdout.listenerCount("error")).toBe(1);
      expect(child.stderr.listenerCount("error")).toBe(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
      child.emit("close", null, "SIGKILL");
      expect(await resultPromise).toEqual(
        new Error(`streaming ${channel} stream failed: pipe failed`),
      );
      expect(vi.getTimerCount()).toBe(0);
      expect(signalOwned(capturedHandle(), "SIGTERM").attempted).toBe(false);
    },
  );

  it.each(["stdout", "stderr"] as const)(
    "rejects runProcess %s overflow without retaining output listeners",
    async (channel) => {
      vi.useFakeTimers();
      const child = new FakeChild();
      mocks.spawn.mockReturnValue(child);

      const resultPromise = runProcess("bounded", [], {
        maxOutputBytes: 8,
      }).catch((error) => error);
      child[channel].write("123456789");

      expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
      expect(child.stdout.listenerCount("data")).toBe(0);
      expect(child.stderr.listenerCount("data")).toBe(0);
      expect(child.stdout.destroyed).toBe(true);
      expect(child.stderr.destroyed).toBe(true);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
      child.emit("close", null, "SIGKILL");
      expect(await resultPromise).toEqual(
        new Error(`bounded ${channel} exceeded 8 bytes`),
      );
      expect(vi.getTimerCount()).toBe(0);
      expect(signalOwned(capturedHandle(), "SIGTERM").attempted).toBe(false);
    },
  );

  it("does not let a runProcess error during TERM cancel escalation", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    child.kill.mockImplementation((signal) => {
      if (signal === "SIGTERM") child.emit("error", new Error("kill raced with child"));
      return true;
    });
    mocks.spawn.mockReturnValue(child);

    const resultPromise = runProcess("stuck", [], { timeoutMs: 25 }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(25);

    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(child.kill).toHaveBeenCalledTimes(2);
    child.emit("close", null, "SIGKILL");
    expect(await resultPromise).toEqual(new Error("stuck timed out after 25ms"));
    expect(vi.getTimerCount()).toBe(0);
    expect(signalOwned(capturedHandle(), "SIGTERM").attempted).toBe(false);
  });

  it("coalesces quit, drains in-flight services, rejects late spawns, and reports refusal", async () => {
    vi.useFakeTimers();
    const resistantRun = new FakeChild();
    resistantRun.kill.mockReturnValue(false);
    const closingRun = new FakeChild();
    closingRun.kill.mockImplementation((signal) => {
      if (signal === "SIGTERM") closeChild(closingRun, null, "SIGTERM");
      return true;
    });
    mocks.spawn
      .mockReturnValueOnce(resistantRun)
      .mockReturnValueOnce(closingRun);

    const runningProcess = runProcess("resistant-service", []).catch((error) => error);
    const closingProcess = runProcess("closing-service", []).catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);

    const first = quiesceServiceChildrenOnQuit();
    const second = quiesceServiceChildrenOnQuit();
    expect(second).toBe(first);

    const lateProcess = runProcess("late-service", []).catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);

    expect(await closingProcess).toEqual(
      new Error(SERVICE_CHILD_PLANE_QUIESCING_ERROR),
    );
    expect(await lateProcess).toEqual(
      new Error(SERVICE_CHILD_PLANE_QUIESCING_ERROR),
    );
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    expect(closingRun.kill).toHaveBeenCalledTimes(1);
    expect(closingRun.kill).toHaveBeenCalledWith("SIGTERM");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(resistantRun.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    await vi.advanceTimersByTimeAsync(250);
    expect(await runningProcess).toEqual(
      new Error(SERVICE_CHILD_PLANE_QUIESCING_ERROR),
    );

    await expect(first).resolves.toEqual({
      clean: false,
      stragglers: [
        {
          generation: expect.any(Number),
          source: "services.run-process:operation:resistant-service",
          exited: false,
          refusals: [
            { signal: "SIGTERM", reason: "child-signal-refused" },
            { signal: "SIGKILL", reason: "child-signal-refused" },
          ],
        },
      ],
    });
    expect(resistantRun.stdout.listenerCount("data")).toBe(0);
    expect(resistantRun.stderr.listenerCount("data")).toBe(0);
    expect(resistantRun.stdout.destroyed).toBe(true);
    expect(resistantRun.stderr.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    const closingHandle = mocks.handles[1] as OwnedProcess;
    expect(signalOwned(closingHandle, "SIGTERM").decision).toMatchObject({
      ok: false,
      reason: "handle-not-registered",
    });

    resistantRun.emit("close", null, "SIGKILL");
    const converged = quiesceServiceChildrenOnQuit();
    expect(converged).not.toBe(first);
    await expect(converged).resolves.toEqual({ clean: true, stragglers: [] });
    expect(vi.getTimerCount()).toBe(0);

    // Closing a retained record may converge the receipt, but quit admission
    // remains monotonic and cannot reopen service spawning.
    await expect(runProcess("still-late", [])).rejects.toThrow(
      SERVICE_CHILD_PLANE_QUIESCING_ERROR,
    );
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
  });
});
