import { spawn } from "node:child_process";
import { Context, Effect, Layer, Schema } from "effect";
import type { ServiceCheck } from "@shared/contracts";
import { resolvedSpawnEnv } from "../vellum/adapters/exec";
import {
  admitChildProcess,
  releaseOwned,
  signalOwned,
  type OwnedProcess,
} from "../vellum/process-signal";
import { runProcess } from "./process";

export class CodexError extends Schema.TaggedError<CodexError>()("CodexError", {
  message: Schema.String,
}) {}

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

const APP_SERVER_TERMINATION_GRACE_MS = 1_000;

const initializeAppServer = async (): Promise<string> => {
  const env = await resolvedSpawnEnv();
  return new Promise((resolve, reject) => {
    const child = spawn("codex", ["app-server"], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // The Codex service owns this app-server only for the initialize probe.
    // It is deliberately child-only: probing Codex never grants Vellum a
    // process-group or bare-pid signal capability.
    const owned: OwnedProcess = admitChildProcess({
      source: "services.codex-app-server:service-probe",
      child,
    });

    let stdoutBuffer = "";
    let stderr = "";
    let settled = false;
    let shutdownStarted = false;
    let escalationTimer: ReturnType<typeof setTimeout> | undefined;

    const releaseAuthority = (): void => {
      if (escalationTimer !== undefined) {
        clearTimeout(escalationTimer);
        escalationTimer = undefined;
      }
      releaseOwned(owned);
    };

    const terminateOwnedChild = (): void => {
      if (shutdownStarted) return;
      shutdownStarted = true;
      signalOwned(owned, "SIGTERM");
      escalationTimer = setTimeout(() => {
        escalationTimer = undefined;
        signalOwned(owned, "SIGKILL");
        // Keep the service probe bounded if the child never reports exit.
        releaseOwned(owned);
      }, APP_SERVER_TERMINATION_GRACE_MS);
      escalationTimer.unref?.();
    };

    const cleanup = () => {
      clearTimeout(timer);
      terminateOwnedChild();
    };

    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(message));
    };

    const timer = setTimeout(() => {
      fail(`codex app-server initialize timed out${stderr ? `: ${stderr}` : ""}`);
    }, 6_000);

    child.once("exit", releaseAuthority);
    child.once("close", releaseAuthority);

    child.on("error", (error) => {
      fail(error.message);
      releaseAuthority();
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      const lines = stdoutBuffer.split(/\r?\n/u);
      stdoutBuffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const message = JSON.parse(line) as { readonly id?: number; readonly result?: unknown };
          if (message.id === 0) {
            if (settled) return;
            settled = true;
            cleanup();
            resolve(JSON.stringify(message.result ?? {}));
            return;
          }
        } catch {
          // Keep reading; app-server logs must not break the protocol reader.
        }
      }
    });

    child.stdin?.write(
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
    child.stdin?.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
  });
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
