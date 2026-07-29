import { spawn } from "node:child_process";
import { Effect, Schema } from "effect";
import {
  STATE_UPDATE_PREFLIGHT_PROTOCOL,
  STATE_UPDATE_PREFLIGHT_SWITCH,
  StateUpdatePreflightReceipt,
  type StateUpdatePreflightReceipt as Receipt,
} from "../state/candidate-readiness";
import { updateError, type UpdateError } from "./errors";

const PREFLIGHT_TIMEOUT_MS = 120_000;
const PREFLIGHT_SIGKILL_GRACE_MS = 5_000;

const decodeReceipt = Schema.decodeUnknownEither(StateUpdatePreflightReceipt);

/**
 * Sealed environment for candidate preflight — never inherit process.env.
 * Only the host identity + path/temp locale keys the packaged binary needs.
 * Clears renderer/demo redirects, dyld injection, and NODE_OPTIONS.
 */
export const sealedPreflightEnv = (
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => {
  const allow = [
    "HOME",
    "USER",
    "LOGNAME",
    "PATH",
    "TMPDIR",
    "TMP",
    "TEMP",
    "LANG",
    "LC_ALL",
  ] as const;
  const env: NodeJS.ProcessEnv = {};
  for (const key of allow) {
    const value = source[key];
    if (value !== undefined && value.length > 0) {
      env[key] = value;
    }
  }
  // Explicit empties so a parent env never leaks via Electron defaults.
  env.ELECTRON_RUN_AS_NODE = "";
  env.ELECTRON_RENDERER_URL = "";
  env.VELLUM_DEMO = "";
  env.NODE_OPTIONS = "";
  // Do not copy DYLD_* — sealed object never includes them.
  return env;
};

/**
 * Run the exact staged packaged candidate with sealed --vellum-state-preflight.
 * The incumbent must have released SQLite before this runs.
 */
export const runCandidateStatePreflight = (input: {
  readonly executablePath: string;
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}): Effect.Effect<Receipt, UpdateError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<Receipt>((resolve, reject) => {
        const timeoutMs = input.timeoutMs ?? PREFLIGHT_TIMEOUT_MS;
        const child = spawn(
          input.executablePath,
          [STATE_UPDATE_PREFLIGHT_SWITCH],
          {
            stdio: ["ignore", "pipe", "pipe"],
            env: input.env ?? sealedPreflightEnv(),
          },
        );
        let stdout = "";
        let stderr = "";
        let settled = false;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const settle = (action: () => void): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (killTimer !== undefined) clearTimeout(killTimer);
          action();
        };
        const timer = setTimeout(() => {
          if (settled) return;
          try {
            child.kill("SIGTERM");
          } catch {
            // process may already be gone
          }
          killTimer = setTimeout(() => {
            if (settled) return;
            try {
              child.kill("SIGKILL");
            } catch {
              // process may already be gone
            }
            settle(() => {
              reject(
                new Error(
                  `state preflight timed out after ${timeoutMs}ms (SIGKILL)`,
                ),
              );
            });
          }, PREFLIGHT_SIGKILL_GRACE_MS);
        }, timeoutMs);

        child.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        child.on("error", (error) => {
          settle(() => {
            reject(error);
          });
        });
        child.on("close", (code) => {
          settle(() => {
            if (code !== 0) {
              reject(
                new Error(
                  `state preflight exited ${String(code)}: ${stderr.trim() || stdout.trim() || "no output"}`,
                ),
              );
              return;
            }
            const line = stdout
              .split("\n")
              .map((entry) => entry.trim())
              .find(
                (entry) =>
                  entry.startsWith("{") &&
                  entry.includes(STATE_UPDATE_PREFLIGHT_PROTOCOL),
              );
            if (line === undefined) {
              reject(
                new Error(
                  `state preflight produced no receipt (stderr: ${stderr.trim() || "empty"})`,
                ),
              );
              return;
            }
            let parsed: unknown;
            try {
              parsed = JSON.parse(line) as unknown;
            } catch (error) {
              reject(
                new Error(
                  `state preflight receipt is not JSON: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                ),
              );
              return;
            }
            const decoded = decodeReceipt(parsed);
            if (decoded._tag === "Left") {
              reject(new Error("state preflight receipt failed schema decode"));
              return;
            }
            if (decoded.right.ready !== true) {
              reject(new Error("state preflight receipt is not ready"));
              return;
            }
            resolve(decoded.right);
          });
        });
      }),
    catch: (cause) =>
      updateError(
        "readiness-failed",
        cause instanceof Error
          ? `candidate readiness failed: ${cause.message}`
          : "candidate readiness failed",
        cause,
      ),
  }).pipe(Effect.withSpan("update.candidate-preflight"));
