import { Effect, Schema } from "effect";
import { InputError } from "./errors";
import { loadBatchJsonInput } from "./json";
import { setExitCode, toErrorDetails } from "./output";
import { DEFAULT_BATCH_CONCURRENCY } from "./constants";

export type BatchResultItem =
  | { readonly index: number; readonly ok: true; readonly data: unknown }
  | {
      readonly index: number;
      readonly ok: false;
      readonly error: ReturnType<typeof toErrorDetails>;
    };

export type BatchOutcome = "succeeded" | "partial_failure" | "failed";

export interface BatchMutationResult {
  readonly outcome: BatchOutcome;
  readonly total: number;
  readonly success_count: number;
  readonly error_count: number;
  readonly concurrency: number;
  readonly results: ReadonlyArray<BatchResultItem>;
}

const summarizeBatchResults = (
  concurrency: number,
  results: ReadonlyArray<BatchResultItem>,
): BatchMutationResult => {
  const error_count = results.filter((result) => !result.ok).length;
  const success_count = results.length - error_count;
  const outcome: BatchOutcome =
    error_count === 0 ? "succeeded" : success_count === 0 ? "failed" : "partial_failure";
  return {
    outcome,
    total: results.length,
    success_count,
    error_count,
    concurrency,
    results,
  };
};

export const runMutationBatch = <A, I, R>(options: {
  readonly input: string;
  readonly concurrency: number;
  readonly itemSchema: Schema.Schema<A, I, R>;
  readonly run: (item: A) => Effect.Effect<unknown, unknown, R>;
}) =>
  Effect.gen(function* () {
    if (options.concurrency <= 0) {
      return yield* Effect.fail(
        new InputError({
          message: "concurrency must be a positive integer",
          path: "concurrency",
          received: options.concurrency,
        }),
      );
    }

    const rawItems = yield* loadBatchJsonInput(options.input);
    const results = yield* Effect.forEach(
      rawItems,
      (rawItem, index) =>
        Effect.gen(function* () {
          const item = yield* Schema.decodeUnknown(options.itemSchema)(rawItem).pipe(
            Effect.mapError(
              (error) =>
                new InputError({
                  message: error.message,
                  path: `item[${index}]`,
                }),
            ),
          );
          const data = yield* options.run(item);
          return { index, ok: true as const, data };
        }).pipe(
          Effect.catch((error) =>
            Effect.succeed({
              index,
              ok: false as const,
              error: toErrorDetails(error),
            }),
          ),
        ),
      { concurrency: options.concurrency },
    );

    // Preserve submission order by index (Effect.forEach already does).
    const ordered = [...results].sort((a, b) => a.index - b.index);
    const summary = summarizeBatchResults(options.concurrency, ordered);
    if (summary.error_count > 0) {
      yield* setExitCode(1);
    }
    return summary;
  });

export { DEFAULT_BATCH_CONCURRENCY };
