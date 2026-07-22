import { spawn } from "node:child_process";
import {
  admitChildProcess,
  releaseOwned,
  signalOwned,
  type OwnedProcess,
} from "../vellum/process-signal";

export interface ProcessResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

const PROCESS_TERMINATION_GRACE_MS = 1_000;

export const runProcess = (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd?: string; readonly timeoutMs?: number } = {},
): Promise<ProcessResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // runProcess owns this child for exactly one command invocation. The
    // capability contains only the ChildProcess handle: this helper never
    // acquires process-group authority and cannot signal an ambient pid.
    const owned: OwnedProcess = admitChildProcess({
      source: `services.run-process:operation:${command}`,
      child,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let escalationTimer: ReturnType<typeof setTimeout> | undefined;

    const releaseAuthority = (): void => {
      if (escalationTimer !== undefined) {
        clearTimeout(escalationTimer);
        escalationTimer = undefined;
      }
      releaseOwned(owned);
    };

    const terminateOwnedChild = (): void => {
      signalOwned(owned, "SIGTERM");
      if (escalationTimer !== undefined) return;
      escalationTimer = setTimeout(() => {
        escalationTimer = undefined;
        signalOwned(owned, "SIGKILL");
        // Teardown is bounded even if the OS never reports a close event.
        releaseOwned(owned);
      }, PROCESS_TERMINATION_GRACE_MS);
      escalationTimer.unref?.();
    };

    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            if (settled) return;
            settled = true;
            terminateOwnedChild();
            reject(new Error(`${command} timed out after ${options.timeoutMs}ms`));
          }, options.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.once("exit", releaseAuthority);

    child.on("error", (error) => {
      releaseAuthority();
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(error);
    });

    child.on("close", (code) => {
      releaseAuthority();
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
