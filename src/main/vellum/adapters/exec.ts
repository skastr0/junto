import { execFile } from "node:child_process";

// Shared shell-out helper for the read-only adapter plane. Every adapter
// call goes through here so the timeout, PATH inheritance, and buffer size
// are consistent, and so a failing CLI degrades to a result object instead
// of throwing — adapters decide how to fold that into a SnapshotBundle.

// Bulk queries over the tailnet (e.g. `tower status --all --json` across ~70
// projects) routinely exceed 10s, so the default is generous. Callers with a
// tighter budget can override per call.
const TIMEOUT_MS = 30_000;
const MAX_BUFFER = 16 * 1024 * 1024;

export interface CliResult {
  readonly ok: boolean;
  readonly stdout: string;
  readonly error?: string;
}

// PATH comes from process.env: the app is dev-run from a terminal so the
// tower/quasar/booth shims on PATH resolve without extra configuration.
export const runCli = (
  command: string,
  args: ReadonlyArray<string>,
  timeoutMs: number = TIMEOUT_MS,
): Promise<CliResult> =>
  new Promise((resolve) => {
    execFile(
      command,
      args as string[],
      { timeout: timeoutMs, env: process.env, maxBuffer: MAX_BUFFER },
      (error, stdout, stderr) => {
        if (error) {
          const message = stderr?.toString().trim() || error.message;
          resolve({ ok: false, stdout: "", error: message });
          return;
        }
        resolve({ ok: true, stdout: stdout.toString() });
      },
    );
  });

export const parseJson = <T>(text: string): T | undefined => {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
};
