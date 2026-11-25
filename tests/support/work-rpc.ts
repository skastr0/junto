/**
 * A seat's side of the work socket for tests of the core: one op of the work
 * contract (`src/contract/work/`) sent as a seat sends it, its answer decoded
 * by the op's success schema. The core answers from the same contract, so a
 * change to either side fails these tests' compile.
 *
 * It reads what a seat process has: the credential in JUNTO_WORK_TOKEN and
 * the work home in JUNTO_WORK_HOME. Arguments the contract refuses go to the
 * core as given, so a test reads the core's own refusal in v1's words.
 */
import { createConnection } from "node:net";
import { Effect, Schema } from "effect";
import type { Rpc } from "effect/rpc";
import {
  WORK_DEFAULT_TIMEOUT_MS,
  WORK_HOME_ENV,
  WORK_TOKEN_ENV,
  decodeWorkResponse,
  encodeWorkFrame,
  workControlSocketPath,
  type WorkOpName,
  type WorkResponseEnvelope,
} from "../../src/shared/work-control";

/** The core refused the op, or its answer did not arrive in a shape the contract reads. */
export class WorkRefusal extends Schema.TaggedError<WorkRefusal>()("WorkRefusal", {
  type: Schema.String,
  message: Schema.String,
  details: Schema.optionalKey(Schema.Unknown),
}) {}

type WorkRpc = Rpc.Any & Rpc.AnyWithProps & { readonly _tag: WorkOpName };

/** One frame out, one line back: the envelope as the core wrote it. */
const exchange = (op: WorkOpName, args: unknown, timeoutMs: number): Effect.Effect<WorkResponseEnvelope, WorkRefusal> =>
  Effect.callback<WorkResponseEnvelope, WorkRefusal>((resume) => {
    const home = process.env[WORK_HOME_ENV]?.trim();
    const token = process.env[WORK_TOKEN_ENV]?.trim();
    if (!home || !token) {
      resume(Effect.fail(new WorkRefusal({ type: "SetupError", message: `${WORK_HOME_ENV} and ${WORK_TOKEN_ENV} must name the test's work home and seat` })));
      return;
    }
    const socket = createConnection({ path: workControlSocketPath(home) });
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
    const timer = setTimeout(() => fail("ProtocolError", `${op} had no answer in ${String(timeoutMs)}ms`), timeoutMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(encodeWorkFrame({ token, op, ...(args === undefined ? {} : { args }) })));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
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
    socket.on("error", (error) => fail("InternalError", error.message));
    socket.on("close", () => fail("ProtocolError", `${op}: the socket closed before the answer`));
  });

/** One work op through its contract: its arguments as the op types them, its answer as the op decodes it. */
export const callWorkRpc = <R extends WorkRpc>(
  rpc: R,
  args: Rpc.Payload<R>,
  timeoutMs: number = WORK_DEFAULT_TIMEOUT_MS,
): Effect.Effect<Rpc.Success<R>, WorkRefusal> => {
  // The work contract's schemas are JSON and need no services to encode or decode.
  const payload = Schema.toCodecJson(rpc.payloadSchema) as unknown as Schema.Codec<Rpc.Payload<R>, unknown>;
  const answer = Schema.toCodecJson(rpc.successSchema) as unknown as Schema.Codec<Rpc.Success<R>, unknown>;
  return Effect.gen(function* () {
    const encoded = yield* Schema.encodeEffect(payload)(args).pipe(Effect.orElseSucceed((): unknown => args));
    const envelope = yield* exchange(rpc._tag, encoded, timeoutMs);
    if (!envelope.ok) {
      return yield* new WorkRefusal({
        type: envelope.error.type,
        message: envelope.error.message,
        ...(envelope.error.details === undefined ? {} : { details: envelope.error.details }),
      });
    }
    return yield* Schema.decodeUnknownEffect(answer)(envelope.data).pipe(
      Effect.mapError((issue) => new WorkRefusal({ type: "ProtocolError", message: `${rpc._tag} answered in a shape its contract does not read: ${issue.message}` })),
    );
  });
};
