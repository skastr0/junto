/**
 * One bounded call to an external tool: `security`, `secret-tool`, `op`, or
 * the operator's own command.
 *
 * Every store Junto reads but does not own sits behind this one function, so
 * the resolvers and the secret store backends can be exercised with a fake
 * and never touch a real Keychain, keyring or 1Password in a test.
 *
 * It never rejects. A call that outlives its timeout is killed by the runtime
 * (`execFile` with a timeout, the same owned-child shape the rest of main
 * uses) and reported as `timeout`; a launch never waits on a tool that is waiting on the
 * operator. stdout may carry a secret: it is returned to the caller and goes
 * nowhere else. stderr is returned for classification only; callers never
 * print it unredacted.
 */
import { execFile } from "node:child_process";

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

export const runTool: ToolRunner = (call) =>
  new Promise((resolve) => {
    try {
      const child = execFile(
        call.command,
        [...call.args],
        {
          env: (call.env ?? process.env) as NodeJS.ProcessEnv,
          encoding: "utf8",
          timeout: call.timeoutMs,
          killSignal: "SIGKILL",
          maxBuffer: MAX_OUTPUT_BYTES,
          windowsHide: true,
        },
        (error, stdout, stderr) => {
          if (!error) {
            resolve({ kind: "ok", stdout });
            return;
          }
          const failure = error as NodeJS.ErrnoException & { killed?: boolean };
          if (failure.code === "ENOENT") resolve({ kind: "not-installed" });
          else if (failure.killed === true) resolve({ kind: "timeout" });
          else if (typeof failure.code === "number") {
            resolve({ kind: "exit", code: failure.code, stdout, stderr });
          } else resolve({ kind: "failed" });
        },
      );
      // Nothing is ever typed to these tools: close stdin so one that reads
      // it sees end of input instead of waiting.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end();
    } catch {
      resolve({ kind: "failed" });
    }
  });
