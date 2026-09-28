import { Effect, Schema } from "effect";
import type { OffboardArgs } from "../../shared/work-control";
import { InputError } from "./errors";
import { decodeJsonText } from "./json";
import { readSource, sourceOf } from "./signal-input";

const OffboardPayload = Schema.Struct({
  notes: Schema.String,
  continuation: Schema.optionalKey(Schema.String),
}).annotate({ parseOptions: { onExcessProperty: "error" } });

/**
 * How `junto offboard <notes> [--continue <note>]` reads its input: markdown
 * inline, `@file`, `-` for stdin, or the JSON object
 * `{"notes": "...", "continuation": "..."}`. The continuation reads the same
 * ways; stdin feeds at most one of them.
 */
export const loadOffboardArgs = (input: string, continueInput?: string) =>
  Effect.gen(function* () {
    if (input.trim() === "") {
      return yield* Effect.fail(
        new InputError({
          message: "write your notes on this session",
          path: "input",
          hint: 'junto offboard "Shipped the parser; next is retry on 429s. Why it matters: ..."',
        }),
      );
    }
    const source = sourceOf(input);
    if (continueInput !== undefined && source.kind === "stdin" && sourceOf(continueInput).kind === "stdin") {
      return yield* Effect.fail(
        new InputError({
          message: "stdin can feed the notes or the continuation, not both",
          path: "continue",
          hint: "give one of them inline or as @file",
        }),
      );
    }
    const body = yield* readSource(source);
    // Markdown never opens with this object, so the JSON form is unambiguous.
    const json = /^\{\s*"notes"\s*:/.test(body.trim());
    const payload: OffboardArgs = json ? yield* decodeJsonText(OffboardPayload, body, source.kind) : { notes: body };
    if (continueInput === undefined) return payload;
    if (payload.continuation !== undefined) {
      return yield* Effect.fail(
        new InputError({
          message: "the continuation is given twice",
          path: "continue",
          hint: "use --continue or the JSON continuation field, not both",
        }),
      );
    }
    const next = sourceOf(continueInput);
    if (continueInput.trim() === "") {
      return yield* Effect.fail(
        new InputError({
          message: "--continue takes the note for your next session: what to pick up and why",
          path: "continue",
          hint: 'junto offboard "<notes>" --continue "Pick up the 429 retry in src/import/feed.ts; the nightly sync fails without it."',
        }),
      );
    }
    const args: OffboardArgs = { ...payload, continuation: yield* readSource(next) };
    return args;
  });
