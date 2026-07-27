import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { homedir } from "node:os";
import { Effect, Either, Schema } from "effect";
import { allowAuthorialCliWrite } from "@shared/authorial-write";
import {
  CANVAS_CONTROL_DEFAULT_TIMEOUT_MS,
  CANVAS_CONTROL_HOME_ENV,
  CANVAS_CONTROL_MAX_REQUEST_BYTES,
  CANVAS_CONTROL_MAX_RESPONSE_BYTES,
  CANVAS_CONTROL_PROTOCOL_VERSION,
  CanvasControlListData,
  CanvasControlReadData,
  CanvasControlRemoveData,
  canvasControlDir,
  canvasControlNameFrom,
  canvasControlSocketPath,
  decodeCanvasControlResponse,
  encodeCanvasControlFrame,
  type CanvasControlErrorCode,
  type CanvasControlListData as CanvasControlListResult,
  type CanvasControlOp,
  type CanvasControlReadData as CanvasControlReadResult,
  type CanvasControlRemoveData as CanvasControlRemoveResult,
} from "./protocol";

export class CanvasControlClientError extends Schema.TaggedError<CanvasControlClientError>()(
  "CanvasControlClientError",
  {
    code: Schema.String,
    message: Schema.String,
    retryable: Schema.Boolean,
  },
) {
  declare readonly code: CanvasControlErrorCode | "MalformedResponse";
}

export interface CanvasControlClientOptions {
  readonly home?: string;
  readonly controlHome?: string;
  readonly socketPath?: string;
  readonly timeoutMs?: number;
}

declare const canvasControlAuthorialPermitBrand: unique symbol;
export type CanvasControlAuthorialPermit = Readonly<{
  readonly [canvasControlAuthorialPermitBrand]: true;
}>;

const liveAuthorialPermits = new WeakSet<object>();

/** Mint a process-local deletion permit only after the explicit CLI ceremony. */
export const canvasControlAuthorialPermit = (
  env: NodeJS.ProcessEnv = process.env,
): CanvasControlAuthorialPermit => {
  const gate = allowAuthorialCliWrite(env);
  if (!gate.ok) {
    throw new CanvasControlClientError({
      code: "AuthorialWriteDenied",
      message: gate.message,
      retryable: false,
    });
  }
  const permit = Object.freeze({}) as CanvasControlAuthorialPermit;
  liveAuthorialPermits.add(permit);
  return permit;
};

export const resolveCanvasControlHome = (
  home?: string,
  controlHome?: string,
): string => {
  if (controlHome?.trim()) return controlHome.trim();
  const configured = process.env[CANVAS_CONTROL_HOME_ENV]?.trim();
  if (configured) return configured;
  return canvasControlDir(home ?? homedir());
};

const runtimeDown = (message: string): CanvasControlClientError =>
  new CanvasControlClientError({
    code: "RuntimeDown",
    message,
    retryable: true,
  });

const malformedResponse = (message: string): CanvasControlClientError =>
  new CanvasControlClientError({
    code: "MalformedResponse",
    message,
    retryable: false,
  });

const boundedTimeout = (value: number | undefined): number => {
  if (value === undefined) return CANVAS_CONTROL_DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(value) || value <= 0) {
    return CANVAS_CONTROL_DEFAULT_TIMEOUT_MS;
  }
  return Math.min(Math.floor(value), CANVAS_CONTROL_DEFAULT_TIMEOUT_MS);
};

const call = (
  op: CanvasControlOp,
  args: unknown,
  options: CanvasControlClientOptions,
): Effect.Effect<unknown, CanvasControlClientError> =>
  Effect.async<unknown, CanvasControlClientError>((resume) => {
    const controlHome = resolveCanvasControlHome(
      options.home,
      options.controlHome,
    );
    const socketPath =
      options.socketPath ?? canvasControlSocketPath(controlHome);
    const timeoutMs = boundedTimeout(options.timeoutMs);
    const id = randomUUID();
    const frame = encodeCanvasControlFrame({
      protocol_version: CANVAS_CONTROL_PROTOCOL_VERSION,
      op,
      args,
      id,
    });
    if (Buffer.byteLength(frame, "utf8") > CANVAS_CONTROL_MAX_REQUEST_BYTES) {
      resume(
        Effect.fail(
          new CanvasControlClientError({
            code: "ProtocolError",
            message: `canvas control request exceeds ${String(CANVAS_CONTROL_MAX_REQUEST_BYTES)} bytes`,
            retryable: false,
          }),
        ),
      );
      return;
    }

    let socket: Socket | undefined;
    let buffer = Buffer.alloc(0);
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const settle = (effect: Effect.Effect<unknown, CanvasControlClientError>) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      try {
        socket?.destroy();
      } catch {
        // The Effect finalizer owns no further state.
      }
      resume(effect);
    };

    timer = setTimeout(() => {
      settle(
        Effect.fail(
          new CanvasControlClientError({
            code: "ProtocolError",
            message: `canvas control request timed out after ${String(timeoutMs)}ms`,
            retryable: true,
          }),
        ),
      );
    }, timeoutMs);

    try {
      socket = createConnection({ path: socketPath });
    } catch (error) {
      settle(
        Effect.fail(
          runtimeDown(
            error instanceof Error
              ? error.message
              : "failed to open canvas control socket",
          ),
        ),
      );
      return;
    }

    socket.on("connect", () => {
      socket?.write(frame);
    });
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.byteLength > CANVAS_CONTROL_MAX_RESPONSE_BYTES) {
        settle(
          Effect.fail(
            new CanvasControlClientError({
              code: "ProtocolError",
              message: `canvas control response exceeds ${String(CANVAS_CONTROL_MAX_RESPONSE_BYTES)} bytes`,
              retryable: false,
            }),
          ),
        );
        return;
      }
      const newline = buffer.indexOf(0x0a);
      if (newline < 0) return;
      const trailing = buffer.subarray(newline + 1).toString("utf8").trim();
      if (trailing.length > 0) {
        settle(Effect.fail(malformedResponse("server returned multiple frames")));
        return;
      }
      let raw: unknown;
      try {
        const line = new TextDecoder("utf-8", { fatal: true })
          .decode(buffer.subarray(0, newline))
          .replace(/\r$/, "")
          .trim();
        raw = JSON.parse(line) as unknown;
      } catch {
        settle(
          Effect.fail(
            malformedResponse("server returned invalid UTF-8 or non-JSON"),
          ),
        );
        return;
      }
      const decoded = decodeCanvasControlResponse(raw);
      if (Either.isLeft(decoded)) {
        settle(
          Effect.fail(
            malformedResponse("server returned a malformed canvas envelope"),
          ),
        );
        return;
      }
      const envelope = decoded.right;
      if (envelope.id !== id || (envelope.op !== undefined && envelope.op !== op)) {
        settle(
          Effect.fail(
            malformedResponse("server response does not match the request"),
          ),
        );
        return;
      }
      if (!envelope.ok) {
        settle(
          Effect.fail(
            new CanvasControlClientError({
              code: envelope.error.code,
              message: envelope.error.message,
              retryable: envelope.error.retryable,
            }),
          ),
        );
        return;
      }
      settle(Effect.succeed(envelope.data));
    });
    socket.on("error", (error: NodeJS.ErrnoException) => {
      const unavailable =
        error.code === "ENOENT" ||
        error.code === "ECONNREFUSED" ||
        error.code === "EACCES";
      settle(
        Effect.fail(
          unavailable
            ? runtimeDown("Vellum canvas control is unavailable — open Vellum and try again")
            : new CanvasControlClientError({
                code: "ProtocolError",
                message: error.message,
                retryable: false,
              }),
        ),
      );
    });
    socket.on("close", () => {
      if (!settled) {
        settle(
          Effect.fail(
            malformedResponse("canvas control closed before its response"),
          ),
        );
      }
    });

    return Effect.sync(() => {
      if (timer !== undefined) clearTimeout(timer);
      socket?.destroy();
    });
  });

const decodeData = <A, I>(
  schema: Schema.Schema<A, I>,
  value: unknown,
): Effect.Effect<A, CanvasControlClientError> =>
  Schema.decodeUnknown(schema)(value).pipe(
    Effect.mapError(() =>
      malformedResponse("server returned malformed canvas operation data"),
    ),
  );

const validatedCanvasName = (
  raw: string,
): Effect.Effect<string, CanvasControlClientError> =>
  Effect.try({
    try: () => canvasControlNameFrom(raw),
    catch: (error) =>
      new CanvasControlClientError({
        code: "InputError",
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
      }),
  });

export const listCanvasesThroughControl = (
  options: CanvasControlClientOptions = {},
): Effect.Effect<CanvasControlListResult, CanvasControlClientError> =>
  call("list", {}, options).pipe(
    Effect.flatMap((value) => decodeData(CanvasControlListData, value)),
  );

export const readCanvasThroughControl = (
  name: string,
  options: CanvasControlClientOptions = {},
): Effect.Effect<CanvasControlReadResult, CanvasControlClientError> =>
  validatedCanvasName(name).pipe(
    Effect.flatMap((canonicalName) =>
      call("read", { name: canonicalName }, options),
    ),
    Effect.flatMap((value) => decodeData(CanvasControlReadData, value)),
  );

export const removeCanvasThroughControl = (
  name: string,
  permit: CanvasControlAuthorialPermit,
  options: CanvasControlClientOptions = {},
): Effect.Effect<CanvasControlRemoveResult, CanvasControlClientError> =>
  liveAuthorialPermits.has(permit)
    ? validatedCanvasName(name).pipe(
        Effect.flatMap((canonicalName) =>
          call(
            "remove",
            { name: canonicalName, authorialWrite: true },
            options,
          ),
        ),
        Effect.flatMap((value) => decodeData(CanvasControlRemoveData, value)),
      )
    : Effect.fail(
        new CanvasControlClientError({
          code: "AuthorialWriteDenied",
          message: "canvas removal requires a live authorial-write permit",
          retryable: false,
        }),
      );
