/**
 * The work socket's RPC server: every group the socket serves, answered by
 * an Effect `RpcServer` inside the core, behind the v1 frames.
 *
 * The work server keeps the socket: it reads a frame, admits its seat, and
 * hands the op here with that seat. Each call is one client of the RPC
 * server, so the `WorkAdmission` middleware finds the seat by the client's id
 * and provides it to the handler. The server decodes the arguments with the
 * op's payload schema, runs the handler, and encodes its answer with the
 * success schema, so an answer the contract does not describe is refused
 * here rather than written. The exit comes back as v1 reads it: the answer's
 * `data`, or the error body.
 *
 * A call interrupted (its seat's credential revoked mid-call) leaves the RPC
 * server as a client that disconnected, which interrupts its handler.
 */
import { Context, Deferred, Effect, Layer, Queue, Result, Schema } from "effect";
import { type RpcMessage, RpcServer } from "effect/rpc";
import { type WorkErrorBody } from "@shared/work-control";
import { WorkFailure, WorkInputRefusal, workErrorBody } from "../../contract/work/failure";
import { WorkHandlers, WorkServed } from "./families";
import { WorkAdmission, WorkSeat } from "./seat";

const decodeFailure = Schema.decodeUnknownResult(Schema.toCodecJson(WorkFailure));
/** A defect as the server encoded it, back as the error it was, so its words reach the v1 InternalError. */
const decodeDefect = Schema.decodeUnknownSync(Schema.toCodecJson(Schema.Defect()));

/** A call the RPC server is answering: the seat it was admitted as, the services it runs with, and where its exit lands. */
type Call = {
  readonly seat: WorkSeat["Service"];
  /** The calling fiber's services: the handler runs with them, as it would inline. */
  readonly context: Context.Context<never>;
  /** The middleware handed the seat to the handler: the arguments decoded. */
  admitted: boolean;
  readonly exit: Deferred.Deferred<RpcMessage.FromServerEncoded>;
};

/** A request's id on its own client: each call is its own client, with one request. */
const REQUEST_ID = "0";

/** The refusal for arguments that did not decode: the op's own words, or the schema's. */
const inputRefusal = (rpc: { readonly annotations: Context.Context<never> } | undefined, reason: unknown): WorkErrorBody =>
  (rpc === undefined ? undefined : Context.get(rpc.annotations, WorkInputRefusal)) ?? {
    type: "InputError",
    message: typeof reason === "string" ? reason : "arguments do not match the command schema",
    details: { path: "args", hint: "pass a JSON object matching the command schema", retryable: false },
  };

/** The socket answers this op through RPC. */
export const servesWorkRpc = (op: string): boolean => WorkServed.requests.has(op);

export class WorkRpcServer extends Context.Service<WorkRpcServer, {
  /** One admitted call: its answer's data, or its v1 error body. A handler's defect stays a defect. */
  readonly dispatch: (op: string, args: unknown, seat: WorkSeat["Service"]) => Effect.Effect<unknown, WorkErrorBody>;
}>()("@junto/core/work-control/WorkRpcServer") {
  static readonly layer = Layer.effect(
    WorkRpcServer,
    Effect.gen(function* () {
      const calls = new Map<number, Call>();
      const disconnects = yield* Queue.unbounded<number>();
      let nextClient = 0;
      let write: ((clientId: number, data: RpcMessage.FromClientEncoded) => Effect.Effect<void>) | undefined;

      const protocol = yield* RpcServer.Protocol.make((writeRequest) => {
        write = writeRequest;
        return Effect.succeed({
          disconnects,
          send: (clientId: number, response: RpcMessage.FromServerEncoded) => {
            const call = calls.get(clientId);
            if (call === undefined || (response._tag !== "Exit" && response._tag !== "Defect")) return Effect.void;
            return Deferred.succeed(call.exit, response).pipe(Effect.asVoid);
          },
          end: () => Effect.void,
          clientIds: Effect.sync(() => new Set(calls.keys())),
          initialMessage: Effect.succeedNone,
          supportsAck: false,
          supportsTransferables: false,
          supportsSpanPropagation: false,
          supportsNotifications: false,
          codecFor: Schema.toCodecJson,
        });
      });

      const admission = WorkAdmission.of((effect, { client }) => {
        const call = calls.get(client.id);
        if (call === undefined) return Effect.die(new Error(`work rpc: client ${client.id} has no admitted call`));
        call.admitted = true;
        return effect.pipe(Effect.provideService(WorkSeat, call.seat), Effect.provide(call.context));
      });

      yield* RpcServer.make(WorkServed, { disableTracing: true }).pipe(
        Effect.provideService(RpcServer.Protocol, protocol),
        Effect.provideService(WorkAdmission, admission),
        Effect.forkScoped,
      );

      const answerOf = (op: string, call: Call, response: RpcMessage.FromServerEncoded): Effect.Effect<unknown, WorkErrorBody> => {
        if (response._tag === "Defect") return Effect.die(decodeDefect(response.defect));
        if (response._tag !== "Exit") return Effect.die(new Error(`work rpc: ${op} answered ${response._tag}`));
        const exit = response.exit;
        if (exit._tag === "Success") return Effect.succeed(exit.value);
        for (const reason of exit.cause) {
          if (reason._tag === "Fail") {
            const failure = decodeFailure(reason.error);
            return Result.isSuccess(failure)
              ? Effect.fail(workErrorBody(failure.success))
              : Effect.die(new Error(`work rpc: ${op} failed with an error the contract does not describe`));
          }
        }
        for (const reason of exit.cause) {
          if (reason._tag === "Die") {
            // The server dies a request whose payload did not decode before
            // any middleware runs; a seat never admitted means just that.
            return call.admitted ? Effect.die(decodeDefect(reason.defect)) : Effect.fail(inputRefusal(WorkServed.requests.get(op), reason.defect));
          }
        }
        return Effect.interrupt;
      };

      return WorkRpcServer.of({
        dispatch: (op, args, seat) =>
          Effect.suspend(() => {
            const send = write;
            if (send === undefined) return Effect.die(new Error("work rpc: the server is not running"));
            const clientId = ++nextClient;
            return Effect.flatMap(Effect.all([Deferred.make<RpcMessage.FromServerEncoded>(), Effect.context<never>()]), ([exit, context]) => {
              const call: Call = { seat, context, admitted: false, exit };
              calls.set(clientId, call);
              return send(clientId, { _tag: "Request", id: REQUEST_ID, tag: op, payload: args ?? {}, headers: [] }).pipe(
                Effect.andThen(Deferred.await(exit)),
                Effect.flatMap((response) => answerOf(op, call, response)),
                Effect.ensuring(
                  Effect.suspend(() => {
                    calls.delete(clientId);
                    return Queue.offer(disconnects, clientId);
                  }),
                ),
              );
            });
          }),
      });
    }),
  ).pipe(Layer.provide(WorkHandlers));
}
