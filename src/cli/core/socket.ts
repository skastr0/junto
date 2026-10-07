import { createConnection, type Socket } from "node:net";
import { resolveJuntoHome } from "@shared/junto-home";
import { Context, Effect, Layer, Result } from "effect";
import {
  decodeOverseerRequest,
  isOverseerMutation,
  type OverseerOperation,
} from "../../shared/overseer-control";
import {
  WORK_DEFAULT_TIMEOUT_MS,
  WORK_HOME_ENV,
  WORK_MAX_FRAME_BYTES,
  WORK_TOKEN_ENV,
  decodeWorkResponse,
  encodeWorkFrame,
  isSeatCredentialShape,
  workControlDir,
  workControlSocketPath,
  type WorkOpName,
  type WorkResponseEnvelope,
} from "../../shared/work-control";
import { AuthError, RuntimeDown, WireError } from "./errors";

export const resolveWorkHome = (): string => {
  const env = process.env[WORK_HOME_ENV]?.trim();
  if (env) return env;
  return workControlDir(resolveJuntoHome());
};

/**
 * effect-foundation **S4-rest-main** (staged, not half-migrated):
 * - Canonical id: `@junto/cli/WorkSocket` — single definition; no dual path.
 * - Service id: Context.Service (Effect V4 live).
 * - Shape:
 *   `class WorkSocket extends Context.Service<WorkSocket, WorkSocket>()("@junto/cli/WorkSocket") {}`
 * - Layer today: WorkSocketLive — V4 rename candidate WorkSocket.layer
 *   Do not dual-export Live + `.layer` names.
 */
export class WorkSocket extends Context.Service<WorkSocket,
  {
    readonly call: (
      op: WorkOpName,
      args?: unknown,
      timeoutMs?: number,
    ) => Effect.Effect<unknown, RuntimeDown | AuthError | WireError>;
  }>()("@junto/cli/WorkSocket") {}

/**
 * Seat generation credential from the seat process environment. Main injects
 * it at spawn; presenting it is what identifies the generation — no ancestry
 * is checked. A seat child can still lack it when its harness filters the
 * tool environment. The value is never printed, logged, or placed on argv.
 */
const readSeatCredential = (): Effect.Effect<string, AuthError> =>
  Effect.sync(() => process.env[WORK_TOKEN_ENV]?.trim() ?? "").pipe(
    Effect.flatMap((value) =>
      value.length > 0
        ? Effect.succeed(value)
        : Effect.fail(
            new AuthError({
              message: "this process has no Junto seat credential",
              next_step: `run the CLI from inside your Junto seat; if already inside one, check that the harness forwards ${WORK_TOKEN_ENV} to tool shells instead of filtering it`,
            }),
          ),
    ),
  );

const mutatingOverseerOperation = (
  op: string,
  args: unknown,
): OverseerOperation | undefined => {
  if (op !== "overseer") return undefined;
  const request = decodeOverseerRequest(args);
  if (Result.isFailure(request)) return undefined;
  return isOverseerMutation(request.success.operation)
    ? request.success.operation
    : undefined;
};

const ndjsonCall = (
  socketPath: string,
  token: string,
  op: WorkOpName,
  args: unknown,
  timeoutMs: number,
): Effect.Effect<WorkResponseEnvelope, RuntimeDown | WireError> =>
  Effect.callback<WorkResponseEnvelope, RuntimeDown | WireError>((resume) => {
    let settled = false;
    let requestDispatched = false;
    let buffer = Buffer.alloc(0);
    let socket: Socket | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const mutatingOperation = mutatingOverseerOperation(op, args) ??
      (["msg.send", "msg.prompt", "msg.reply", "verdict.post"].includes(op) ? op : undefined);

    const transportFailure = (
      type: string,
      message: string,
      details?: unknown,
    ): WireError => {
      if (mutatingOperation === undefined || !requestDispatched) {
        return new WireError({
          type,
          message,
          ...(details !== undefined ? { details } : {}),
        });
      }
      return new WireError({
        type: "UncertainCompletion",
        message:
          `${message}; operation ${mutatingOperation} may have completed`,
        details: {
          retryable: false,
          operation: mutatingOperation,
          ...(["msg.send", "msg.prompt", "msg.reply"].includes(mutatingOperation)
            ? { next_step: "inspect msg sent before sending again; the mail may already be in the recipient's mailbox" }
            : {}),
        },
      });
    };

    const settle = (result: Effect.Effect<WorkResponseEnvelope, RuntimeDown | WireError>) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      try {
        socket?.destroy();
      } catch {
        // ignore
      }
      resume(result);
    };

    timer = setTimeout(() => {
      settle(
        Effect.fail(
          transportFailure(
            "ProtocolError",
            `request timed out after ${timeoutMs}ms`,
            { retryable: true },
          ),
        ),
      );
    }, timeoutMs);

    try {
      socket = createConnection({ path: socketPath });
    } catch (error) {
      settle(
        Effect.fail(
          new RuntimeDown({
            message:
              error instanceof Error ? error.message : "failed to open work control socket",
            next_step: "launch Junto, then `junto doctor`",
          }),
        ),
      );
      return;
    }

    socket.on("connect", () => {
      // Identity is process-bind (peer PID). No client-supplied nodeRef.
      try {
        const frame = encodeWorkFrame({
          token,
          op,
          ...(args !== undefined ? { args } : {}),
        });
        requestDispatched = true;
        socket?.write(frame);
      } catch (error) {
        settle(
          Effect.fail(
            transportFailure(
              "ProtocolError",
              error instanceof Error
                ? error.message
                : "request could not be encoded or written",
            ),
          ),
        );
      }
    });

    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.byteLength > WORK_MAX_FRAME_BYTES) {
        settle(
          Effect.fail(
            transportFailure(
              "ProtocolError",
              `response exceeds ${WORK_MAX_FRAME_BYTES} bytes`,
            ),
          ),
        );
        return;
      }
      const nl = buffer.indexOf(0x0a);
      if (nl < 0) return;
      const line = buffer.subarray(0, nl).toString("utf8").replace(/\r$/, "").trim();
      try {
        const raw = JSON.parse(line) as unknown;
        const decoded = decodeWorkResponse(raw);
        if (decoded._tag === "Failure") {
          settle(
            Effect.fail(
              transportFailure(
                "ProtocolError",
                "server returned a malformed envelope",
              ),
            ),
          );
          return;
        }
        settle(Effect.succeed(decoded.success));
      } catch {
        settle(
          Effect.fail(
            transportFailure(
              "ProtocolError",
              "server returned non-JSON",
            ),
          ),
        );
      }
    });

    socket.on("error", (error: NodeJS.ErrnoException) => {
      if (requestDispatched && mutatingOperation !== undefined) {
        settle(
          Effect.fail(transportFailure("InternalError", error.message)),
        );
        return;
      }
      if (
        error.code === "ENOENT" ||
        error.code === "ECONNREFUSED" ||
        error.code === "FailedToOpenSocket"
      ) {
        settle(
          Effect.fail(
            new RuntimeDown({
              message: "Junto app is not running (work socket down)",
              next_step: "launch Junto, then `junto doctor`",
            }),
          ),
        );
        return;
      }
      settle(
        Effect.fail(
          transportFailure("InternalError", error.message),
        ),
      );
    });

    socket.on("close", () => {
      if (!settled) {
        settle(
          Effect.fail(
            transportFailure(
              "ProtocolError",
              "socket closed before response",
            ),
          ),
        );
      }
    });
  });

export const WorkSocketLive = Layer.succeed(
  WorkSocket,
  WorkSocket.of({
    call: (op, args, timeoutMs) =>
      Effect.gen(function* () {
        const workHome = resolveWorkHome();
        const token = yield* readSeatCredential();
        const envelope = yield* ndjsonCall(
          workControlSocketPath(workHome),
          token,
          op,
          args,
          timeoutMs ?? WORK_DEFAULT_TIMEOUT_MS,
        );
        if (!envelope.ok) {
          if (envelope.error.type === "AuthError") {
            return yield* Effect.fail(
              new AuthError({
                message: envelope.error.message,
                next_step: envelope.error.details?.next_step as string | undefined,
              }),
            );
          }
          if (envelope.error.type === "RuntimeDown") {
            return yield* Effect.fail(
              new RuntimeDown({
                message: envelope.error.message,
                next_step: envelope.error.details?.next_step as string | undefined,
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
        return envelope.data;
      }),
  }),
);

/**
 * Local doctor checks without a full round-trip when socket is missing. This
 * is the harness qualification probe contract: presence, shape, and (via the
 * live ping in doctor) validity of the seat credential, without ever printing
 * the value. A harness tool-exec path qualifies when all three hold here.
 */
export const localDoctorChecks = Effect.gen(function* () {
  const workHome = resolveWorkHome();
  const socketPath = workControlSocketPath(workHome);

  const statMode = async (path: string): Promise<number | null> => {
    try {
      const { stat } = await import("node:fs/promises");
      const s = await stat(path);
      return s.mode & 0o777;
    } catch {
      return null;
    }
  };

  const socketMode = yield* Effect.promise(() => statMode(socketPath));
  const credential = process.env[WORK_TOKEN_ENV]?.trim() ?? "";

  return {
    work_home: workHome,
    socket_path: socketPath,
    socket_present: socketMode !== null,
    credential_present: credential.length > 0,
    credential_shape_ok: credential.length > 0 && isSeatCredentialShape(credential),
    socket_mode: socketMode,
    socket_mode_ok: socketMode === 0o600 || socketMode === null,
  };
});
