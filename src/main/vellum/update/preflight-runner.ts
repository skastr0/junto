import { spawn } from "node:child_process";
import { Effect, Schema } from "effect";
import {
  STATE_UPDATE_PREFLIGHT_PROTOCOL,
  StateUpdatePreflightReceipt,
  type StateUpdatePreflightReceipt as Receipt,
} from "../state/candidate-readiness";
import { updateError, type UpdateError } from "./errors";

const PREFLIGHT_TIMEOUT_MS = 120_000;

const decodeReceipt = Schema.decodeUnknownEither(StateUpdatePreflightReceipt);

/**
 * Run the exact staged packaged candidate with sealed --vellum-state-preflight.
 * The incumbent must have released SQLite before this runs.
 */
export const runCandidateStatePreflight = (input: {
  readonly executablePath: string;
  readonly timeoutMs?: number;
}): Effect.Effect<Receipt, UpdateError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<Receipt>((resolve, reject) => {
        const timeoutMs = input.timeoutMs ?? PREFLIGHT_TIMEOUT_MS;
        const child = spawn(
          input.executablePath,
          ["--vellum-state-preflight"],
          {
            stdio: ["ignore", "pipe", "pipe"],
            env: {
              ...process.env,
              // Never inherit a renderer URL or demo redirect into preflight.
              ELECTRON_RENDERER_URL: "",
            },
          },
        );
        let stdout = "";
        let stderr = "";
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          child.kill("SIGTERM");
          reject(new Error(`state preflight timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        child.stdout?.on("data", (chunk: Buffer) => {
          stdout += chunk.toString("utf8");
        });
        child.stderr?.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8");
        });
        child.on("error", (error) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        });
        child.on("close", (code) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
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
            .find((entry) => entry.startsWith("{") && entry.includes(STATE_UPDATE_PREFLIGHT_PROTOCOL));
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
