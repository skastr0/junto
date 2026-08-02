import { readFile } from "node:fs/promises";
import { Effect, Schema } from "effect";
import { InputError } from "./errors";

const decodeJsonWithSchema = <S extends Schema.Top>(
  schema: S,
  text: string,
  source: string,
) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(
    Effect.mapError(
      (error) =>
        new InputError({
          message: error.message,
          path: source,
          hint: "provide valid JSON (object or array)",
        }),
    ),
  );

export const decodeJsonText = <S extends Schema.Top>(
  schema: S,
  text: string,
  source: string,
) => decodeJsonWithSchema(schema, text, source);

const readStdinText = Effect.tryPromise({
  try: () => new Response(Bun.stdin.stream()).text(),
  catch: (cause) =>
    new InputError({
      message: cause instanceof Error ? cause.message : "Failed to read stdin",
      path: "stdin",
    }),
});

export const loadJsonInput = <S extends Schema.Top>(schema: S, input: string) =>
  Effect.gen(function* () {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      return yield* Effect.fail(
        new InputError({ message: "JSON input is empty", path: "inline" }),
      );
    }
    if (trimmed === "-" || trimmed === "@-") {
      const stdin = yield* readStdinText;
      return yield* decodeJsonText(schema, stdin, "stdin");
    }
    if (trimmed.startsWith("@")) {
      const filePath = trimmed.slice(1);
      if (filePath.length === 0) {
        return yield* Effect.fail(
          new InputError({ message: "@file input is missing a file path", path: "@" }),
        );
      }
      const contents = yield* Effect.tryPromise({
        try: () => readFile(filePath, "utf8"),
        catch: (cause) =>
          new InputError({
            message: cause instanceof Error ? cause.message : "read failed",
            path: filePath,
          }),
      });
      return yield* decodeJsonText(schema, contents, filePath);
    }
    return yield* decodeJsonText(schema, trimmed, "inline");
  });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const loadBatchJsonInput = (input: string) =>
  loadJsonInput(Schema.Unknown, input).pipe(
    Effect.flatMap((value) => {
      if (Array.isArray(value)) return Effect.succeed(value);
      if (isRecord(value)) return Effect.succeed([value]);
      return Effect.fail(
        new InputError({
          message: "batch input must be a JSON object or array of objects",
          path: "input",
        }),
      );
    }),
  );
