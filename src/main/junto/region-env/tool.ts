/**
 * One bounded call to an external tool: `security`, `secret-tool`, `op`, or
 * the operator's own command.
 *
 * Every store Junto reads but does not own sits behind this one function, so
 * the resolvers and the secret store backends can be exercised with a fake
 * and never touch a real Keychain, keyring or 1Password in a test.
 *
 * It never rejects. Tools belong to the app's process plane: timeout and
 * output limits stop the exact owned group, and quit drains that same lease.
 * stdout may carry a secret and is returned only to the resolver. stderr is
 * returned for classification only; callers never print it unredacted.
 */
import {
  appProcessPlane,
  type AppProcessLease,
  type AppProcessPlane,
} from "../app-process-plane";

export type ToolCall = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly timeoutMs: number;
  /** Environment for this one process. Absent: the app's own. */
  readonly env?: Readonly<Record<string, string | undefined>>;
};

export type ToolResult =
  | { readonly kind: "ok"; readonly stdout: string }
  | { readonly kind: "exit"; readonly code: number; readonly stdout: string; readonly stderr: string }
  | { readonly kind: "not-installed" }
  | { readonly kind: "timeout" }
  | { readonly kind: "failed" };

export type ToolRunner = (call: ToolCall) => Promise<ToolResult>;

/** A tool's output is a value or a short diagnostic, never a stream. */
const MAX_OUTPUT_BYTES = 1024 * 1024;

/** Inject a private plane in tests; the product uses its one app-owned plane. */
export const makeToolRunner = (
  plane: Pick<AppProcessPlane, "spawnGroup" | "forceTerminate">,
): ToolRunner => (call) =>
  new Promise((resolve) => {
    if (!Number.isFinite(call.timeoutMs) || call.timeoutMs <= 0) {
      resolve({ kind: "failed" });
      return;
    }
    let lease: AppProcessLease;
    try {
      lease = plane.spawnGroup({
        source: "region-env.tool",
        purpose: "resolve an environment source",
        command: call.command,
        args: call.args,
        env: call.env ?? process.env,
      });
    } catch {
      resolve({ kind: "failed" });
      return;
    }
    const io = lease.io;
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanups: Array<() => void> = [];
    const chunks: Record<"stdout" | "stderr", Buffer[]> = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    const ignoreStreamError = () => undefined;
    const finish = (result: ToolResult): void => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      for (const cleanup of cleanups) cleanup();
      // Continue draining without retaining output if a signal is refused.
      // The central plane still owns the exit/close witness and quit drain.
      io.stdout.resume();
      io.stderr.resume();
      chunks.stdout.length = 0;
      chunks.stderr.length = 0;
      resolve(result);
    };
    const stop = (result: ToolResult, reason: string): void => {
      finish(result);
      try {
        plane.forceTerminate(lease, reason);
      } catch {
        // Never turn failed termination into a bare PID or group signal.
        // The central plane retains the lease for its authoritative drain.
      }
    };
    const append = (stream: "stdout" | "stderr", chunk: Buffer | string): void => {
      if (settled) return;
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      sizes[stream] += data.length;
      if (sizes[stream] > MAX_OUTPUT_BYTES) {
        stop({ kind: "failed" }, "environment tool output limit");
        return;
      }
      chunks[stream].push(data);
    };
    const stdout = (chunk: Buffer | string) => append("stdout", chunk);
    const stderr = (chunk: Buffer | string) => append("stderr", chunk);
    io.stdout.on("data", stdout);
    io.stderr.on("data", stderr);
    io.stdout.on("error", ignoreStreamError);
    io.stderr.on("error", ignoreStreamError);
    io.stdin.on("error", ignoreStreamError);
    cleanups.push(() => io.stdout.off("data", stdout));
    cleanups.push(() => io.stderr.off("data", stderr));
    cleanups.push(io.onError((error) => {
      finish((error as NodeJS.ErrnoException).code === "ENOENT"
        ? { kind: "not-installed" }
        : { kind: "failed" });
    }));
    timer = setTimeout(() => stop({ kind: "timeout" }, "environment tool timeout"), call.timeoutMs);
    void io.closed.then((exit) => {
      if (settled) return;
      const output = Buffer.concat(chunks.stdout).toString("utf8");
      finish(exit.code === 0
        ? { kind: "ok", stdout: output }
        : typeof exit.code === "number"
          ? { kind: "exit", code: exit.code, stdout: output, stderr: Buffer.concat(chunks.stderr).toString("utf8") }
          : { kind: "failed" });
    }, () => finish({ kind: "failed" }));
    // No input is typed to these tools, even when one waits for stdin.
    io.stdin.end();
  });

export const runTool: ToolRunner = makeToolRunner(appProcessPlane);
