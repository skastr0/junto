import { spawn } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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

  it("uses the bounded app.exit fallback when quit never completes", async () => {
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
});
