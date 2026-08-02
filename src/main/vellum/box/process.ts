import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { accessSync, constants } from "node:fs";
import { Context, Effect, Layer, Schema } from "effect";
import {
  appProcessPlane,
  type AppProcessLease,
} from "../app-process-plane";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const BOX_PROCESS_QUIESCING_DETAIL = "Box CLI process plane is shutting down";

export interface BoxProcessRequest {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly operation: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly stdin?: string;
}

export interface BoxProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export class BoxProcessError extends Schema.TaggedErrorClass<BoxProcessError>()(
  "BoxProcessError",
  {
    operation: Schema.String,
    detail: Schema.String,
  },
) {}

/**
 * effect-foundation **S4-rest-main** (staged, not half-migrated):
 * - Canonical id: `@vellum/box/BoxProcessRunner` — single definition; no dual path.
 * - Service id: Context.Service (Effect V4 live).
 * - Shape:
 *   `class BoxProcessRunner extends Context.Service<BoxProcessRunner, BoxProcessRunner>()("@vellum/box/BoxProcessRunner") {}`
 * - Layer today: BoxProcessRunnerLive — V4 rename candidate BoxProcessRunner.layer
 *   Do not dual-export Live + `.layer` names.
 */
export class BoxProcessRunner extends Context.Service<BoxProcessRunner,
  {
    readonly run: (
      request: BoxProcessRequest,
    ) => Effect.Effect<BoxProcessResult, BoxProcessError>;
  }>()("@vellum/box/BoxProcessRunner") {}

type ActiveOperation = {
  readonly lease: AppProcessLease;
  settleForShutdown: () => void;
};

const activeOperations = new Set<ActiveOperation>();
let quiescing = false;

export const beginBoxProcessShutdown = (): void => {
  quiescing = true;
  for (const operation of [...activeOperations]) {
    operation.settleForShutdown();
    try {
      appProcessPlane.terminate(operation.lease, "Box CLI operation quit");
    } catch {
      // The central process plane retains the authoritative shutdown receipt.
    }
  }
};

const runProcess = (
  request: BoxProcessRequest,
): Promise<BoxProcessResult> => {
  if (quiescing) {
    return Promise.reject(
      BoxProcessError.make({
        operation: request.operation,
        detail: BOX_PROCESS_QUIESCING_DETAIL,
      }),
    );
  }

  return new Promise((resolve, reject) => {
    if (quiescing) {
      reject(
        BoxProcessError.make({
          operation: request.operation,
          detail: BOX_PROCESS_QUIESCING_DETAIL,
        }),
      );
      return;
    }

    let lease: AppProcessLease;
    try {
      lease = appProcessPlane.spawnGroup({
        source: "box.cli",
        purpose: `Box CLI ${request.operation}`,
        command: request.executable,
        args: [...request.args],
      });
    } catch (cause) {
      reject(
        BoxProcessError.make({
          operation: request.operation,
          detail: cause instanceof Error ? cause.message : String(cause),
        }),
      );
      return;
    }

    const operation: ActiveOperation = {
      lease,
      settleForShutdown: () => undefined,
    };
    activeOperations.add(operation);

    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxOutputBytes =
      request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    let exitCode: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      lease.io.stdout.off("data", onStdout);
      lease.io.stderr.off("data", onStderr);
      unsubscribeExit();
      unsubscribeClose();
      unsubscribeError();
      activeOperations.delete(operation);
    };

    const fail = (detail: string): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(BoxProcessError.make({ operation: request.operation, detail }));
    };

    const succeed = (): void => {
      if (settled || exitCode === undefined) return;
      settled = true;
      cleanup();
      resolve({ exitCode, stdout, stderr });
    };

    const append = (target: "stdout" | "stderr", chunk: unknown): void => {
      if (settled) return;
      const text = String(chunk);
      outputBytes += Buffer.byteLength(text);
      if (outputBytes > maxOutputBytes) {
        try {
          appProcessPlane.forceTerminate(lease, "Box CLI output limit");
        } catch {
          // The central process plane still owns the lease.
        }
        fail(`output exceeded ${maxOutputBytes} bytes`);
        return;
      }
      if (target === "stdout") stdout += text;
      else stderr += text;
    };

    const onStdout = (chunk: unknown): void => append("stdout", chunk);
    const onStderr = (chunk: unknown): void => append("stderr", chunk);
    lease.io.stdout.setEncoding("utf8");
    lease.io.stderr.setEncoding("utf8");
    lease.io.stdout.on("data", onStdout);
    lease.io.stderr.on("data", onStderr);

    const unsubscribeExit = lease.io.onExit((event) => {
      exitCode = event.code ?? -1;
    });
    const unsubscribeClose = lease.io.onClose(() => {
      if (exitCode === undefined) {
        fail("process closed without an exit status");
        return;
      }
      succeed();
    });
    const unsubscribeError = lease.io.onError((error) => {
      fail(error.message);
    });

    operation.settleForShutdown = () => {
      fail(BOX_PROCESS_QUIESCING_DETAIL);
    };

    timer = setTimeout(() => {
      try {
        appProcessPlane.forceTerminate(lease, "Box CLI command timeout");
      } catch {
        // The central process plane still owns the lease.
      }
      fail(`timed out after ${timeoutMs}ms`);
    }, timeoutMs);
    timer.unref?.();

    if (request.stdin === undefined) lease.io.stdin.end();
    else lease.io.stdin.end(request.stdin);
  });
};

export const BoxProcessRunnerLive = Layer.succeed(
  BoxProcessRunner,
  BoxProcessRunner.of({
    run: (request) =>
      Effect.tryPromise({
        try: () => runProcess(request),
        catch: (cause) =>
          cause instanceof BoxProcessError
            ? cause
            : BoxProcessError.make({
                operation: request.operation,
                detail: cause instanceof Error ? cause.message : String(cause),
              }),
      }),
  }),
);

const executable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** Resolve Box without consulting a login shell or executing user-controlled text. */
export const resolveBoxCliCandidates = (
  configuredPath?: string,
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): ReadonlyArray<string> => {
  const candidates = [
    configuredPath,
    ...String(environment.PATH ?? "")
      .split(delimiter)
      .filter(Boolean)
      .map((entry) => join(entry, "box")),
    join(homeDirectory, ".ascii", "bin", "box"),
  ].filter((entry): entry is string => Boolean(entry));
  return [...new Set(candidates)].filter(executable);
};

