/**
 * The JSON command shape of the owner scripts (build-machine, send-machine,
 * machine-exercise, machine-install-exercise): one JSON argument in, given
 * inline, as `@file` or as `-` for stdin, and one envelope out, success on
 * stdout and failure on stderr with exit code 1, as the junto CLI answers.
 */
import { readFile } from "node:fs/promises";
import { Effect, Schema } from "effect";

/** The argument is not the JSON its schema reads. */
export class InputError extends Schema.TaggedError<InputError>()("InputError", {
  message: Schema.String,
  path: Schema.optionalKey(Schema.String),
  hint: Schema.optionalKey(Schema.String),
}) {}

const decodeJsonText = <S extends Schema.Top>(schema: S, text: string, source: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema), { onExcessProperty: "error" })(text).pipe(
    Effect.mapError((error) => new InputError({ message: error.message, path: source, hint: "provide valid JSON (object or array)" })),
  );

const readText = (path: string, source: string) =>
  Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: (cause) => new InputError({ message: cause instanceof Error ? cause.message : "read failed", path: source }),
  });

/** The command's one JSON argument: inline, `@file`, or `-` (also `@-`) for stdin. */
export const loadJsonInput = <S extends Schema.Top>(schema: S, input: string) =>
  Effect.gen(function* () {
    const trimmed = input.trim();
    if (trimmed.length === 0) return yield* new InputError({ message: "JSON input is empty", path: "inline" });
    if (trimmed === "-" || trimmed === "@-") return yield* decodeJsonText(schema, yield* readText("/dev/stdin", "stdin"), "stdin");
    if (trimmed.startsWith("@")) {
      const filePath = trimmed.slice(1);
      if (filePath.length === 0) return yield* new InputError({ message: "@file input is missing a file path", path: "@" });
      return yield* decodeJsonText(schema, yield* readText(filePath, filePath), filePath);
    }
    return yield* decodeJsonText(schema, trimmed, "inline");
  });

type ErrorBody = { readonly type: string; readonly message: string; readonly details?: unknown };

/** A tagged error's own fields become its details; any other error is its name and message. */
const errorBody = (error: unknown): ErrorBody => {
  if (error instanceof Error && "_tag" in error && typeof error._tag === "string") {
    const fields = Object.fromEntries(Object.entries(error).filter(([key]) => !["_tag", "message", "name", "stack"].includes(key)));
    return { type: error._tag, message: error.message, ...(Object.keys(fields).length > 0 ? { details: fields } : {}) };
  }
  if (error instanceof Error) return { type: error.name || "Error", message: error.message };
  return { type: "Error", message: String(error) };
};

/** Runs the command and prints its envelope: success on stdout, failure on stderr with exit code 1. */
export const executeJsonCommand = <A, E, R>(command: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.flatMap((data) => Effect.sync(() => void process.stdout.write(`${JSON.stringify({ ok: true, command, data })}\n`))),
    Effect.catch((error) =>
      Effect.sync(() => {
        process.exitCode = 1;
        process.stderr.write(`${JSON.stringify({ ok: false, command, error: errorBody(error) })}\n`);
      }),
    ),
  );

/**
 * A command whose result is printed whole even when it carries bad news: the
 * result is the success envelope, and `unmet` decides the exit code, so one
 * refused item never hides the answer for the others.
 */
export const executeJsonCommandWithVerdict = <A, E, R>(command: string, effect: Effect.Effect<A, E, R>, unmet: (data: A) => boolean) =>
  executeJsonCommand(command, effect.pipe(Effect.tap((data) => Effect.sync(() => { if (unmet(data)) process.exitCode = 1; }))));
