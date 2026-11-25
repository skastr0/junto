/**
 * A seat's side of the work socket, for node programs that run as a seat's
 * occupant (the overseer host) and for tests of the core: one op of the work
 * contract (`src/contract/work/`) sent as a seat sends it, its answer decoded
 * by the op's success schema. The core answers from the same contract, so a
 * change to either side fails the caller's compile.
 *
 * It reads what a seat process has: the credential in JUNTO_WORK_TOKEN and
 * the work home in JUNTO_WORK_HOME (by default the Junto home's work folder).
 * Arguments the contract refuses go to the core as given, so the caller reads
 * the core's own refusal in v1's words.
 */
import { createConnection } from "node:net";
import { Context, Effect, Layer, Schema } from "effect";
import type { Rpc } from "effect/rpc";
import { resolveJuntoHome } from "@shared/junto-home";
import {
  WORK_DEFAULT_TIMEOUT_MS,
  WORK_HOME_ENV,
  WORK_MAX_FRAME_BYTES,
  WORK_TOKEN_ENV,
  decodeWorkResponse,
  encodeWorkFrame,
  workControlDir,
  workControlSocketPath,
  type WorkOpName,
  type WorkResponseEnvelope,
} from "@shared/work-control";

/**
 * The op did not complete as asked: the core refused it (its own type, message
 * and details), or the answer was lost or unreadable, which after a send means
 * its outcome is unknown and the caller must not replay it on its own.
 */
export class WorkRefusal extends Schema.TaggedError<WorkRefusal>()("WorkRefusal", {
  type: Schema.String,
  message: Schema.String,
  details: Schema.optionalKey(Schema.Unknown),
}) {}

export class WorkSocket extends Context.Service<WorkSocket, {
  readonly call: (op: WorkOpName, args: unknown, timeoutMs: number) => Effect.Effect<unknown, WorkRefusal>;
}>()("@junto/node/WorkSocket") {}

type WorkRpc = Rpc.Any & Rpc.AnyWithProps & { readonly _tag: WorkOpName };

const workHome = (): string => process.env[WORK_HOME_ENV]?.trim() || workControlDir(resolveJuntoHome());

/** One frame out, one line back: the envelope as the core wrote it. */
const exchange = (op: WorkOpName, args: unknown, timeoutMs: number): Effect.Effect<WorkResponseEnvelope, WorkRefusal> =>
  Effect.callback<WorkResponseEnvelope, WorkRefusal>((resume) => {
    const token = process.env[WORK_TOKEN_ENV]?.trim();
    if (!token) {
      resume(Effect.fail(new WorkRefusal({ type: "AuthError", message: `${WORK_TOKEN_ENV} is not set: this process is not a seat` })));
      return;
    }
    const socket = createConnection({ path: workControlSocketPath(workHome()) });
    let buffer = "";
    let settled = false;
    const settle = (result: Effect.Effect<WorkResponseEnvelope, WorkRefusal>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resume(result);
    };
    const fail = (type: string, message: string) => settle(Effect.fail(new WorkRefusal({ type, message })));
    const timer = setTimeout(() => fail("Timeout", `${op} had no answer in ${String(timeoutMs)}ms`), timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(encodeWorkFrame({ token, op, ...(args === undefined ? {} : { args }) })));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) {
        if (Buffer.byteLength(buffer) > WORK_MAX_FRAME_BYTES) fail("ProtocolError", `${op}: response exceeds ${String(WORK_MAX_FRAME_BYTES)} bytes`);
        return;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(buffer.slice(0, end));
      } catch {
        return fail("ProtocolError", `${op} answered with a line that is not JSON`);
      }
      const decoded = decodeWorkResponse(raw);
      if (decoded._tag === "Failure") return fail("ProtocolError", `${op} answered with a malformed envelope`);
      settle(Effect.succeed(decoded.success));
    });
    socket.on("error", (error) => fail("RuntimeDown", `${op}: ${error.message}`));
    socket.on("close", () => fail("ProtocolError", `${op}: the socket closed before the answer`));
  });

export const WorkSocketLive = Layer.succeed(WorkSocket, WorkSocket.of({
  call: (op, args, timeoutMs) =>
    Effect.flatMap(exchange(op, args, timeoutMs), (envelope) =>
      envelope.ok
        ? Effect.succeed(envelope.data)
        : Effect.fail(new WorkRefusal({
          type: envelope.error.type,
          message: envelope.error.message,
          ...(envelope.error.details === undefined ? {} : { details: envelope.error.details }),
        }))),
}));

/** One work op through its contract: its arguments as the op types them, its answer as the op decodes it. */
export const callWorkRpc = <R extends WorkRpc>(
  rpc: R,
  args: Rpc.Payload<R>,
  timeoutMs: number = WORK_DEFAULT_TIMEOUT_MS,
): Effect.Effect<Rpc.Success<R>, WorkRefusal, WorkSocket> => {
  // The work contract's schemas are JSON and need no services to encode or decode.
  const payload = Schema.toCodecJson(rpc.payloadSchema) as unknown as Schema.Codec<Rpc.Payload<R>, unknown>;
  const answer = Schema.toCodecJson(rpc.successSchema) as unknown as Schema.Codec<Rpc.Success<R>, unknown>;
  return Effect.gen(function* () {
    const socket = yield* WorkSocket;
    const encoded = yield* Schema.encodeEffect(payload)(args).pipe(Effect.orElseSucceed((): unknown => args));
    const data = yield* socket.call(rpc._tag, encoded, timeoutMs);
    return yield* Schema.decodeUnknownEffect(answer)(data).pipe(
      Effect.mapError((issue) => new WorkRefusal({ type: "ProtocolError", message: `${rpc._tag} answered in a shape its contract does not read: ${issue.message}` })),
    );
  });
};
