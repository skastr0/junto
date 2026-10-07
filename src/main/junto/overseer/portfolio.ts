import { Effect, Schema } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { Command } from "@shared/model";
import { CanvasName, type Canvas } from "@shared/model";
import type { WorkErrorBody } from "@shared/work-control";
import { ModelNotFound, ModelRefused, type ModelError } from "../model/records";
import type { ModelActorRefs } from "../model/actor-refs";
import { ModelService } from "../model/service";
import { StateTransactionOperation } from "../state/service";
import type { WorkRepository } from "../work/repository";

// How the overseer reads and changes canvases: as the model holds them, by
// model commands sent with source "overseer". The model is the authority that
// accepts or refuses each one; the overseer's own rules (shared/overseer-rules)
// only say no earlier.

export type OverseerStores =
  | ModelService
  | ModelActorRefs
  | SqlClient.SqlClient
  | WorkRepository;

export const fromModelError = (error: ModelError): WorkErrorBody => {
  if (error instanceof ModelNotFound) {
    return {
      type: "UnknownTarget",
      message: `${error.what} "${error.id}" does not exist`,
    };
  }
  if (error instanceof ModelRefused) {
    // The model's one rule about authority names the overseer seat; every
    // other refusal is about what was sent.
    return {
      type: /overseer/iu.test(error.rule) ? "AuthError" : "InputError",
      message: error.rule,
    };
  }
  return { type: "InternalError", message: "the canvas store could not be read or written" };
};

export const isCanvasName = Schema.is(CanvasName);

/** The name as the model takes it, or the refusal an overseer is told. */
export const canvasNameOf = (
  raw: string,
): Effect.Effect<CanvasName, WorkErrorBody> =>
  isCanvasName(raw)
    ? Effect.succeed(raw)
    : Effect.fail({
        type: "InputError",
        message: `invalid canvas name ${JSON.stringify(raw)}`,
      });

/** Every canvas as the model holds it now, by name. */
export const readCanvases: Effect.Effect<
  ReadonlyMap<string, Canvas>,
  WorkErrorBody,
  ModelService
> = Effect.gen(function* () {
  const model = yield* ModelService;
  const canvases = new Map<string, Canvas>();
  for (const name of yield* model.listCanvases()) {
    canvases.set(name, yield* model.canvas(name));
  }
  return canvases;
}).pipe(Effect.mapError(fromModelError));

/** One canvas, by the name an overseer gave. */
export const readCanvas = (
  raw: string,
): Effect.Effect<Canvas, WorkErrorBody, ModelService> =>
  Effect.gen(function* () {
    const name = yield* canvasNameOf(raw);
    const model = yield* ModelService;
    return yield* model.canvas(name).pipe(Effect.mapError(fromModelError));
  });

export type OverseerEdit<A> =
  | {
      readonly ok: true;
      readonly commands: ReadonlyArray<Command>;
      readonly result: A;
    }
  | { readonly ok: false; readonly error: WorkErrorBody };

/**
 * Read every canvas, let a rule say which commands to send, and send them,
 * all in one transaction: the rule decides on exactly what is committed
 * against, and either every command lands or none does.
 */
export const editCanvases = <A>(
  rule: (canvases: ReadonlyMap<string, Canvas>) => OverseerEdit<A>,
): Effect.Effect<A, WorkErrorBody, OverseerStores> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const model = yield* ModelService;
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const edit = rule(yield* readCanvases);
          if (!edit.ok) return yield* Effect.fail(edit.error);
          for (const command of edit.commands) {
            yield* model.command(command, "overseer").pipe(Effect.mapError(fromModelError));
          }
          return edit.result;
        }),
      )
      .pipe(
        // The name a live request's receipt is recorded under (live/service.ts
        // afterMutation): this is the transaction that owns an overseer write.
        Effect.provideService(StateTransactionOperation, "canvas.mutatePortfolio"),
        Effect.mapError((error): WorkErrorBody =>
          // A rule's refusal and a model refusal are already what an overseer
          // is told. Anything else came from a participant in the transaction
          // (a live request's fence, the store itself) and keeps its words.
          typeof error === "object" && error !== null && "type" in error && "message" in error
            ? (error as WorkErrorBody)
            : {
                type: "InternalError",
                message:
                  error instanceof Error
                    ? error.message
                    : "the canvas store could not be written",
              },
        ),
      );
  });
