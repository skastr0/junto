import { Effect, Result, Schema } from "effect";
import { OverseerSecretPutInput } from "../../shared/overseer-control";
import { InputError } from "./errors";
import { decodeJsonText } from "./json";

/**
 * How `junto overseer secret put [json]` reads its two inputs.
 *
 * The JSON argument names the secret (`{}` or `{secretId}`) and comes inline
 * or from `@file`. The value comes from stdin and from nowhere else: an
 * argument is visible to every process on the machine and stays in shell
 * history, a pipe is not and does not.
 *
 * No error built here repeats anything it was given. A caller who put the
 * value in the wrong place must not find it again in the output.
 */
export type SecretStdin = {
  readonly isTTY: boolean;
  readonly text: () => Promise<string>;
};

const HINT = "printf %s \"$VALUE\" | junto overseer secret put '{}'";

const refuse = (message: string, path: string): InputError =>
  new InputError({ message, path, hint: HINT });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Decode the JSON argument. `inline` is the argument as typed, or absent. */
export const decodeSecretPutInput = (
  inline: string | undefined,
  readFile: (path: string) => Effect.Effect<string, InputError>,
): Effect.Effect<OverseerSecretPutInput, InputError> =>
  Effect.gen(function* () {
    const raw = inline === undefined || inline.trim().length === 0 ? "{}" : inline.trim();
    if (raw === "-" || raw === "@-") {
      return yield* Effect.fail(
        refuse("stdin carries the secret value; give the JSON argument inline or as @file", "input"),
      );
    }
    const text = raw.startsWith("@") ? yield* readFile(raw.slice(1)) : raw;
    const value = yield* decodeJsonText(Schema.Unknown, text, "input").pipe(
      // A JSON parse error quotes the text it choked on.
      Effect.mapError(() => refuse("the argument is not valid JSON", "input")),
    );
    if (isRecord(value) && Object.prototype.hasOwnProperty.call(value, "value")) {
      return yield* Effect.fail(
        refuse("the secret value is read from stdin only, never from the argument", "value"),
      );
    }
    const decoded = Schema.decodeUnknownResult(OverseerSecretPutInput, {
      onExcessProperty: "error",
    })(value);
    if (Result.isFailure(decoded)) {
      return yield* Effect.fail(
        refuse("the argument is {} or {secretId}, and nothing else", "input"),
      );
    }
    return decoded.success;
  });

/** Exactly one trailing newline is the shell's, not the secret's. */
export const stripOneTrailingNewline = (text: string): string =>
  text.endsWith("\n") ? text.slice(0, -1) : text;

/** Read the value from stdin. A terminal is refused: it would echo the typing. */
export const readSecretValue = (
  stdin: SecretStdin,
): Effect.Effect<string, InputError> =>
  Effect.gen(function* () {
    if (stdin.isTTY) {
      return yield* Effect.fail(
        refuse("the secret value is read from stdin; pipe it in, a terminal is refused", "stdin"),
      );
    }
    const text = yield* Effect.tryPromise({
      try: () => stdin.text(),
      catch: () => refuse("stdin could not be read", "stdin"),
    });
    const value = stripOneTrailingNewline(text);
    if (value.length === 0) {
      return yield* Effect.fail(refuse("the secret value is empty", "stdin"));
    }
    return value;
  });
