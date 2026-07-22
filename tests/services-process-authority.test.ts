import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Effect, Either } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  resolvedSpawnEnv: vi.fn(async () => ({ PATH: "/usr/bin:/bin" })),
  handles: [] as unknown[],
}));

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));

vi.mock("../src/main/vellum/adapters/exec", () => ({
  resolvedSpawnEnv: mocks.resolvedSpawnEnv,
}));

vi.mock("../src/main/vellum/process-signal", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/main/vellum/process-signal")>();
  return {
    ...actual,
    admitChildProcess: (input: Parameters<typeof actual.admitChildProcess>[0]) => {
      const handle = actual.admitChildProcess(input);
      mocks.handles.push(handle);
      return handle;
    },
  };
});

import { CodexLive, CodexService } from "../src/main/services/codex";
import {
  quiesceServiceChildrenOnQuit,
  runProcess,
  SERVICE_CHILD_PLANE_QUIESCING_ERROR,
} from "../src/main/services/process";
import { signalOwned, type OwnedProcess } from "../src/main/vellum/process-signal";

class FakeWritable extends EventEmitter {
  readonly write = vi.fn(() => true);
  readonly destroy = vi.fn(() => this);
}

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new FakeWritable();
  readonly kill = vi.fn((_signal?: NodeJS.Signals) => true);
}

const probeCodexAppServer = Effect.gen(function* () {
  const codex = yield* CodexService;
  return yield* codex.probeAppServer;
}).pipe(Effect.provide(CodexLive));

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

describe("legacy service child authority", () => {
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

    expect(await resultPromise).toEqual(new Error("stuck timed out after 25ms"));
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
    expect(signalOwned(capturedHandle(), "SIGTERM").attempted).toBe(false);
    expect(child.kill).toHaveBeenCalledTimes(2);
    expect(child.stdout.listenerCount("data")).toBe(0);
    expect(child.stderr.listenerCount("data")).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels runProcess escalation when exit is observed", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);

    const resultPromise = runProcess("slow", [], { timeoutMs: 25 }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(25);
    await resultPromise;
    child.emit("exit", null, "SIGTERM");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(child.kill).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    child.emit("close", null, "SIGTERM");
    expect(signalOwned(capturedHandle(), "SIGKILL").attempted).toBe(false);
  });

  it("retains runProcess authority after error until bounded teardown", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);

    const resultPromise = runProcess("broken", []).catch((error) => error);
    child.emit("error", new Error("child channel failed"));

    expect(await resultPromise).toEqual(new Error("child channel failed"));
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(vi.getTimerCount()).toBe(0);
    child.emit("close", null, "SIGKILL");
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

      expect(await resultPromise).toEqual(
        new Error(`streaming ${channel} stream failed: pipe failed`),
      );
      expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
      expect(child.stdout.destroyed).toBe(true);
      expect(child.stderr.destroyed).toBe(true);
      expect(child.stdout.listenerCount("data")).toBe(0);
      expect(child.stderr.listenerCount("data")).toBe(0);
      expect(child.stdout.listenerCount("error")).toBe(1);
      expect(child.stderr.listenerCount("error")).toBe(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
      expect(vi.getTimerCount()).toBe(0);
      child.emit("close", null, "SIGKILL");
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

      expect(await resultPromise).toEqual(
        new Error(`bounded ${channel} exceeded 8 bytes`),
      );
      expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
      expect(child.stdout.listenerCount("data")).toBe(0);
      expect(child.stderr.listenerCount("data")).toBe(0);
      expect(child.stdout.destroyed).toBe(true);
      expect(child.stderr.destroyed).toBe(true);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
      child.emit("close", null, "SIGKILL");
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

    expect(await resultPromise).toEqual(new Error("stuck timed out after 25ms"));
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(child.kill).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    child.emit("close", null, "SIGKILL");
    expect(signalOwned(capturedHandle(), "SIGTERM").attempted).toBe(false);
  });

  it("terminates and releases the Codex app-server after its handshake", async () => {
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);

    const resultPromise = Effect.runPromise(probeCodexAppServer);
    await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalledOnce());
    child.stdout.write('{"id":0,"result":{"protocol":"ok"}}\n');

    await expect(resultPromise).resolves.toMatchObject({
      id: "codex-app-server",
      status: "ok",
    });
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    closeChild(child, 0, null);
    expect(signalOwned(capturedHandle(), "SIGKILL").attempted).toBe(false);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("records Codex exit and fails when close confirms no initialize response", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);

    let probeSettled = false;
    const resultPromise = Effect.runPromise(probeCodexAppServer.pipe(Effect.either)).then(
      (result) => {
        probeSettled = true;
        return result;
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.spawn).toHaveBeenCalledOnce();

    child.stderr.write("startup rejected\n");
    child.emit("exit", 17, null);
    await vi.advanceTimersByTimeAsync(0);
    expect(probeSettled).toBe(false);
    expect(vi.getTimerCount()).toBe(1);

    // Node normally follows exit with close; the second terminal event must
    // neither replace the original diagnostic nor trigger another teardown.
    child.emit("close", 17, null);
    const result = await resultPromise;

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.message).toBe(
        "codex app-server exited before initialize response (code 17): startup rejected",
      );
    }
    expect(vi.getTimerCount()).toBe(0);
    expect(child.kill).not.toHaveBeenCalled();
    expect(signalOwned(capturedHandle(), "SIGKILL").attempted).toBe(false);
  });

  it("accepts an initialize response drained between Codex exit and close", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);

    const resultPromise = Effect.runPromise(probeCodexAppServer);
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.spawn).toHaveBeenCalledOnce();

    child.emit("exit", 0, null);
    child.stdout.write('{"id":0,"result":{"drained":true}}\n');
    child.emit("close", 0, null);

    await expect(resultPromise).resolves.toMatchObject({
      id: "codex-app-server",
      status: "ok",
      metadata: { result: '{"drained":true}' },
    });
    expect(vi.getTimerCount()).toBe(0);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("fails promptly when Codex closes before the initialize response", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);

    const resultPromise = Effect.runPromise(probeCodexAppServer.pipe(Effect.either));
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.spawn).toHaveBeenCalledOnce();

    child.stderr.write("transport lost\n");
    child.emit("close", null, "SIGKILL");
    const result = await resultPromise;

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.message).toBe(
        "codex app-server closed before initialize response (signal SIGKILL): transport lost",
      );
    }
    expect(vi.getTimerCount()).toBe(0);
    expect(child.kill).not.toHaveBeenCalled();
    expect(signalOwned(capturedHandle(), "SIGTERM").attempted).toBe(false);
  });

  it("retains Codex authority after child error until bounded teardown", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);

    const resultPromise = Effect.runPromise(probeCodexAppServer.pipe(Effect.either));
    await vi.advanceTimersByTimeAsync(0);
    child.emit("error", new Error("spawn channel failed"));
    const result = await resultPromise;

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.message).toBe(
        "codex app-server child failed before initialize response: spawn channel failed",
      );
    }
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(vi.getTimerCount()).toBe(0);
    child.emit("close", null, "SIGKILL");
    expect(signalOwned(capturedHandle(), "SIGTERM").attempted).toBe(false);
  });

  it("does not let a Codex child error during TERM cancel escalation", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    child.kill.mockImplementation((signal) => {
      if (signal === "SIGTERM") child.emit("error", new Error("kill raced with child"));
      return true;
    });
    mocks.spawn.mockReturnValue(child);

    const resultPromise = Effect.runPromise(probeCodexAppServer.pipe(Effect.either));
    await vi.advanceTimersByTimeAsync(6_000);
    const result = await resultPromise;

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.message).toContain("initialize timed out");
    }
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(child.kill).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
    child.emit("close", null, "SIGKILL");
    expect(signalOwned(capturedHandle(), "SIGTERM").attempted).toBe(false);
  });

  it("contains Codex stdin EPIPE and completes bounded teardown", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    child.stdin.write.mockImplementationOnce(() => {
      child.stdin.emit("error", new Error("write EPIPE"));
      return false;
    });
    mocks.spawn.mockReturnValue(child);

    const resultPromise = Effect.runPromise(probeCodexAppServer.pipe(Effect.either));
    await vi.advanceTimersByTimeAsync(0);
    const result = await resultPromise;

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left.message).toBe(
        "codex app-server stdin failed before initialize response: write EPIPE",
      );
    }
    expect(child.stdin.write).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(vi.getTimerCount()).toBe(0);
    child.emit("close", null, "SIGKILL");
    expect(signalOwned(capturedHandle(), "SIGTERM").attempted).toBe(false);
  });

  it.each([
    ["stdout", "codex app-server unterminated JSONL exceeded 262144 bytes"],
    ["stderr", "codex app-server stderr exceeded 262144 bytes"],
  ] as const)(
    "bounds Codex %s accumulation and tears down the exact child",
    async (channel, expectedMessage) => {
      vi.useFakeTimers();
      const child = new FakeChild();
      mocks.spawn.mockReturnValue(child);

      const resultPromise = Effect.runPromise(probeCodexAppServer.pipe(Effect.either));
      await vi.advanceTimersByTimeAsync(0);
      child[channel].write(Buffer.alloc(262_145, "x"));
      const result = await resultPromise;

      expect(Either.isLeft(result)).toBe(true);
      if (Either.isLeft(result)) {
        expect(result.left.message).toBe(expectedMessage);
      }
      expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");
      expect(child.stdout.listenerCount("data")).toBe(0);
      expect(child.stderr.listenerCount("data")).toBe(0);
      expect(child.stdout.destroyed).toBe(true);
      expect(child.stderr.destroyed).toBe(true);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
      child.emit("close", null, "SIGKILL");
      expect(vi.getTimerCount()).toBe(0);
      expect(signalOwned(capturedHandle(), "SIGTERM").attempted).toBe(false);
    },
  );

  it("bounds a non-responsive Codex app-server probe and releases authority", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);

    const resultPromise = Effect.runPromise(probeCodexAppServer.pipe(Effect.either));
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.spawn).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(6_000);
    const result = await resultPromise;
    expect(Either.isLeft(result)).toBe(true);
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    child.emit("close", null, "SIGKILL");
    expect(signalOwned(capturedHandle(), "SIGTERM").attempted).toBe(false);
    expect(child.kill).toHaveBeenCalledTimes(2);
  });

  it("coalesces quit, drains in-flight services, rejects late spawns, and reports refusal", async () => {
    vi.useFakeTimers();
    const resistantRun = new FakeChild();
    resistantRun.kill.mockReturnValue(false);
    const closingCodex = new FakeChild();
    closingCodex.kill.mockImplementation((signal) => {
      if (signal === "SIGTERM") closeChild(closingCodex, null, "SIGTERM");
      return true;
    });
    mocks.spawn
      .mockReturnValueOnce(resistantRun)
      .mockReturnValueOnce(closingCodex);

    const runningProcess = runProcess("resistant-service", []).catch((error) => error);
    const runningCodex = Effect.runPromise(probeCodexAppServer.pipe(Effect.either));
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.spawn).toHaveBeenCalledTimes(2);

    const first = quiesceServiceChildrenOnQuit();
    const second = quiesceServiceChildrenOnQuit();
    expect(second).toBe(first);

    const lateProcess = runProcess("late-service", []).catch((error) => error);
    const lateCodex = Effect.runPromise(probeCodexAppServer.pipe(Effect.either));
    await vi.advanceTimersByTimeAsync(0);

    expect(await runningProcess).toEqual(
      new Error(SERVICE_CHILD_PLANE_QUIESCING_ERROR),
    );
    const runningCodexResult = await runningCodex;
    expect(Either.isLeft(runningCodexResult)).toBe(true);
    if (Either.isLeft(runningCodexResult)) {
      expect(runningCodexResult.left.message).toBe(
        SERVICE_CHILD_PLANE_QUIESCING_ERROR,
      );
    }
    expect(await lateProcess).toEqual(
      new Error(SERVICE_CHILD_PLANE_QUIESCING_ERROR),
    );
    const lateCodexResult = await lateCodex;
    expect(Either.isLeft(lateCodexResult)).toBe(true);
    if (Either.isLeft(lateCodexResult)) {
      expect(lateCodexResult.left.message).toBe(
        SERVICE_CHILD_PLANE_QUIESCING_ERROR,
      );
    }
    expect(mocks.spawn).toHaveBeenCalledTimes(2);
    expect(closingCodex.kill).toHaveBeenCalledTimes(1);
    expect(closingCodex.kill).toHaveBeenCalledWith("SIGTERM");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(resistantRun.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    await vi.advanceTimersByTimeAsync(250);

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

    const codexHandle = mocks.handles[1] as OwnedProcess;
    expect(signalOwned(codexHandle, "SIGTERM").decision).toMatchObject({
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
