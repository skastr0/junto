import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import { resolveJuntoHome } from "@shared/junto-home";
import { Context, Effect, Layer } from "effect";
import {
  OPERATOR_DEFAULT_TIMEOUT_MS,
  OPERATOR_DEPLOY_TIMEOUT_MS,
  OPERATOR_MAX_REQUEST_BYTES,
  OPERATOR_MAX_RESPONSE_BYTES,
  OPERATOR_SYNC_TIMEOUT_MS,
  decodeOperatorRequest,
  decodeOperatorResponse,
  encodeOperatorFrame,
  operatorControlSocketPath,
  type OperatorArgsByOp,
  type OperatorDataByOp,
  type OperatorOpName,
  type OperatorRequestEnvelope,
  type OperatorResponseEnvelope,
} from "../../shared/operator-control";
import { AuthError, RuntimeDown, WireError } from "./errors";

type OperatorSocketError = RuntimeDown | AuthError | WireError;

export const resolveOperatorSocketPath = (): string =>
  operatorControlSocketPath(resolveJuntoHome());

export const defaultOperatorTimeout = (op: OperatorOpName): number => {
  if (op === "fleet.deploy" || op === "fleet.qualify") {
    return OPERATOR_DEPLOY_TIMEOUT_MS;
  }
  if (
    op === "fleet.sync" ||
    op === "qualification.work.prepare" ||
    op === "qualification.work.progress-offline" ||
    op === "qualification.work.verify"
  ) {
    return OPERATOR_SYNC_TIMEOUT_MS;
  }
  return OPERATOR_DEFAULT_TIMEOUT_MS;
};

const runtimeDown = () =>
  new RuntimeDown({
    message: "Junto operator control is unavailable",
    next_step:
      "launch Junto with `--junto-operator-control`, then retry this command",
  });

const appendBounded = (
  current: Buffer<ArrayBufferLike>,
  chunk: Buffer<ArrayBufferLike>,
): Buffer<ArrayBufferLike> | undefined => {
  const nextBytes = current.byteLength + chunk.byteLength;
  if (nextBytes > OPERATOR_MAX_RESPONSE_BYTES) {
    chunk.fill(0);
    return undefined;
  }
  const next = Buffer.allocUnsafe(nextBytes);
  current.copy(next, 0);
  chunk.copy(next, current.byteLength);
  current.fill(0);
  chunk.fill(0);
  return next;
};

const ndjsonCall = (
  socketPath: string,
  request: OperatorRequestEnvelope,
  timeoutMs: number,
): Effect.Effect<OperatorResponseEnvelope, RuntimeDown | WireError> =>
  Effect.callback<OperatorResponseEnvelope, RuntimeDown | WireError>((resume) => {
    let settled = false;
    let responseBuffer: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let requestBuffer: Buffer | undefined;
    let socket: Socket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const release = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      requestBuffer?.fill(0);
      requestBuffer = undefined;
      responseBuffer.fill(0);
      responseBuffer = Buffer.alloc(0);
      try {
        socket?.destroy();
      } catch {
        // Best-effort close on every completion and interruption.
      }
      socket = undefined;
    };

    const settle = (
      result: Effect.Effect<
        OperatorResponseEnvelope,
        RuntimeDown | WireError
      >,
    ) => {
      if (settled) return;
      settled = true;
      release();
      resume(result);
    };

    timer = setTimeout(() => {
      settle(
        Effect.fail(
          new WireError({
            type: "ProtocolError",
            message: `operator request timed out after ${timeoutMs}ms`,
            details: {
              retryable: true,
              operation_may_continue:
                request.op === "fleet.deploy" ||
                request.op === "fleet.qualify",
            },
          }),
        ),
      );
    }, timeoutMs);

    try {
      socket = createConnection({ path: socketPath });
    } catch {
      settle(Effect.fail(runtimeDown()));
      return;
    }

    socket.on("connect", () => {
      try {
        const frame = encodeOperatorFrame(
          request,
          OPERATOR_MAX_REQUEST_BYTES,
        );
        requestBuffer = Buffer.from(frame, "utf8");
        socket?.write(requestBuffer, () => {
          requestBuffer?.fill(0);
          requestBuffer = undefined;
        });
      } catch (error) {
        settle(
          Effect.fail(
            new WireError({
              type: "ProtocolError",
              message:
                error instanceof Error
                  ? error.message
                  : "operator request could not be encoded",
            }),
          ),
        );
      }
    });

    socket.on("data", (incoming: Buffer) => {
      const appended = appendBounded(responseBuffer, incoming);
      if (appended === undefined) {
        settle(
          Effect.fail(
            new WireError({
              type: "ProtocolError",
              message: `operator response exceeds ${OPERATOR_MAX_RESPONSE_BYTES} bytes`,
            }),
          ),
        );
        return;
      }
      responseBuffer = appended;
      const newline = responseBuffer.indexOf(0x0a);
      if (newline < 0) return;

      const trailing = responseBuffer.subarray(newline + 1);
      if (trailing.some((byte) => ![0x09, 0x0a, 0x0d, 0x20].includes(byte))) {
        settle(
          Effect.fail(
            new WireError({
              type: "ProtocolError",
              message: "operator server returned more than one response",
            }),
          ),
        );
        return;
      }

      let lineBytes = responseBuffer.subarray(0, newline);
      if (lineBytes.at(-1) === 0x0d) {
        lineBytes = lineBytes.subarray(0, -1);
      }

      try {
        const line = new TextDecoder("utf-8", { fatal: true }).decode(
          lineBytes,
        );
        const raw = JSON.parse(line) as unknown;
        const decoded = decodeOperatorResponse(raw);
        if (decoded._tag === "Failure") {
          settle(
            Effect.fail(
              new WireError({
                type: "ProtocolError",
                message: "operator server returned a malformed envelope",
              }),
            ),
          );
          return;
        }
        if (
          decoded.success.id !== request.id ||
          decoded.success.op !== request.op
        ) {
          settle(
            Effect.fail(
              new WireError({
                type: "ProtocolError",
                message: "operator response does not match the request",
              }),
            ),
          );
          return;
        }
        settle(Effect.succeed(decoded.success));
      } catch {
        settle(
          Effect.fail(
            new WireError({
              type: "ProtocolError",
              message: "operator server returned non-JSON or invalid UTF-8",
            }),
          ),
        );
      }
    });

    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (
        error.code === "ENOENT" ||
        error.code === "ECONNREFUSED" ||
        error.code === "EACCES"
      ) {
        settle(Effect.fail(runtimeDown()));
        return;
      }
      settle(
        Effect.fail(
          new WireError({
            type: "InternalError",
            message: error.message,
          }),
        ),
      );
    });

    socket.on("close", () => {
      if (!settled) {
        settle(
          Effect.fail(
            new WireError({
              type: "ProtocolError",
              message: "operator socket closed before its response",
              details: {
                operation_may_continue:
                  request.op === "fleet.deploy" ||
                  request.op === "fleet.qualify",
              },
            }),
          ),
        );
      }
    });

    return Effect.sync(() => {
      settled = true;
      release();
    });
  });

/**
 * effect-foundation **S4-rest-main** (staged, not half-migrated):
 * - Canonical id: `@vellum/cli/OperatorSocket` — single definition; no dual path.
 * - Service id: Context.Service (Effect V4 live).
 * - Shape:
 *   `class OperatorSocket extends Context.Service<OperatorSocket, OperatorSocket>()("@junto/cli/OperatorSocket") {}`
 * - Layer today: OperatorSocketLive — V4 rename candidate OperatorSocket.layer
 *   Do not dual-export Live + `.layer` names.
 */
export class OperatorSocket extends Context.Service<OperatorSocket,
  {
    readonly call: <Op extends OperatorOpName>(
      op: Op,
      args: OperatorArgsByOp[Op],
      timeoutMs?: number,
    ) => Effect.Effect<OperatorDataByOp[Op], OperatorSocketError>;
  }>()("@junto/cli/OperatorSocket") {}

export const OperatorSocketLive = Layer.succeed(
  OperatorSocket,
  OperatorSocket.of({
    call: <Op extends OperatorOpName>(
      op: Op,
      args: OperatorArgsByOp[Op],
      timeoutMs?: number,
    ) =>
      Effect.gen(function* () {
        const rawRequest = {
          protocol: "junto-operator/v1",
          id: randomUUID(),
          op,
          args,
        };
        const decodedRequest = decodeOperatorRequest(rawRequest);
        if (decodedRequest._tag === "Failure") {
          return yield* Effect.fail(
            new WireError({
              type: "InputError",
              message: "operator command arguments are invalid",
            }),
          );
        }
        const timeout = timeoutMs ?? defaultOperatorTimeout(op);
        if (
          !Number.isSafeInteger(timeout) ||
          timeout < 250 ||
          timeout > OPERATOR_DEPLOY_TIMEOUT_MS
        ) {
          return yield* Effect.fail(
            new WireError({
              type: "InputError",
              message: "operator timeout is outside the admitted range",
            }),
          );
        }

        const envelope = yield* ndjsonCall(
          resolveOperatorSocketPath(),
          decodedRequest.success,
          timeout,
        );
        if (!envelope.ok) {
          if (
            envelope.error.type === "runtime_down" ||
            envelope.error.type === "shutdown"
          ) {
            return yield* Effect.fail(
              new RuntimeDown({
                message: envelope.error.message,
                next_step: envelope.error.details?.next_step,
              }),
            );
          }
          if (
            envelope.error.type === "auth_error" ||
            envelope.error.type === "forbidden"
          ) {
            return yield* Effect.fail(
              new AuthError({
                message: envelope.error.message,
                next_step: envelope.error.details?.next_step,
              }),
            );
          }
          return yield* Effect.fail(
            new WireError({
              type: envelope.error.type,
              message: envelope.error.message,
              details: envelope.error.details,
            }),
          );
        }

        // Both values have passed the closed response union, and equality
        // above binds this data member to the requested operation.
        return envelope.data as OperatorDataByOp[Op];
      }),
  }),
);
