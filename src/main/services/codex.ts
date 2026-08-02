import { Context, Effect, Layer, Schema } from "effect";
import type { ServiceCheck } from "@shared/contracts";
import { resolvedSpawnEnv } from "../vellum/adapters/exec";
import {
  assertServiceChildSpawnAllowed,
  runProcess,
  SERVICE_CHILD_PLANE_QUIESCING_ERROR,
  spawnServiceChild,
} from "./process";

export class CodexError extends Schema.TaggedError<CodexError>()("CodexError", {
  message: Schema.String,
}) {}

/**
 * effect-foundation **S4-rest-main** (staged, not half-migrated):
 * - Canonical id: `@chassis/CodexService` — single definition; no dual path.
 * - Substrate: effect@3.21 → `Context.Tag` (`Context.Service` unavailable).
 * - V4 target:
 *   `class CodexService extends Context.Service<CodexService, CodexService>()("@chassis/CodexService") {}`
 * - Layer today: CodexLive — V4 rename candidate CodexService.layer
 *   Do not dual-export Live + `.layer` names.
 */
export class CodexService extends Context.Tag("@chassis/CodexService")<
  CodexService,
  {
    readonly doctor: Effect.Effect<ServiceCheck>;
    readonly probeAppServer: Effect.Effect<ServiceCheck, CodexError>;
  }
>() {}

const checkCodexCli = Effect.tryPromise({
  // Resolve the spawn env first so `codex` resolves on the PATH floor even
  // under a packaged/launchd launch; runProcess inherits the mutated
  // process.env.PATH that resolvedSpawnEnv() sets.
  try: async () => {
    await resolvedSpawnEnv();
    return runProcess("codex", ["--version"], { timeoutMs: 3_000 });
  },
  catch: (error) =>
    new CodexError({
      message: error instanceof Error ? error.message : String(error),
    }),
});

const APP_SERVER_JSONL_REMAINDER_LIMIT_BYTES = 256 * 1024;
const APP_SERVER_STDERR_LIMIT_BYTES = 256 * 1024;

const runAppServerInitializeProbe = async (): Promise<string> => {
  assertServiceChildSpawnAllowed();
  const env = await resolvedSpawnEnv();
  // Environment resolution crosses an await; close the late-spawn window
  // again before entering the synchronous spawn + registration section.
  assertServiceChildSpawnAllowed();
  return new Promise((resolve, reject) => {
    const lease = spawnServiceChild({
      source: "services.codex-app-server:service-probe",
      purpose: "Codex App Server initialize probe",
      command: "codex",
      args: ["app-server"],
      env,
    });
    const { stdin, stdout, stderr: stderrStream } = lease.io;

    let stdoutBuffer = "";
    let stderr = "";
    let stderrBytes = 0;
    let settled = false;
    let outputStopped = false;
    let observedExit:
      | { readonly code: number | null; readonly signal: NodeJS.Signals | null }
      | undefined;

    const ignoreClosedPipeError = (): void => {
      // Destroyed local pipes may still report one final asynchronous error.
    };

    const stopOutput = (): void => {
      if (outputStopped) return;
      outputStopped = true;

      stdin.off("error", onStdinError);
      stdin.on("error", ignoreClosedPipeError);
      stdout.off("data", onStdoutData);
      stdout.off("error", onStdoutError);
      stdout.on("error", ignoreClosedPipeError);
      stderrStream.off("data", onStderrData);
      stderrStream.off("error", onStderrError);
      stderrStream.on("error", ignoreClosedPipeError);

      try {
        stdin.destroy();
      } catch {
        // The probe is settled; local endpoint cleanup is best effort.
      }
      try {
        stdout.destroy();
      } catch {
        // The probe is settled; local endpoint cleanup is best effort.
      }
      try {
        stderrStream.destroy();
      } catch {
        // The probe is settled; local endpoint cleanup is best effort.
      }
    };

    const settleSuccessfulHandshake = (result: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopOutput();
      void lease.terminateAndWaitForClose().then(
        (clean) => {
          if (clean) {
            resolve(result);
            return;
          }
          reject(
            new Error(
              "codex app-server did not close after initialize response",
            ),
          );
        },
        (error) => {
          reject(
            error instanceof Error ? error : new Error(String(error)),
          );
        },
      );
    };

    const failAndTerminate = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopOutput();
      const error = new Error(message);
      // Keep the shared probe flight occupied until bounded teardown settles.
      // Retries therefore cannot accumulate overlapping app-server children.
      void lease.terminateAndWaitForClose().then(
        () => reject(error),
        () => reject(error),
      );
    };

    const terminalStatus = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ): string => {
      if (signal !== null) return `signal ${signal}`;
      if (code !== null) return `code ${code}`;
      return "no exit status";
    };

    const settleTerminalFailure = (message: string): void => {
      // close proves the stdio drain is over; the shared registry independently
      // releases this exact child generation before this listener settles.
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stopOutput();
      reject(new Error(`${message}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
    };

    const timer = setTimeout(() => {
      failAndTerminate(`codex app-server initialize timed out${stderr ? `: ${stderr}` : ""}`);
    }, 6_000);

    lease.io.onExit(({ code, signal }) => {
      // exit proves signal authority is over, but stdout/stderr can still
      // drain until close. Keep the probe pending so a buffered initialize
      // response delivered in that window can still complete successfully.
      observedExit = { code, signal };
    });
    lease.io.onClose(({ code, signal }) => {
      const message = observedExit === undefined
        ? `codex app-server closed before initialize response (${terminalStatus(code, signal)})`
        : `codex app-server exited before initialize response (${terminalStatus(observedExit.code, observedExit.signal)})`;
      settleTerminalFailure(message);
    });

    const failChannel = (channel: "child" | "stdin" | "stdout" | "stderr", error: Error): void => {
      // Error events are not terminal evidence. In particular, EPIPE and a
      // failed kill can occur while the child is still live, so keep authority
      // until exit/close or the final bounded SIGKILL attempt.
      failAndTerminate(
        `codex app-server ${channel} failed before initialize response: ${error.message}`,
      );
    };

    function onStdinError(error: Error): void {
      failChannel("stdin", error);
    }

    function onStdoutError(error: Error): void {
      failChannel("stdout", error);
    }

    function onStderrError(error: Error): void {
      failChannel("stderr", error);
    }

    function onStderrData(chunk: Buffer): void {
      if (settled || outputStopped) return;
      const text = chunk.toString("utf8");
      const nextBytes = stderrBytes + Buffer.byteLength(text);
      if (nextBytes > APP_SERVER_STDERR_LIMIT_BYTES) {
        failAndTerminate(
          `codex app-server stderr exceeded ${APP_SERVER_STDERR_LIMIT_BYTES} bytes`,
        );
        return;
      }
      stderrBytes = nextBytes;
      stderr += text;
    }

    function onStdoutData(chunk: Buffer): void {
      if (settled || outputStopped) return;
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split(/\r?\n/u);
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const message = JSON.parse(line) as { readonly id?: number; readonly result?: unknown };
          if (message.id === 0) {
            settleSuccessfulHandshake(JSON.stringify(message.result ?? {}));
            return;
          }
        } catch {
          // Keep reading; app-server logs must not break the protocol reader.
        }
      }

      if (Buffer.byteLength(stdoutBuffer) > APP_SERVER_JSONL_REMAINDER_LIMIT_BYTES) {
        failAndTerminate(
          `codex app-server unterminated JSONL exceeded ${APP_SERVER_JSONL_REMAINDER_LIMIT_BYTES} bytes`,
        );
      }
    }

    lease.io.onError((error) => {
      failChannel("child", error);
    });
    stdin.on("error", onStdinError);
    stdout.on("error", onStdoutError);
    stdout.on("data", onStdoutData);
    stderrStream.on("error", onStderrError);
    stderrStream.on("data", onStderrData);
    lease.onQuiesce(() => {
      failAndTerminate(SERVICE_CHILD_PLANE_QUIESCING_ERROR);
    });

    try {
      stdin.write(
        `${JSON.stringify({
          id: 0,
          method: "initialize",
          params: {
            clientInfo: {
              name: "chassis",
              title: "Chassis",
              version: "0.1.0",
            },
          },
        })}\n`,
      );
      if (!settled) {
        stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
      }
    } catch (error) {
      failChannel(
        "stdin",
        error instanceof Error ? error : new Error(String(error)),
      );
    }
  });
};

let appServerProbeFlight: Promise<string> | undefined;

const initializeAppServer = (): Promise<string> => {
  if (appServerProbeFlight !== undefined) return appServerProbeFlight;
  const flight = runAppServerInitializeProbe();
  appServerProbeFlight = flight;
  void flight.then(
    () => {
      if (appServerProbeFlight === flight) appServerProbeFlight = undefined;
    },
    () => {
      if (appServerProbeFlight === flight) appServerProbeFlight = undefined;
    },
  );
  return flight;
};

export const CodexLive = Layer.succeed(
  CodexService,
  CodexService.of({
    doctor: checkCodexCli.pipe(
      Effect.map((result): ServiceCheck => {
        if (result.code === 0) {
          return {
            id: "codex",
            label: "Codex CLI",
            status: "ok",
            detail: result.stdout.trim() || "codex is available",
          };
        }

        return {
          id: "codex",
          label: "Codex CLI",
          status: "warning",
          detail: result.stderr.trim() || `codex exited with code ${result.code}`,
        };
      }),
      Effect.catchAll((error) =>
        Effect.succeed({
          id: "codex",
          label: "Codex CLI",
          status: "warning",
          detail: error.message,
        } satisfies ServiceCheck),
      ),
    ),
    probeAppServer: Effect.tryPromise({
      try: initializeAppServer,
      catch: (error) =>
        new CodexError({
          message: error instanceof Error ? error.message : String(error),
        }),
    }).pipe(
      Effect.map((result): ServiceCheck => ({
        id: "codex-app-server",
        label: "Codex App Server",
        status: "ok",
        detail: "initialize handshake completed",
        metadata: {
          protocol: "JSONL over stdio",
          result,
        },
      })),
    ),
  }),
);
