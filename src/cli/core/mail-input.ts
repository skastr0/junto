import { Effect } from "effect";
import { InputError } from "./errors";
import { loadBatchJsonInput } from "./json";

/** Normalize the two supported send forms before the canonical wire decode. */
export const mailSendInput = (input: {
  readonly input: string;
  readonly text?: string;
  readonly prompt: boolean;
  readonly fallback?: string;
  readonly retry?: string;
}) => Effect.gen(function* () {
  if (!input.prompt && (input.retry !== undefined || input.fallback !== undefined)) {
    return yield* Effect.fail(new InputError({
      message: "--retry and --fallback require --prompt", path: "prompt",
    }));
  }
  if (input.fallback !== undefined && input.fallback !== "notice") {
    return yield* Effect.fail(new InputError({
      message: "--fallback must be notice", path: "fallback",
    }));
  }
  if (input.text !== undefined && input.retry !== undefined) {
    return yield* Effect.fail(new InputError({
      message: "A prompt retry reuses the original body; omit text", path: "text",
    }));
  }
  if (input.text !== undefined || input.retry !== undefined) {
    return JSON.stringify({
      target: input.input,
      ...(input.text === undefined ? {} : { text: input.text }),
      ...(input.retry === undefined ? {} : { messageId: input.retry }),
      ...(input.fallback === undefined ? {} : { fallback: input.fallback }),
    });
  }
  if (input.fallback === undefined) return input.input;
  const items = yield* loadBatchJsonInput(input.input);
  const normalized = yield* Effect.forEach(items, (item) => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return Effect.fail(new InputError({ message: "Expected a mail object", path: "input" }));
    }
    if ("fallback" in item && item.fallback !== input.fallback) {
      return Effect.fail(new InputError({
        message: "JSON fallback conflicts with --fallback", path: "fallback",
      }));
    }
    return Effect.succeed({ ...item, fallback: input.fallback });
  });
  return JSON.stringify(normalized);
});
