import { Effect } from "effect";
import { InputError } from "./errors";
import { readSource, sourceOf } from "./signal-input";

/**
 * A prose body for a write command. Prose never has to be JSON-escaped: it
 * comes from `--body <text | @file | ->`, the same source rule as `--detail`,
 * or as `"body"` in the JSON argument. Never both, and never empty.
 */
export type BodyRequest = {
  /** The raw positional argument, when one was typed. */
  readonly input: string | undefined;
  /** The decoded JSON argument. */
  readonly argument: unknown;
  /** The raw `--body` value, when the flag was given. */
  readonly flag: string | undefined;
  /** What to say when the body is empty: what the caller should do instead. */
  readonly emptyMessage: string;
};

const isStdin = (raw: string | undefined): boolean => {
  const trimmed = raw?.trim();
  return trimmed === "-" || trimmed === "@-";
};

/** Pure: refuse the mixes before anything is read. */
export const bodyPlanProblem = (request: BodyRequest): InputError | undefined => {
  if (typeof request.argument !== "object" || request.argument === null || Array.isArray(request.argument)) {
    return new InputError({ message: "the argument must be a JSON object", path: "input" });
  }
  const inArgument = "body" in request.argument;
  if (inArgument && request.flag !== undefined) {
    return new InputError({
      message: "the body was given twice: as \"body\" in the argument and with --body",
      path: "--body",
      hint: "keep one of them",
    });
  }
  if (!inArgument && request.flag === undefined) {
    return new InputError({
      message: "this command needs a body",
      path: "--body",
      hint: "--body <text | @file | ->, or \"body\" in the JSON argument",
    });
  }
  if (isStdin(request.input) && isStdin(request.flag)) {
    return new InputError({
      message: "stdin can feed the argument or --body, not both",
      path: "--body",
      hint: "pass the JSON argument inline and pipe the body: ... | junto overseer references write '{\"name\":\"style\"}' --body -",
    });
  }
  return undefined;
};

/** The wire args: the JSON argument with the body in it. */
export const withBody = (request: BodyRequest): Effect.Effect<Record<string, unknown>, InputError> =>
  Effect.gen(function* () {
    const problem = bodyPlanProblem(request);
    if (problem !== undefined) return yield* Effect.fail(problem);
    const argument = request.argument as Record<string, unknown>;
    const body = request.flag === undefined ? argument.body : yield* readSource(sourceOf(request.flag));
    if (typeof body !== "string") {
      return yield* Effect.fail(new InputError({ message: "the body must be text", path: "body" }));
    }
    if (body.trim().length === 0) {
      return yield* Effect.fail(new InputError({ message: request.emptyMessage, path: "body" }));
    }
    return { ...argument, body };
  });
