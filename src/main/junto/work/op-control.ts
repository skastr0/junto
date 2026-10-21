/**
 * `op.show` and `op.list` on the work plane: a seat reads what became of its
 * own resource writes, by opId (plan 02). Seat-local, like signal list: no
 * target, no edge, and never another seat's writes.
 */
import { Effect, Option, Result, Schema } from "effect";
import { OP_LIST_MAX, OpListArgs, OpShowArgs, unknownOpError, type OpListResult, type OpView } from "@shared/op-control";
import type { NodeId } from "@shared/physics/schema";
import type { WorkErrorBody } from "@shared/work-control";
import { OpRepository } from "./op-repository";

export const OP_OPS = ["op.show", "op.list"] as const;
export type OpOp = (typeof OP_OPS)[number];
export const isOpOp = (op: string): op is OpOp => (OP_OPS as ReadonlyArray<string>).includes(op);

/** What `op list` shows when no limit is asked for. */
export const OP_LIST_DEFAULT = 50;

const decode = <S extends Schema.Top>(schema: S, args: unknown): Effect.Effect<S["Type"], WorkErrorBody> => {
  const decoded = Schema.decodeUnknownResult(schema as never, { onExcessProperty: "error" })(args ?? {});
  return Result.isFailure(decoded)
    ? Effect.fail({
        type: "InputError",
        message: String((decoded.failure as { readonly message?: unknown }).message ?? decoded.failure),
        details: { path: "args", hint: "junto schema show shows this command's input", retryable: false },
      })
    : Effect.succeed(decoded.success as S["Type"]);
};

const unreadable = (message: string): WorkErrorBody => ({
  type: "InternalError",
  message: `this seat's writes could not be read: ${message}`,
  details: { retryable: true },
});

export const handleOpOp = (
  op: OpOp,
  args: unknown,
  caller: { readonly canvasName: string; readonly nodeId: NodeId },
): Effect.Effect<{ readonly op: OpView } | OpListResult, WorkErrorBody> =>
  Effect.gen(function* () {
    const repository = yield* Effect.serviceOption(OpRepository);
    if (Option.isNone(repository)) {
      return yield* Effect.fail<WorkErrorBody>({
        type: "InputError",
        message: "the record of resource writes is not built in this Junto build yet",
        details: { reason: "not_available", retryable: false },
      });
    }
    const scope = { canvasName: caller.canvasName, seat: caller.nodeId };
    switch (op) {
      case "op.show": {
        const { opId } = yield* decode(OpShowArgs, args);
        const view = yield* repository.value.show(scope, opId).pipe(Effect.mapError((error) => unreadable(error.message)));
        if (view === undefined) return yield* Effect.fail(unknownOpError(opId));
        return { op: view };
      }
      case "op.list": {
        const input = yield* decode(OpListArgs, args);
        return yield* repository.value
          .list(scope, {
            ...(input.state === undefined ? {} : { state: input.state }),
            ...(input.before === undefined ? {} : { before: input.before }),
            limit: Math.min(input.limit ?? OP_LIST_DEFAULT, OP_LIST_MAX),
          })
          .pipe(Effect.mapError((error) => unreadable(error.message)));
      }
    }
  });
