import { spawn } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installProcessSignalTermination } from "../src/main/vellum/process-signal-termination";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

interface SignalChildResult {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly forced: boolean;
}

const runSignalChild = async (
  mode: "fallback" | "normal",
  terminationSignal: "SIGINT" | "SIGTERM" = "SIGTERM",
): Promise<SignalChildResult> => {
  const fixture = join(
    import.meta.dirname,
    "fixtures",
    "process-signal-termination-child.ts",
  );
  const child = spawn(process.execPath, [fixture, mode], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let signaled = false;
  let forced = false;

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    if (signaled || !stdout.includes("ready\n")) return;
    signaled = true;
    child.kill(terminationSignal);
    setTimeout(() => child.kill(terminationSignal), 5).unref();
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const result = await new Promise<SignalChildResult>((resolve, reject) => {
    const timeout = setTimeout(() => {
      forced = true;
      child.kill("SIGKILL");
    }, 2_000);
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, stdout, forced });
    });
  });

  expect(stderr).toBe("");
  return result;
};

describe("process signal termination", () => {
  it("turns SIGTERM into one orderly quit and exits without escalation", async () => {
    const result = await runSignalChild("normal");

    expect(result).toEqual({
      code: 0,
      signal: null,
      stdout: "ready\ncleanup:SIGTERM\nquit\n",
      forced: false,
    });
  });

  it("keeps the app.exit fallback live after cleanup removes the final handle", async () => {
    const result = await runSignalChild("fallback");

    expect(result).toEqual({
      code: 0,
      signal: null,
      stdout: "ready\ncleanup:SIGTERM\nquit\nexit:0\n",
      forced: false,
    });
  });

  it("turns SIGINT into the same orderly, idempotent quit", async () => {
    const result = await runSignalChild("normal", "SIGINT");

    expect(result).toEqual({
      code: 0,
      signal: null,
      stdout: "ready\ncleanup:SIGINT\nquit\n",
      forced: false,
    });
  });

  it("never bypasses an incomplete durability boundary, then forces only after it is safe", async () => {
    vi.useFakeTimers();
    const listeners = new Map<string, () => void>();
    const processTarget = {
      on: vi.fn((signal: "SIGINT" | "SIGTERM", listener: () => void) => {
        listeners.set(signal, listener);
      }),
      off: vi.fn((signal: "SIGINT" | "SIGTERM") => {
        listeners.delete(signal);
      }),
    };
    const quit = vi.fn();
    const exit = vi.fn();
    const cleanup = vi.fn();
    let durable = false;
    const installed = installProcessSignalTermination({
      app: { quit, exit },
      cleanup,
      processTarget,
      exitGraceMs: 10,
      allowForceExit: () => durable,
    });

    listeners.get("SIGTERM")?.();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(quit).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(30);
    expect(exit).not.toHaveBeenCalled();

    durable = true;
    await vi.advanceTimersByTimeAsync(10);
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(0);
    installed.dispose();
  });
});
