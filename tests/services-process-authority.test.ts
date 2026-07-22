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
import { runProcess } from "../src/main/services/process";
import { signalOwned, type OwnedProcess } from "../src/main/vellum/process-signal";

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = { write: vi.fn(() => true) };
  readonly kill = vi.fn(() => true);
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
  });

  it("bounds a timed-out runProcess with TERM then KILL and releases authority", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);

    const resultPromise = runProcess("stuck", [], { timeoutMs: 25 }).catch((error) => error);
    await vi.advanceTimersByTimeAsync(25);

    expect(await resultPromise).toEqual(new Error("stuck timed out after 25ms"));
    expect(child.kill).toHaveBeenNthCalledWith(1, "SIGTERM");

    await vi.advanceTimersByTimeAsync(1_000);
    expect(child.kill).toHaveBeenNthCalledWith(2, "SIGKILL");
    expect(signalOwned(capturedHandle(), "SIGTERM").attempted).toBe(false);
    expect(child.kill).toHaveBeenCalledTimes(2);
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
    expect(signalOwned(capturedHandle(), "SIGKILL").attempted).toBe(false);
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
    child.emit("exit", 0, null);
    expect(signalOwned(capturedHandle(), "SIGKILL").attempted).toBe(false);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("fails promptly when Codex exits before the initialize response", async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    mocks.spawn.mockReturnValue(child);

    const resultPromise = Effect.runPromise(probeCodexAppServer.pipe(Effect.either));
    await vi.advanceTimersByTimeAsync(0);
    expect(mocks.spawn).toHaveBeenCalledOnce();

    child.stderr.write("startup rejected\n");
    child.emit("exit", 17, null);
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
    expect(signalOwned(capturedHandle(), "SIGTERM").attempted).toBe(false);
    expect(child.kill).toHaveBeenCalledTimes(2);
  });
});
