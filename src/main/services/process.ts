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
    let terminationStarted = false;
    let authorityReleased = false;
    let outputStopped = false;
    let escalationTimer: ReturnType<typeof setTimeout> | undefined;

    const ignoreClosedPipeError = (): void => {
      // A destroyed local pipe can still report its final asynchronous error.
    };

    const onStdoutData = (chunk: Buffer): void => {
      if (settled || outputStopped) return;
      stdout += chunk.toString("utf8");
    };

    const onStderrData = (chunk: Buffer): void => {
      if (settled || outputStopped) return;
      stderr += chunk.toString("utf8");
    };

    const stopOutput = (): void => {
      if (outputStopped) return;
      outputStopped = true;

      child.stdout?.off("data", onStdoutData);
      child.stdout?.off("error", onStdoutError);
      child.stdout?.on("error", ignoreClosedPipeError);
      child.stderr?.off("data", onStderrData);
      child.stderr?.off("error", onStderrError);
      child.stderr?.on("error", ignoreClosedPipeError);

      try {
        child.stdout?.destroy();
      } catch {
        // The operation is already settled; local endpoint cleanup is best effort.
      }
      try {
        child.stderr?.destroy();
      } catch {
        // The operation is already settled; local endpoint cleanup is best effort.
      }
    };

    const releaseAuthority = (): void => {
      if (authorityReleased) return;
      authorityReleased = true;
      if (escalationTimer !== undefined) {
        clearTimeout(escalationTimer);
        escalationTimer = undefined;
      }
      releaseOwned(owned);
    };

    const terminateOwnedChild = (): void => {
      if (terminationStarted || authorityReleased) return;
      terminationStarted = true;
      escalationTimer = setTimeout(() => {
        escalationTimer = undefined;
        stopOutput();
        signalOwned(owned, "SIGKILL");
        // Teardown is bounded even if the OS never reports a close event.
        releaseAuthority();
      }, PROCESS_TERMINATION_GRACE_MS);
      escalationTimer.unref?.();
      // Arm the bound before signalling: an error emitted synchronously from
      // kill() must not cancel or recursively restart teardown.
      signalOwned(owned, "SIGTERM");
    };

    const failOperation = (error: Error): void => {
      if (!settled) {
        settled = true;
        if (timer) clearTimeout(timer);
        stopOutput();
        reject(error);
      }
      terminateOwnedChild();
    };

    function onStdoutError(error: Error): void {
      failOperation(new Error(`${command} stdout stream failed: ${error.message}`));
    }

    function onStderrError(error: Error): void {
      failOperation(new Error(`${command} stderr stream failed: ${error.message}`));
    }

    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            if (settled) return;
            failOperation(new Error(`${command} timed out after ${options.timeoutMs}ms`));
          }, options.timeoutMs);

    child.stdout?.on("data", onStdoutData);
    child.stdout?.on("error", onStdoutError);
    child.stderr?.on("data", onStderrData);
    child.stderr?.on("error", onStderrError);

    child.once("exit", releaseAuthority);

    child.on("error", (error) => {
      // ChildProcess "error" is not proof of process death (kill/send and
      // stream failures can emit it while the child is still alive). Reject
      // promptly, but retain exact-child authority through bounded teardown.
      failOperation(error);
    });

    child.on("close", (code) => {
      releaseAuthority();
      if (settled) {
        stopOutput();
        return;
      }
      settled = true;
      if (timer) clearTimeout(timer);
      stopOutput();
      resolve({ code, stdout, stderr });
    });
  });
